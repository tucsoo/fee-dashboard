// Terminal Stats — Express Server (Local Indexer Backend)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import { 
    getDailyFees,
    getTraders,
    getSummary,
    getDB,
    getTerminalRankings,
    getTraderVolatility,
    resetDB
} from './src/database.js';
import { SERVER_CONFIG, getVaultsForTerminal, ANOMALY_CONFIG, TERMINAL_VAULTS } from './src/config.js';
import { startIndexer } from './src/indexer/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Initialize DB and Indexer ──────────────────────────────────
getDB(); // Initialize sqlite
startIndexer().catch(e => console.error("Indexer crashed:", e));

// ─── API Routes ─────────────────────────────────────────────────

app.get('/api/fees/summary', (req, res) => {
    try {
        const terminal = req.query.terminal || 'axiom';
        const summary = getSummary(terminal);
        
        res.json({
            summary: {
                last24hSOL: summary.last24hSOL || 0,
                last7dSOL: summary.last7dSOL || 0,
                last30dSOL: summary.last30dSOL || 0,
                uniqueTraders24h: summary.uniqueTraders24h || 0,
                uniqueTraders7d: summary.uniqueTraders7d || 0,
                uniqueTraders30d: summary.uniqueTraders30d || 0,
                totalTxns: summary.totalTransactions || 0,
                uniqueTraders: summary.uniqueTraders || 0,
            },
            terminal,
        });
    } catch (error) {
        console.error('Summary error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/fees/daily', (req, res) => {
    try {
        const terminal = req.query.terminal || 'axiom';
        const daysBack = parseInt(req.query.days) || 30;
        
        const rows = getDailyFees(terminal, daysBack);
        
        const daily = rows.map(r => ({
            date: r.date,
            totalSOL: r.totalSOL || 0,
            txCount: r.txCount || 0,
            uniqueTraders: r.uniqueTraders || 0,
        }));

        res.json({ daily });
    } catch (error) {
        console.error('Daily error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Single endpoint for Overall tab — all terminals' daily data in one call
app.get('/api/fees/daily-all', (req, res) => {
    try {
        const daysBack = parseInt(req.query.days) || 30;
        const result = {};
        for (const [terminalName] of Object.entries(TERMINAL_VAULTS)) {
            const rows = getDailyFees(terminalName, daysBack);
            result[terminalName] = rows.map(r => ({
                date: r.date,
                totalSOL: r.totalSOL || 0,
                txCount: r.txCount || 0,
                uniqueTraders: r.uniqueTraders || 0,
            }));
        }
        res.json(result);
    } catch (error) {
        console.error('Daily-all error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/traders', (req, res) => {
    try {
        const terminal = req.query.terminal || 'axiom';
        const limit = parseInt(req.query.limit) || 30;
        const daysBack = parseInt(req.query.days) || 30;

        const rows = getTraders(terminal, daysBack, limit);
        
        // Get CV data for all wallets with enough history
        const cvData = getTraderVolatility(terminal, daysBack, ANOMALY_CONFIG.minDaysForCV);
        const cvMap = new Map(cvData.map(r => [r.sender, r]));
        
        const traders = rows.map((r, i) => ({
            rank: i + 1,
            wallet: r.wallet,
            totalSOL: Math.round((r.totalSOL || 0) * 10000) / 10000,
            txCount: r.txCount || 0,
            activeDays: r.activeDays || 0,
            firstSeen: r.firstSeen,
            lastSeen: r.lastSeen,
        }));

        const enriched = traders.map(t => {
            let anomalyScore = 0;
            let isAnomalous = false;
            const patterns = {};
            
            const cvInfo = cvMap.get(t.wallet);
            
            // Primary check: coefficient of variation of daily volume (Pavel's method)
            // Low CV = suspiciously consistent daily volume = likely wash trading
            if (cvInfo && cvInfo.cv < ANOMALY_CONFIG.cvThreshold) {
                // CV < 0.15 → score scales from 0.3 (borderline) to 1.0 (very suspicious)
                const cvScore = Math.min(1.0, (ANOMALY_CONFIG.cvThreshold - cvInfo.cv) / ANOMALY_CONFIG.cvThreshold);
                anomalyScore += cvScore * 0.7; // weight: 70% of total score
                patterns.volumeDeviation = { 
                    triggered: true, 
                    cv: Math.round(cvInfo.cv * 1000) / 1000,
                    avgDailySOL: Math.round(cvInfo.avg_daily_sol * 10000) / 10000,
                    stdDailySOL: Math.round(cvInfo.std_daily_sol * 10000) / 10000,
                    activeDays: cvInfo.active_days
                };
            }

            // Secondary: dust spam (many txs, almost no fees)
            if (t.txCount > 50 && t.totalSOL < 0.001) {
                anomalyScore += 0.3;
                patterns.dustSpam = { triggered: true, txCount: t.txCount, totalSOL: t.totalSOL };
            }

            anomalyScore = Math.min(anomalyScore, 1.0);
            isAnomalous = anomalyScore >= ANOMALY_CONFIG.anomalyScoreThreshold;

            return {
                ...t,
                anomalyScore: Math.round(anomalyScore * 100) / 100,
                isAnomalous,
                patterns,
                status: isAnomalous ? 'anomalous' : 'clean',
            };
        });

        res.json({ traders: enriched, total: enriched.length });
    } catch (error) {
        console.error('Traders error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/anomalies', (req, res) => {
    try {
        const terminal = req.query.terminal || 'axiom';
        const daysBack = parseInt(req.query.days) || 30;
        
        const rows = getTraders(terminal, daysBack, 200);
        
        // Get CV data — wallets with low CV are anomalous
        const cvData = getTraderVolatility(terminal, daysBack, ANOMALY_CONFIG.minDaysForCV);
        const cvMap = new Map(cvData.map(r => [r.sender, r]));

        const anomalous = [];
        for (const r of rows) {
            const t = {
                wallet: r.wallet,
                totalSOL: Math.round((r.totalSOL || 0) * 10000) / 10000,
                txCount: r.txCount || 0,
                activeDays: r.activeDays || 0,
            };

            let score = 0;
            const patterns = {};
            const cvInfo = cvMap.get(t.wallet);

            // Primary: low CV = wash trading
            if (cvInfo && cvInfo.cv < ANOMALY_CONFIG.cvThreshold) {
                const cvScore = Math.min(1.0, (ANOMALY_CONFIG.cvThreshold - cvInfo.cv) / ANOMALY_CONFIG.cvThreshold);
                score += cvScore * 0.7;
                patterns.volumeDeviation = {
                    triggered: true,
                    cv: Math.round(cvInfo.cv * 1000) / 1000,
                    avgDailySOL: Math.round(cvInfo.avg_daily_sol * 10000) / 10000,
                    activeDays: cvInfo.active_days
                };
            }

            // Secondary: dust spam
            if (t.txCount > 50 && t.totalSOL < 0.001) {
                score += 0.3;
                patterns.dustSpam = { triggered: true };
            }

            score = Math.min(score, 1.0);

            if (score >= ANOMALY_CONFIG.anomalyScoreThreshold) {
                anomalous.push({
                    ...t,
                    anomalyScore: Math.round(score * 100) / 100,
                    patterns,
                });
            }
        }

        const totalTraders = rows.length;
        const anomalyRate = totalTraders > 0
            ? Math.round((anomalous.length / totalTraders) * 1000) / 10
            : 0;

        res.json({
            stats: {
                totalTraders,
                anomalousTraders: anomalous.length,
                anomalyRate,
            },
            anomalous,
        });
    } catch (error) {
        console.error('Anomalies error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/terminals', (req, res) => {
    try {
        const rankings = getTerminalRankings();
        const rankedNames = rankings.map(r => r.terminal);

        const terminals = Object.entries(TERMINAL_VAULTS).map(([name, vaults]) => {
            let rank = rankedNames.indexOf(name);
            rank = rank === -1 ? 999 : rank + 1;
            
            return {
                name,
                enabled: vaults.length > 0,
                vaultCount: vaults.length,
                rank,
                vaults,
                totalSOL: rankings.find(r => r.terminal === name)?.totalSOL || 0
            };
        });
        
        terminals.sort((a,b) => a.rank - b.rank);
        res.json({ terminals });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin: reset database (wipe everything, start fresh)
app.post('/api/admin/reset', (req, res) => {
    try {
        resetDB();
        res.json({ success: true, message: 'Database reset. Indexer will set new markers on next cycle.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ───────────────────────────────────────────────

const PORT = SERVER_CONFIG.port || 3001;
app.listen(PORT, () => {
    console.log(`\n🚀 Terminal Stats running at http://localhost:${PORT}`);
    console.log(`📊 Data source: Local SQLite Indexer (Jupiter RPC Pool)`);
});
