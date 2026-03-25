// Axiom Fee Dashboard — SQLite Database Module
// Persistent storage for incremental data fetching

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'axiom_fees.db');

let db = null;

export function initDB() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      signature TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      sender TEXT NOT NULL,
      fee_vault TEXT NOT NULL,
      terminal TEXT NOT NULL,
      sol_received REAL DEFAULT 0,
      tx_type TEXT DEFAULT '',
      description TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS token_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signature TEXT NOT NULL,
      mint TEXT NOT NULL,
      amount REAL NOT NULL,
      decimals INTEGER DEFAULT 0,
      FOREIGN KEY (signature) REFERENCES transactions(signature)
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      vault_address TEXT PRIMARY KEY,
      last_signature TEXT,
      last_timestamp INTEGER,
      total_fetched INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_tx_sender ON transactions(sender);
    CREATE INDEX IF NOT EXISTS idx_tx_terminal ON transactions(terminal);
    CREATE INDEX IF NOT EXISTS idx_tx_vault ON transactions(fee_vault);
    CREATE INDEX IF NOT EXISTS idx_tx_sender_timestamp ON transactions(sender, timestamp);
    CREATE INDEX IF NOT EXISTS idx_token_sig ON token_transfers(signature);
  `);

    console.log('📦 SQLite database initialized');
    return db;
}

export function getDB() {
    if (!db) initDB();
    return db;
}

// ─── Transaction Storage ───

const insertTxStmt = () => getDB().prepare(`
  INSERT OR IGNORE INTO transactions (signature, timestamp, sender, fee_vault, terminal, sol_received, tx_type, description)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

export function storeFeeTransactions(transactions) {
    const db = getDB();
    const insertTx = insertTxStmt();

    const insertMany = db.transaction((txs) => {
        let inserted = 0;
        for (const tx of txs) {
            const ts = tx.timestamp instanceof Date
                ? Math.floor(tx.timestamp.getTime() / 1000)
                : tx.timestamp;

            const result = insertTx.run(
                tx.signature,
                ts,
                tx.sender,
                tx.feeVault,
                tx.terminal || 'axiom', // fallback
                tx.solReceived || 0,
                tx.type || '',
                tx.description || ''
            );

            if (result.changes > 0) inserted++;
        }
        return inserted;
    });

    return insertMany(transactions);
}

// ─── Sync State ───

export function getLastSyncState(vaultAddress) {
    return getDB().prepare(
        'SELECT last_signature, last_timestamp, total_fetched FROM sync_state WHERE vault_address = ?'
    ).get(vaultAddress) || null;
}

export function updateSyncState(vaultAddress, lastSignature, lastTimestamp, totalFetched) {
    getDB().prepare(`
    INSERT INTO sync_state (vault_address, last_signature, last_timestamp, total_fetched, updated_at)
    VALUES (?, ?, ?, ?, strftime('%s', 'now'))
    ON CONFLICT(vault_address) DO UPDATE SET
      last_signature = excluded.last_signature,
      last_timestamp = excluded.last_timestamp,
      total_fetched = total_fetched + excluded.total_fetched,
      updated_at = excluded.updated_at
  `).run(vaultAddress, lastSignature, lastTimestamp, totalFetched);
}

// ─── Query Helpers ───

export function getDailyFees(terminal, daysBack = 30) {
    const cutoff = Math.floor(Date.now() / 1000) - (daysBack * 86400);
    return getDB().prepare(`
        SELECT
            date(timestamp, 'unixepoch') as date,
            SUM(sol_received) as totalSOL,
            0 as anomalousSOL,
            COUNT(*) as txCount,
            COUNT(DISTINCT sender) as uniqueTraders
        FROM transactions
        WHERE terminal = ? AND timestamp >= ?
        GROUP BY date(timestamp, 'unixepoch')
        ORDER BY date ASC
    `).all(terminal, cutoff);
}

export function getTraders(terminal, daysBack = 30, limit = 50) {
    const cutoff = Math.floor(Date.now() / 1000) - (daysBack * 86400);
    return getDB().prepare(`
        SELECT
            sender as wallet,
            SUM(sol_received) as totalSOL,
            COUNT(*) as txCount,
            COUNT(DISTINCT date(timestamp, 'unixepoch')) as activeDays,
            MIN(timestamp) as firstSeen,
            MAX(timestamp) as lastSeen
        FROM transactions
        WHERE terminal = ? AND timestamp >= ?
        GROUP BY sender
        ORDER BY totalSOL DESC
        LIMIT ?
    `).all(terminal, cutoff, limit);
}

/**
 * Get coefficient of variation (CV) for each trader's daily volume.
 * CV = stdev / mean. Low CV (< 0.05) = suspiciously consistent = likely wash trading.
 * Requires at least `minDays` active days to be meaningful.
 */
export function getTraderVolatility(terminal, daysBack = 30, minDays = 5) {
    const cutoff = Math.floor(Date.now() / 1000) - (daysBack * 86400);
    
    const isOverall = terminal === 'overall';
    const terminalClause = isOverall ? '' : 'AND t.terminal = ?';
    const params = isOverall ? [cutoff, minDays] : [cutoff, terminal, minDays];
    
    return getDB().prepare(`
        WITH daily AS (
            SELECT 
                t.sender,
                date(t.timestamp, 'unixepoch') as day,
                SUM(t.sol_received) as daily_sol,
                COUNT(*) as daily_txs
            FROM transactions t
            WHERE t.timestamp >= ? ${terminalClause}
            GROUP BY t.sender, date(t.timestamp, 'unixepoch')
        ),
        stats AS (
            SELECT 
                sender,
                COUNT(*) as active_days,
                AVG(daily_sol) as avg_daily_sol,
                AVG(daily_txs) as avg_daily_txs,
                -- Variance = E[X²] - E[X]²  →  stdev = sqrt(variance)
                CASE 
                    WHEN COUNT(*) < 2 THEN 999.0
                    ELSE SQRT(MAX(0, AVG(daily_sol * daily_sol) - AVG(daily_sol) * AVG(daily_sol)))
                END as std_daily_sol
            FROM daily
            GROUP BY sender
            HAVING active_days >= ?
        )
        SELECT 
            sender,
            active_days,
            avg_daily_sol,
            avg_daily_txs,
            std_daily_sol,
            CASE 
                WHEN avg_daily_sol > 0 THEN std_daily_sol / avg_daily_sol 
                ELSE 1.0 
            END as cv
        FROM stats
        ORDER BY cv ASC
    `).all(...params);
}

export function getSummary(terminal) {
    const now = Math.floor(Date.now() / 1000);
    const db = getDB();
    
    let total, last24h, last7d, last30d;
    
    if (terminal === 'overall') {
        // Aggregate across ALL terminals
        total = db.prepare('SELECT COUNT(*) as cnt, SUM(sol_received) as sol, COUNT(DISTINCT sender) as traders FROM transactions').get();
        last24h = db.prepare('SELECT SUM(sol_received) as sol, COUNT(DISTINCT sender) as traders, COUNT(*) as txs FROM transactions WHERE timestamp >= ?').get(now - 86400);
        last7d = db.prepare('SELECT SUM(sol_received) as sol, COUNT(DISTINCT sender) as traders, COUNT(*) as txs FROM transactions WHERE timestamp >= ?').get(now - (7 * 86400));
        last30d = db.prepare('SELECT SUM(sol_received) as sol, COUNT(DISTINCT sender) as traders, COUNT(*) as txs FROM transactions WHERE timestamp >= ?').get(now - (30 * 86400));
    } else {
        total = db.prepare('SELECT COUNT(*) as cnt, SUM(sol_received) as sol, COUNT(DISTINCT sender) as traders FROM transactions WHERE terminal = ?').get(terminal);
        last24h = db.prepare('SELECT SUM(sol_received) as sol, COUNT(DISTINCT sender) as traders, COUNT(*) as txs FROM transactions WHERE terminal = ? AND timestamp >= ?').get(terminal, now - 86400);
        last7d = db.prepare('SELECT SUM(sol_received) as sol, COUNT(DISTINCT sender) as traders, COUNT(*) as txs FROM transactions WHERE terminal = ? AND timestamp >= ?').get(terminal, now - (7 * 86400));
        last30d = db.prepare('SELECT SUM(sol_received) as sol, COUNT(DISTINCT sender) as traders, COUNT(*) as txs FROM transactions WHERE terminal = ? AND timestamp >= ?').get(terminal, now - (30 * 86400));
    }

    return {
        totalTransactions: total.cnt || 0,
        totalFeesSOL: total.sol || 0,
        uniqueTraders: total.traders || 0,
        last24hSOL: last24h.sol || 0,
        last7dSOL: last7d.sol || 0,
        last30dSOL: last30d.sol || 0,
        uniqueTraders24h: last24h.traders || 0,
        uniqueTraders7d: last7d.traders || 0,
        uniqueTraders30d: last30d.traders || 0,
        tx24h: last24h.txs || 0,
        tx7d: last7d.txs || 0,
        tx30d: last30d.txs || 0,
    };
}

export function getTerminalRankings() {
    return getDB().prepare(`
        SELECT terminal, SUM(sol_received) as totalSOL
        FROM transactions
        GROUP BY terminal
        ORDER BY totalSOL DESC
    `).all();
}
