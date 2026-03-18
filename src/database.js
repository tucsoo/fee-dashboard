// Axiom Fee Dashboard — SQLite Database Module
// Persistent storage for incremental data fetching

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'axiom_fees.db');

let db = null;

export function initDB() {
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
