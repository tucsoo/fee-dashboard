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

const CHUNK_SIZE = 50; // number of transactions to fetch per RPC call
const POLL_INTERVAL = 5000; // 5 seconds — fast polling to keep up with volume
const VAULT_CONCURRENCY = 5; // how many vaults to sync in parallel

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
 * Syncs a single vault — FORWARD ONLY, parallel address queries.
 */
async function syncVault(vault, vaults, terminalName) {
    try {
        const state = getLastSyncState(vault) || {};
        const lastSig = state.last_signature;
        
        const queryAddresses = getVaultQueryAddresses(vault);
        
        if (!lastSig) {
            // FIRST RUN: just save marker
            try {
                const sigs = await rpcPool.getSignaturesForAddress(queryAddresses[0], { limit: 1 });
                if (sigs && sigs.length > 0) {
                    updateSyncState(vault, sigs[0].signature, sigs[0].blockTime, 0);
                    console.log(`[Indexer] ${terminalName} (${vault.slice(0, 4)}...): marker set.`);
                }
            } catch (e) {
                console.warn(`[Indexer] Failed to set marker for ${vault.slice(0, 4)}...: ${e.message}`);
            }
            return;
        }
        
        // Fetch new sigs from ALL addresses in PARALLEL
        const allSigArrays = await Promise.all(
            queryAddresses.map(async (addr) => {
                const addrSigs = [];
                let beforeSig = undefined;
                const MAX_PAGES = 5;
                
                for (let page = 0; page < MAX_PAGES; page++) {
                    const options = { limit: 1000, until: lastSig };
                    if (beforeSig) options.before = beforeSig;
                    
                    let batch;
                    try {
                        batch = await rpcPool.getSignaturesForAddress(addr, options);
                    } catch (e) {
                        break;
                    }
                    
                    if (!batch || batch.length === 0) break;
                    addrSigs.push(...batch);
                    
                    if (batch.length < 1000) break;
                    beforeSig = batch[batch.length - 1].signature;
                }
                
                return addrSigs;
            })
        );
        
        // Merge and de-duplicate
        const sigMap = new Map();
        for (const sigs of allSigArrays) {
            for (const s of sigs) {
                if (!sigMap.has(s.signature)) sigMap.set(s.signature, s);
            }
        }
        const newSignatures = [...sigMap.values()].sort((a, b) => b.blockTime - a.blockTime);
        
        if (newSignatures.length === 0) return;
        
        const inserted = await processSignatures(newSignatures, vaults, terminalName);
        
        const mostRecentSig = newSignatures[0];
        updateSyncState(vault, mostRecentSig.signature, mostRecentSig.blockTime, inserted);
        
        if (inserted > 0) {
            console.log(`[Indexer] ${terminalName} (${vault.slice(0, 4)}...): +${inserted} fees from ${newSignatures.length} txs.`);
        }
    } catch (e) {
        console.error(`[Indexer] Sync error on ${terminalName} vault ${vault.slice(0, 4)}...:`, e.message);
    }
}

/**
 * Run async tasks with concurrency limit
 */
async function runWithConcurrency(tasks, limit) {
    const results = [];
    const executing = new Set();
    
    for (const task of tasks) {
        const p = task().then(r => { executing.delete(p); return r; });
        executing.add(p);
        results.push(p);
        
        if (executing.size >= limit) {
            await Promise.race(executing);
        }
    }
    
    return Promise.all(results);
}

/**
 * Main indexer loop — parallel vault processing
 */
export async function startIndexer() {
    console.log('[Indexer] Starting parallel indexer with RPC Rotation...');
    console.log(`[Indexer] Config: CHUNK_SIZE=${CHUNK_SIZE}, POLL_INTERVAL=${POLL_INTERVAL}ms, VAULT_CONCURRENCY=${VAULT_CONCURRENCY}`);
    
    getDB();
    
    while (true) {
        await updateSolPrice();
        
        // Build a flat list of all vault sync tasks
        const tasks = [];
        for (const [terminalName, vaults] of Object.entries(TERMINAL_VAULTS)) {
            for (const vault of vaults) {
                tasks.push(() => syncVault(vault, vaults, terminalName));
            }
        }
        
        // Run all vault syncs with concurrency limit
        await runWithConcurrency(tasks, VAULT_CONCURRENCY);
        
        // Wait before next poll
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
}

