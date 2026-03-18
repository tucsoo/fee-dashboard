// Axiom Fee Dashboard — Anomaly Detection Engine
// Detects fake volume patterns: stablecoin wash trading & consistent daily volume

import { ANOMALY_CONFIG, STABLECOIN_MINTS } from './config.js';

/**
 * Pattern 1: Stablecoin Wash Trading Detection
 * Wallets that mostly trade stablecoins back and forth
 * @returns score 0-1 (1 = definitely wash trading)
 */
function scoreStablecoinWashTrading(trader) {
    const tokenVolumes = trader.tokenVolumes || {};
    const mints = Object.keys(tokenVolumes);

    if (mints.length === 0) {
        // No token transfers — only SOL fees, can't determine from tokens alone
        return 0;
    }

    let stablecoinVolume = 0;
    let totalTokenVolume = 0;

    for (const [mint, volume] of Object.entries(tokenVolumes)) {
        totalTokenVolume += volume;
        if (STABLECOIN_MINTS[mint]) {
            stablecoinVolume += volume;
        }
    }

    if (totalTokenVolume === 0) return 0;

    const ratio = stablecoinVolume / totalTokenVolume;

    // Smooth scoring: ramp up from 0.5 to threshold
    const { stablecoinVolumeRatioThreshold } = ANOMALY_CONFIG;
    if (ratio >= stablecoinVolumeRatioThreshold) return 1;
    if (ratio >= stablecoinVolumeRatioThreshold * 0.6) {
        // Partial score for borderline cases
        return (ratio - stablecoinVolumeRatioThreshold * 0.6) /
            (stablecoinVolumeRatioThreshold * 0.4);
    }
    return 0;
}

/**
 * Pattern 2: Consistent Daily Volume Detection
 * Bots that generate very consistent daily trading volume
 * Uses Coefficient of Variation (CV = stddev / mean)
 * Low CV = suspiciously consistent = likely bot
 * @returns score 0-1 (1 = definitely bot-like consistency)
 */
function scoreConsistentDailyVolume(trader) {
    const dailyVolumes = trader.dailyVolumes || {};
    const days = Object.keys(dailyVolumes);

    // Need minimum days of activity to evaluate
    if (days.length < ANOMALY_CONFIG.minDaysForCV) {
        return 0;
    }

    const volumes = Object.values(dailyVolumes);
    const mean = volumes.reduce((a, b) => a + b, 0) / volumes.length;

    if (mean === 0) return 0;

    const variance =
        volumes.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / volumes.length;
    const stdDev = Math.sqrt(variance);
    const cv = stdDev / mean;

    // Low CV = suspicious consistency
    const { cvThreshold } = ANOMALY_CONFIG;

    if (cv <= cvThreshold * 0.5) return 1;       // Extremely consistent
    if (cv <= cvThreshold) {
        // Linear interpolation: cv=0 → score=1, cv=threshold → score=0.5
        return 1 - (cv / cvThreshold) * 0.5;
    }
    if (cv <= cvThreshold * 2) {
        // Still somewhat suspicious
        return 0.5 * (1 - (cv - cvThreshold) / cvThreshold);
    }
    return 0;
}

/**
 * Combined anomaly scoring for a trader
 * @returns { anomalyScore, isAnomaly, patterns: { stablecoinWash, consistentVolume } }
 */
export function scoreTrader(trader) {
    const stablecoinScore = scoreStablecoinWashTrading(trader);
    const consistencyScore = scoreConsistentDailyVolume(trader);

    const { stablecoinWeight, consistencyWeight, anomalyScoreThreshold } =
        ANOMALY_CONFIG;

    // Weighted combination
    const anomalyScore =
        stablecoinScore * stablecoinWeight +
        consistencyScore * consistencyWeight;

    // Also check: if either pattern alone is very strong, flag it
    const isAnomaly =
        anomalyScore >= anomalyScoreThreshold ||
        stablecoinScore >= 0.9 ||
        consistencyScore >= 0.9;

    return {
        wallet: trader.wallet,
        anomalyScore: Math.round(anomalyScore * 1000) / 1000,
        isAnomaly,
        patterns: {
            stablecoinWash: {
                score: Math.round(stablecoinScore * 1000) / 1000,
                triggered: stablecoinScore >= 0.5,
            },
            consistentVolume: {
                score: Math.round(consistencyScore * 1000) / 1000,
                triggered: consistencyScore >= 0.5,
                cv: computeCV(trader),
                activeDays: Object.keys(trader.dailyVolumes || {}).length,
            },
        },
    };
}

/**
 * Run anomaly detection on all traders
 */
export function detectAnomalies(traders) {
    const results = traders.map((trader) => {
        const scoring = scoreTrader(trader);
        return {
            ...trader,
            ...scoring,
        };
    });

    const anomalous = results.filter((r) => r.isAnomaly);
    const clean = results.filter((r) => !r.isAnomaly);

    const anomalyStats = {
        totalTraders: results.length,
        anomalousTraders: anomalous.length,
        cleanTraders: clean.length,
        anomalyRate: results.length > 0
            ? Math.round((anomalous.length / results.length) * 10000) / 100
            : 0,
        totalAnomalousSOL: round(anomalous.reduce((s, t) => s + t.totalSOL, 0)),
        totalCleanSOL: round(clean.reduce((s, t) => s + t.totalSOL, 0)),
    };

    return {
        traders: results,
        anomalous,
        clean,
        stats: anomalyStats,
    };
}

/**
 * Filter daily aggregated data to exclude anomalous traders
 */
export function filterDailyByAnomalies(dailyData, anomalousWallets) {
    const anomalySet = new Set(anomalousWallets.map((a) => a.wallet));

    return dailyData.map((day) => {
        const cleanTxs = day.transactions.filter(
            (tx) => !anomalySet.has(tx.sender)
        );
        const anomalousTxs = day.transactions.filter(
            (tx) => anomalySet.has(tx.sender)
        );

        return {
            date: day.date,
            totalSOL: round(cleanTxs.reduce((s, tx) => s + tx.solReceived, 0)),
            totalSOLWithAnomalies: round(day.totalSOL),
            anomalousSOL: round(anomalousTxs.reduce((s, tx) => s + tx.solReceived, 0)),
            txCount: cleanTxs.length,
            txCountWithAnomalies: day.txCount,
            uniqueTraders: new Set(cleanTxs.map((tx) => tx.sender)).size,
        };
    });
}

// Helper: compute coefficient of variation
function computeCV(trader) {
    const dailyVolumes = trader.dailyVolumes || {};
    const volumes = Object.values(dailyVolumes);
    if (volumes.length < 2) return null;
    const mean = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    if (mean === 0) return null;
    const variance =
        volumes.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / volumes.length;
    return Math.round((Math.sqrt(variance) / mean) * 1000) / 1000;
}

function round(num, decimals = 4) {
    return Math.round(num * 10 ** decimals) / 10 ** decimals;
}
