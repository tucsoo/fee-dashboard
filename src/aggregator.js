// Axiom Fee Dashboard — Data Aggregator
// Aggregates raw fee transactions into daily summaries

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, '..', 'data', 'cache.json');

/**
 * Group fee transactions by day (UTC) and compute totals
 */
export function aggregateByDay(feeTransactions) {
    const dailyMap = {};

    for (const tx of feeTransactions) {
        if (!tx.timestamp) continue;

        const dateKey = tx.timestamp.toISOString().split('T')[0]; // YYYY-MM-DD

        if (!dailyMap[dateKey]) {
            dailyMap[dateKey] = {
                date: dateKey,
                totalSOL: 0,
                txCount: 0,
                uniqueTraders: new Set(),
                tokenFees: {},
                transactions: [],
            };
        }

        const day = dailyMap[dateKey];
        day.totalSOL += tx.solReceived;
        day.txCount += 1;
        day.uniqueTraders.add(tx.sender);

        // Track token fees
        for (const tt of tx.tokenTransfers) {
            if (!day.tokenFees[tt.mint]) {
                day.tokenFees[tt.mint] = 0;
            }
            day.tokenFees[tt.mint] += tt.amount;
        }

        day.transactions.push(tx);
    }

    // Convert Sets to counts for serialization
    const result = Object.values(dailyMap)
        .map((day) => ({
            ...day,
            uniqueTraders: day.uniqueTraders.size,
            traderList: [...day.uniqueTraders],
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

    return result;
}

/**
 * Group fee transactions by trader wallet
 */
export function aggregateByTrader(feeTransactions) {
    const traderMap = {};

    for (const tx of feeTransactions) {
        const trader = tx.sender;
        if (!traderMap[trader]) {
            traderMap[trader] = {
                wallet: trader,
                totalSOL: 0,
                txCount: 0,
                dailyVolumes: {},
                tokenVolumes: {},
                firstSeen: tx.timestamp,
                lastSeen: tx.timestamp,
            };
        }

        const t = traderMap[trader];
        t.totalSOL += tx.solReceived;
        t.txCount += 1;

        if (tx.timestamp < t.firstSeen) t.firstSeen = tx.timestamp;
        if (tx.timestamp > t.lastSeen) t.lastSeen = tx.timestamp;

        // Daily volume tracking
        const dateKey = tx.timestamp.toISOString().split('T')[0];
        if (!t.dailyVolumes[dateKey]) {
            t.dailyVolumes[dateKey] = 0;
        }
        t.dailyVolumes[dateKey] += tx.solReceived;

        // Token volume tracking
        for (const tt of tx.tokenTransfers) {
            if (!t.tokenVolumes[tt.mint]) {
                t.tokenVolumes[tt.mint] = 0;
            }
            t.tokenVolumes[tt.mint] += tt.amount;
        }
    }

    return Object.values(traderMap).sort((a, b) => b.totalSOL - a.totalSOL);
}

/**
 * Compute summary statistics
 */
export function computeSummary(dailyData, allTransactions) {
    const now = new Date();
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const totalSOL = dailyData.reduce((sum, d) => sum + d.totalSOL, 0);
    const totalTx = dailyData.reduce((sum, d) => sum + d.txCount, 0);

    const last24h = allTransactions
        .filter((tx) => tx.timestamp >= oneDayAgo)
        .reduce((sum, tx) => sum + tx.solReceived, 0);

    const last7d = allTransactions
        .filter((tx) => tx.timestamp >= sevenDaysAgo)
        .reduce((sum, tx) => sum + tx.solReceived, 0);

    const last30d = allTransactions
        .filter((tx) => tx.timestamp >= thirtyDaysAgo)
        .reduce((sum, tx) => sum + tx.solReceived, 0);

    const uniqueTraders = new Set(allTransactions.map((tx) => tx.sender)).size;

    return {
        totalSOL: round(totalSOL),
        totalTransactions: totalTx,
        uniqueTraders,
        last24hSOL: round(last24h),
        last7dSOL: round(last7d),
        last30dSOL: round(last30d),
        daysTracked: dailyData.length,
        lastUpdated: new Date().toISOString(),
    };
}

/**
 * Save aggregated data to cache
 */
export function saveCache(data) {
    const cacheDir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    const serializable = {
        ...data,
        cachedAt: new Date().toISOString(),
        // Convert Date objects to ISO strings
        transactions: data.transactions?.map((tx) => ({
            ...tx,
            timestamp: tx.timestamp?.toISOString(),
        })),
        traders: data.traders?.map((t) => ({
            ...t,
            firstSeen: t.firstSeen?.toISOString(),
            lastSeen: t.lastSeen?.toISOString(),
        })),
    };

    fs.writeFileSync(CACHE_FILE, JSON.stringify(serializable, null, 2));
    console.log(`💾 Cache saved to ${CACHE_FILE}`);
}

/**
 * Load cached data
 */
export function loadCache() {
    if (!fs.existsSync(CACHE_FILE)) return null;

    try {
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        // Rehydrate Date objects
        if (raw.transactions) {
            raw.transactions = raw.transactions.map((tx) => ({
                ...tx,
                timestamp: tx.timestamp ? new Date(tx.timestamp) : null,
            }));
        }
        if (raw.traders) {
            raw.traders = raw.traders.map((t) => ({
                ...t,
                firstSeen: t.firstSeen ? new Date(t.firstSeen) : null,
                lastSeen: t.lastSeen ? new Date(t.lastSeen) : null,
            }));
        }
        return raw;
    } catch {
        return null;
    }
}

/**
 * Check if cache is still valid
 */
export function isCacheValid(cacheTTL) {
    const cache = loadCache();
    if (!cache || !cache.cachedAt) return false;
    const age = Date.now() - new Date(cache.cachedAt).getTime();
    return age < cacheTTL;
}

function round(num, decimals = 4) {
    return Math.round(num * 10 ** decimals) / 10 ** decimals;
}
