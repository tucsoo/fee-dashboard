// Axiom Fee Dashboard — Solana Data Fetcher (with incremental DB sync)

import { Connection, PublicKey } from '@solana/web3.js';
import { getHeliusUrl, getNextHeliusKey, AXIOM_FEE_VAULTS, SERVER_CONFIG } from './config.js';
import { storeFeeTransactions, getLastSyncState, updateSyncState, signatureExists } from './database.js';

function getConnection() {
    return new Connection(getHeliusUrl(), 'confirmed');
}

async function withRetry(fn, maxRetries = 6) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isRateLimit = err.message?.includes('429') || err.message?.includes('rate limit');
            if (!isRateLimit || attempt === maxRetries - 1) throw err;
            const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
            console.log(`    ⏳ Rate limited, waiting ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
            await sleep(delay);
        }
    }
}

/**
 * Fetch NEW signatures for a vault (incremental — stop when we hit already-known sigs)
 */
async function getNewSignaturesForVault(vaultAddress) {
    const conn = getConnection();
    const pubkey = new PublicKey(vaultAddress);
    const syncState = getLastSyncState(vaultAddress);

    let allSignatures = [];
    let before = undefined;
    let keepFetching = true;
    let hitKnown = false;

    while (keepFetching) {
        const batch = await withRetry(() =>
            conn.getSignaturesForAddress(pubkey, {
                limit: 1000,
                before,
            })
        );

        if (batch.length === 0) break;

        for (const sig of batch) {
            if (!sig.err) {
                // Stop if we already have this signature in DB
                if (signatureExists(sig.signature)) {
                    hitKnown = true;
                    keepFetching = false;
                    break;
                }
                allSignatures.push(sig);
            }
        }

        before = batch[batch.length - 1].signature;

        if (batch.length < 1000) {
            keepFetching = false;
        }

        await sleep(50); // fast loop for pagination
    }

    return { signatures: allSignatures, hitKnown };
}

/**
 * Fetch ALL signatures for a vault within a time window (first-time sync)
 */
async function getAllSignaturesForVault(vaultAddress, daysBack = 30) {
    const conn = getConnection();
    const pubkey = new PublicKey(vaultAddress);
    const cutoffTime = Math.floor((Date.now() - daysBack * 86400000) / 1000);

    let allSignatures = [];
    let before = undefined;
    let keepFetching = true;

    while (keepFetching) {
        const batch = await withRetry(() =>
            conn.getSignaturesForAddress(pubkey, {
                limit: 1000,
                before,
            })
        );

        if (batch.length === 0) break;

        for (const sig of batch) {
            if (sig.blockTime && sig.blockTime < cutoffTime) {
                keepFetching = false;
                break;
            }
            if (!sig.err) {
                allSignatures.push(sig);
            }
        }

        before = batch[batch.length - 1].signature;

        if (batch.length < 1000) {
            keepFetching = false;
        }

        await sleep(50); // fast loop
    }

    return allSignatures;
}

/**
 * Use Helius Enhanced API to parse signatures in bulk
 */
async function parseTransactionsViaHelius(signatures) {
    const results = [];
    const batchSize = 50;

    for (let i = 0; i < signatures.length; i += batchSize) {
        const batch = signatures.slice(i, i + batchSize);
        const sigList = batch.map(s => s.signature);

        const parsed = await withRetry(async () => {
            const apiKey = getNextHeliusKey();
            if (!apiKey) return [];
            
            const url = `https://api.helius.xyz/v0/transactions?api-key=${apiKey}`;
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transactions: sigList }),
            });
            if (resp.status === 429) throw new Error('429 rate limit');
            if (!resp.ok) throw new Error(`Helius API error: ${resp.status}`);
            return resp.json();
        });

        if (Array.isArray(parsed)) results.push(...parsed);

        if (i + batchSize < signatures.length) {
            console.log(`    Parsed ${Math.min(i + batchSize, signatures.length)}/${signatures.length} txs...`);
            await sleep(50); // Fast batching with distributed keys
        }
    }

    return results;
}

/**
 * Extract fee info from Helius enhanced transaction
 */
function extractFeeFromEnhanced(tx, feeVaultAddress) {
    if (!tx || tx.transactionError) return null;

    const timestamp = tx.timestamp ? new Date(tx.timestamp * 1000) : null;
    
    // Find the actual user — look for signer that sent native SOL or tokens TO the fee vault
    // On terminal platforms, feePayer is often the platform relayer, not the user
    let sender = tx.feePayer || 'unknown';
    
    // Check nativeTransfers for who sent to the vault
    const nativeSender = (tx.nativeTransfers || []).find(
        nt => nt.toUserAccount === feeVaultAddress && nt.fromUserAccount !== feeVaultAddress
    );
    if (nativeSender) {
        sender = nativeSender.fromUserAccount;
    }
    
    // Check tokenTransfers for who sent to the vault
    if (sender === tx.feePayer) {
        const tokenSender = (tx.tokenTransfers || []).find(
            tt => tt.toUserAccount === feeVaultAddress && tt.fromUserAccount && tt.fromUserAccount !== feeVaultAddress
        );
        if (tokenSender) {
            sender = tokenSender.fromUserAccount;
        }
    }

    let solReceived = 0;
    // Helius nativeTransfers often ignores inner instructions.
    // accountData.nativeBalanceChange is the pure delta in lamports.
    for (const acc of (tx.accountData || [])) {
        if (acc.account === feeVaultAddress && acc.nativeBalanceChange > 0) {
            solReceived += acc.nativeBalanceChange / 1e9;
        }
    }

    const tokenTransfers = [];
    for (const tt of (tx.tokenTransfers || [])) {
        if (tt.toUserAccount === feeVaultAddress && tt.tokenAmount > 0) {
            tokenTransfers.push({ mint: tt.mint, amount: tt.tokenAmount, decimals: tt.decimals || 0 });
        }
    }

    if (solReceived <= 0 && tokenTransfers.length === 0) return null;

    return {
        signature: tx.signature,
        timestamp,
        sender,
        feeVault: feeVaultAddress,
        solReceived,
        tokenTransfers,
        type: tx.type || 'UNKNOWN',
        description: tx.description || '',
    };
}

/**
 * Sync a single vault — incremental if we have prior data, full otherwise
 */
export async function syncVault(vaultAddress) {
    const syncState = getLastSyncState(vaultAddress);
    const isFirstSync = !syncState;

    if (isFirstSync) {
        console.log(`  📡 ${vaultAddress.slice(0, 8)}... FIRST SYNC (last ${SERVER_CONFIG.daysToFetch} days)`);
        const signatures = await getAllSignaturesForVault(vaultAddress, SERVER_CONFIG.daysToFetch);
        console.log(`     Found ${signatures.length} signatures`);

        if (signatures.length === 0) {
            updateSyncState(vaultAddress, null, Math.floor(Date.now() / 1000), 0);
            return 0;
        }

        console.log(`     Parsing via Helius API...`);
        const enhanced = await parseTransactionsViaHelius(signatures);
        const parsed = enhanced.map(tx => extractFeeFromEnhanced(tx, vaultAddress)).filter(Boolean);

        const inserted = storeFeeTransactions(parsed);
        const lastSig = signatures[0].signature;
        const lastTs = signatures[0].blockTime || Math.floor(Date.now() / 1000);
        updateSyncState(vaultAddress, lastSig, lastTs, inserted);

        console.log(`     ✅ Stored ${inserted} new fee txs`);
        return inserted;
    } else {
        console.log(`  📡 ${vaultAddress.slice(0, 8)}... INCREMENTAL SYNC`);
        const { signatures, hitKnown } = await getNewSignaturesForVault(vaultAddress);

        if (signatures.length === 0) {
            console.log(`     ✅ Already up to date`);
            return 0;
        }

        console.log(`     Found ${signatures.length} new signatures`);
        console.log(`     Parsing via Helius API...`);
        const enhanced = await parseTransactionsViaHelius(signatures);
        const parsed = enhanced.map(tx => extractFeeFromEnhanced(tx, vaultAddress)).filter(Boolean);

        const inserted = storeFeeTransactions(parsed);
        const lastSig = signatures[0].signature;
        const lastTs = signatures[0].blockTime || Math.floor(Date.now() / 1000);
        updateSyncState(vaultAddress, lastSig, lastTs, inserted);

        console.log(`     ✅ Stored ${inserted} new fee txs`);
        return inserted;
    }
}

/**
 * Sync all vaults sequentially
 */
export async function syncAllVaults() {
    let totalNew = 0;

    console.log(`\n🔄 Syncing ${AXIOM_FEE_VAULTS.length} fee vaults...\n`);

    for (let i = 0; i < AXIOM_FEE_VAULTS.length; i++) {
        const vault = AXIOM_FEE_VAULTS[i];
        try {
            const newTxs = await syncVault(vault);
            totalNew += newTxs;
        } catch (err) {
            console.error(`  ⚠️ Failed ${vault.slice(0, 8)}: ${err.message}`);
        }

        console.log(`  📊 Progress: ${i + 1}/${AXIOM_FEE_VAULTS.length} vaults\n`);

        if (i < AXIOM_FEE_VAULTS.length - 1) {
            await sleep(200); // Tiny pause between vaults
        }
    }

    console.log(`✅ Sync complete. ${totalNew} new transactions stored.\n`);
    return totalNew;
}

// Legacy exports for compatibility
export const parseTransaction = () => null;
export const fetchAllVaultFees = syncAllVaults;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
