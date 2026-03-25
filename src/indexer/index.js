import { rpcPool } from '../rpc/pool.js';
import { PublicKey } from '@solana/web3.js';
import { TERMINAL_VAULTS } from '../config.js';
import { getDB, getLastSyncState, updateSyncState, storeFeeTransactions } from '../database.js';

// Well-known SPL Token Program and Associated Token Program
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Key stablecoin mints to derive ATAs for
const FEE_TOKEN_MINTS = [
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
];

/**
 * Derive ATA (Associated Token Account) address for a given wallet + mint
 */
function getATA(walletPubkey, mintPubkey) {
    const [ata] = PublicKey.findProgramAddressSync(
        [walletPubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return ata.toString();
}

/**
 * Get all addresses to query for a vault: the base address + USDC/USDT ATAs
 */
function getVaultQueryAddresses(vaultAddress) {
    const vaultPubkey = new PublicKey(vaultAddress);
    const addresses = [vaultAddress]; // always include base
    for (const mint of FEE_TOKEN_MINTS) {
        try {
            const ata = getATA(vaultPubkey, new PublicKey(mint));
            addresses.push(ata);
        } catch (e) { /* skip if derivation fails */ }
    }
    return addresses;
}

const CHUNK_SIZE = 25; // number of transactions to fetch per RPC call
const POLL_INTERVAL = 15000; // 15 seconds

let currentSolPrice = 175; // Fallback
let lastPriceFetch = 0;

async function updateSolPrice() {
    if (Date.now() - lastPriceFetch > 60000) {
        try {
            // using native global fetch
            const res = await fetch('https://price.jup.ag/v6/price?ids=SOL');
            const data = await res.json();
            if (data && data.data && data.data.SOL && data.data.SOL.price) {
                currentSolPrice = data.data.SOL.price;
                lastPriceFetch = Date.now();
            }
        } catch(e) {}
    }
}

/**
 * Parses a single transaction to extract SOL and parsed SPL (USDC/USDT) transfers to the given feeVaults.
 * Only tracks transfers moving specifically into the fee vaults.
 */
function parseTransactionForFees(tx, feeVaults) {
    if (!tx || !tx.meta || tx.meta.err) return null;
    
    // In getParsedTransactions, accountKeys is an array of objects: { pubkey: PublicKey, signer, writable, ... }
    const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toString());
    const preBalances = tx.meta.preBalances;
    const postBalances = tx.meta.postBalances;
    
    let totalVaultGain = 0;
    let vaultGains = new Map();
    feeVaults.forEach(v => vaultGains.set(v, 0));
    
    // Native SOL tracking
    feeVaults.forEach(vault => {
        const vaultIndex = accountKeys.indexOf(vault);
        if (vaultIndex !== -1) {
            const pre = preBalances[vaultIndex];
            const post = postBalances[vaultIndex];
            const diff = (post - pre) / 1e9; // lamports to SOL
            if (diff > 0) {
                totalVaultGain += diff;
                vaultGains.set(vault, vaultGains.get(vault) + diff);
            }
        }
    });

    // Token (USDC, USDT, wSOL) tracking
    const preTokens = tx.meta.preTokenBalances || [];
    const postTokens = tx.meta.postTokenBalances || [];
    
    feeVaults.forEach(vault => {
        const postVaultTokens = postTokens.filter(t => t.owner === vault);
        for (const post of postVaultTokens) {
            const pre = preTokens.find(t => t.owner === vault && t.mint === post.mint);
            const preAmount = pre ? pre.uiTokenAmount.uiAmount : 0;
            const postAmount = post.uiTokenAmount.uiAmount || 0;
            
            if (postAmount > preAmount) {
                const diff = postAmount - preAmount;
                let valueInSol = 0;
                // USDC or USDT
                if (post.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' || 
                    post.mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') {
                    valueInSol = (diff / currentSolPrice);
                } 
                // Wrapped SOL
                else if (post.mint === 'So11111111111111111111111111111111111111112') {
                    valueInSol = diff;
                }
                
                if (valueInSol > 0) {
                    totalVaultGain += valueInSol;
                    vaultGains.set(vault, vaultGains.get(vault) + valueInSol);
                }
            }
        }
    });

    if (totalVaultGain <= 0) return null;
    
    // Identify which vault actually received the fee
    let receivingVault = feeVaults[0];
    let maxGain = -1;
    for (const [vault, gain] of vaultGains.entries()) {
        if (gain > maxGain) {
            maxGain = gain;
            receivingVault = vault;
        }
    }

    // Find the actual user signer (not the fee payer / relayer)
    // accountKeys in parsed tx have: { pubkey, signer, writable, source }
    const signerKeys = tx.transaction.message.accountKeys
        .filter(k => k.signer)
        .map(k => k.pubkey.toString());
    
    // Exclude fee vaults and known system/program addresses from signers
    const systemPrefixes = ['11111111', 'Token', 'Compute', 'Sysvar', 'AToken'];
    const userSigners = signerKeys.filter(key => 
        !feeVaults.includes(key) && 
        !systemPrefixes.some(prefix => key.startsWith(prefix))
    );
    
    const feePayer = accountKeys[0];
    let sender = userSigners.find(s => s !== feePayer) || null;
    
    // Fallback: if no non-fee-payer signer found (e.g. UniversalX relayer-only txs),
    // use token balance changes to identify the user.
    // Strategy: the user is the account with the most token balance changes 
    // (both gains and losses across different mints), as they are the one doing the swap.
    if (!sender || sender === feePayer) {
        // Known DEX programs, AMM pool authorities, and routing addresses to exclude
        const KNOWN_DEX_ADDRESSES = new Set([
            // Raydium
            '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM V4
            'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
            'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
            '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h', // Raydium Authority V4
            'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', // Raydium Fee/Authority
            // Orca / Whirlpool
            'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
            '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca Swap V2
            'DjDsi34mSB66p2nhBL6YvhbcLtZbkGfNybFeLDjJqxJW', // Orca Token Swap
            // Jupiter
            'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter V6
            'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',  // Jupiter V4
            'JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uN9oJ',  // Jupiter V2
            'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu',  // Jupiter Limit Order
            // Meteora
            'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora DLMM
            'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // Meteora LB CLMM
            '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi', // Meteora Pools
            // Pump.fun
            '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun
            'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp18T', // Pump.fun Fee
            // Phoenix
            'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',  // Phoenix DEX
            // Lifinity
            'EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S', // Lifinity Swap V2
            '2wT8Yq49kHgDzXuPxZSaeLeswnfWEjotFCMJA6ewGFGn', // Lifinity Swap V1
            // OpenBook / Serum
            'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',  // OpenBook V1
            'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EQDQoy',  // OpenBook V2
            // FluxBeam
            'FLUXubRmkEi2q6K3Y5o2aQhQ2q3bTfTMZrGEh1QLai9e', // FluxBeam
            // Common routing/intermediary
            'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC', // Common routing account
        ]);
        
        const excludeOwners = new Set([feePayer, ...feeVaults, ...KNOWN_DEX_ADDRESSES]);
        const stableMints = new Set([
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
            'So11111111111111111111111111111111111111112',     // wSOL
        ]);
        
        const postTokens = tx.meta.postTokenBalances || [];
        const preTokens = tx.meta.preTokenBalances || [];
        
        // Count distinct token interactions per owner + track stablecoin involvement
        const ownerActivity = new Map(); // owner -> { changes, touchedStable }
        
        for (const post of postTokens) {
            if (!post.owner || excludeOwners.has(post.owner)) continue;
            const pre = preTokens.find(p => p.owner === post.owner && p.mint === post.mint);
            const preAmt = pre ? (pre.uiTokenAmount.uiAmount || 0) : 0;
            const postAmt = post.uiTokenAmount.uiAmount || 0;
            const diff = postAmt - preAmt;
            
            if (Math.abs(diff) > 0) {
                const info = ownerActivity.get(post.owner) || { changes: 0, touchedStable: false };
                info.changes++;
                if (stableMints.has(post.mint)) info.touchedStable = true;
                ownerActivity.set(post.owner, info);
            }
        }
        
        // Also check native SOL balance changes
        const preBalances = tx.meta.preBalances;
        const postBalances = tx.meta.postBalances;
        for (let i = 0; i < tx.transaction.message.accountKeys.length; i++) {
            const key = tx.transaction.message.accountKeys[i];
            const addr = key.pubkey.toString();
            if (excludeOwners.has(addr)) continue;
            const solDiff = (postBalances[i] - preBalances[i]) / 1e9;
            if (Math.abs(solDiff) > 0.001) {
                const info = ownerActivity.get(addr) || { changes: 0, touchedStable: false };
                info.changes++;
                info.touchedStable = true; // SOL is a base asset like stablecoins
                ownerActivity.set(addr, info);
            }
        }
        
        // Pick winner: most activity, with stablecoin involvement as tiebreaker
        // (real users always interact with USDC/SOL in swaps)
        let bestCandidate = null;
        let bestChanges = 0;
        let bestTouchedStable = false;
        for (const [owner, info] of ownerActivity) {
            const better = info.changes > bestChanges || 
                (info.changes === bestChanges && info.touchedStable && !bestTouchedStable);
            if (better) {
                bestChanges = info.changes;
                bestCandidate = owner;
                bestTouchedStable = info.touchedStable;
            }
        }
        
        sender = bestCandidate || feePayer;
    }
    
    return {
        signature: tx.transaction.signatures[0],
        timestamp: tx.blockTime, // this is in seconds
        sender,
        solReceived: totalVaultGain,
        feeVault: receivingVault
    };
}

/**
 * Process a batch of signatures, fetching full parsed tx data
 */
async function processSignatures(signaturesToProcess, feeVaults, terminalName) {
    if (signaturesToProcess.length === 0) return 0;
    
    const sigStrings = signaturesToProcess.map(s => s.signature);
    let successfulInserts = 0;

    // chunk requests across RPC rotation
    for (let i = 0; i < sigStrings.length; i += CHUNK_SIZE) {
        const chunk = sigStrings.slice(i, i + CHUNK_SIZE);
        try {
            const txs = await rpcPool.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0 });
            
            const parsedData = [];
            for (let j = 0; j < txs.length; j++) {
                const tx = txs[j];
                const sigInfo = signaturesToProcess[i + j];
                
                const feeData = parseTransactionForFees(tx, feeVaults);
                if (feeData) {
                    parsedData.push({
                        ...feeData,
                        feeVault: feeData.feeVault, // use the exact vault that received the fee
                        terminal: terminalName
                    });
                }
            }
            
            if (parsedData.length > 0) {
                successfulInserts += storeFeeTransactions(parsedData);
            }
        } catch (e) {
            console.error(`[Indexer] Error fetching chunk for ${terminalName}:`, e.message);
            // On hard fail even after rotation, we skip this chunk for now. 
            // In a robust system, we would enqueue it.
        }
    }
    
    return successfulInserts;
}

/**
 * Fetch ALL signatures for a single address with full pagination.
 * Uses `before` cursor to page backwards through history until we hit `untilSig` or run out.
 */
async function fetchAllSignatures(address, untilSig = null) {
    const PAGE_SIZE = 1000; // RPC max per call
    const MAX_PAGES = 50;   // safety limit: 50 * 1000 = 50k sigs max per sync
    const allSigs = [];
    let beforeSig = undefined;
    
    for (let page = 0; page < MAX_PAGES; page++) {
        const options = { limit: PAGE_SIZE };
        if (beforeSig) options.before = beforeSig;
        if (untilSig) options.until = untilSig;
        
        let batch;
        try {
            batch = await rpcPool.getSignaturesForAddress(address, options);
        } catch (e) {
            console.warn(`[Indexer] Failed to fetch sigs for ${address.slice(0, 8)}...: ${e.message}`);
            break;
        }
        
        if (!batch || batch.length === 0) break;
        
        allSigs.push(...batch);
        
        // If we got fewer than PAGE_SIZE, we've reached the end
        if (batch.length < PAGE_SIZE) break;
        
        // Set cursor for next page (oldest sig in this batch)
        beforeSig = batch[batch.length - 1].signature;
        
        // Small delay between pages to not hammer RPC
        await new Promise(r => setTimeout(r, 200));
    }
    
    return allSigs;
}

/**
 * Syncs a single terminal (all its vaults)
 */
async function syncTerminal(terminalName, vaults) {
    if (!vaults || vaults.length === 0) return;

    for (const vault of vaults) {
        try {
            const state = getLastSyncState(vault) || {};
            const lastSig = state.last_signature;
            
            // Query signatures from the base vault AND its token ATAs (USDC, USDT)
            const queryAddresses = getVaultQueryAddresses(vault);
            
            // Fetch ALL signatures with full pagination for each address
            const allSigArrays = await Promise.all(
                queryAddresses.map(addr => 
                    fetchAllSignatures(addr, lastSig)
                )
            );
            
            // Merge and de-duplicate signatures by signature string
            const sigMap = new Map();
            for (const sigs of allSigArrays) {
                for (const s of sigs) {
                    if (!sigMap.has(s.signature)) {
                        sigMap.set(s.signature, s);
                    }
                }
            }
            const newSignatures = [...sigMap.values()].sort((a, b) => b.blockTime - a.blockTime);
            
            if (newSignatures.length === 0) continue;
            
            const inserted = await processSignatures(newSignatures, vaults, terminalName);
            
            // Update state with the most recent signature (which is the first in the array)
            const mostRecentSig = newSignatures[0];
            updateSyncState(
                vault,
                mostRecentSig.signature,
                mostRecentSig.blockTime,
                inserted
            );
            
            if (inserted > 0 || newSignatures.length > 100) {
                console.log(`[Indexer] ${terminalName} (${vault.slice(0, 4)}...): parsed ${inserted}/${newSignatures.length} relevant transfers.`);
            }
            
        } catch (e) {
            console.error(`[Indexer] Sync error on ${terminalName} vault ${vault}:`, e.message);
        }
    }
}

/**
 * Main indexer loop
 */
export async function startIndexer() {
    console.log('[Indexer] Starting custom background indexer with RPC Rotation...');
    
    // Ensure DB is initialized
    getDB();
    
    while (true) {
        await updateSolPrice();
        
        for (const [terminalName, vaults] of Object.entries(TERMINAL_VAULTS)) {
            await syncTerminal(terminalName, vaults);
            // Small pause between terminals
            await new Promise(r => setTimeout(r, 1000));
        }
        
        // Wait before next global poll
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
}
