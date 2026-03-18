// Flipside Crypto API v3 Client
// Base URL: https://api.flipsidecrypto.xyz/public/v3
// Auth: x-api-key header
//
// Flow:
//   1. POST /queries — create query (name + sql)
//   2. POST /queries/{id}/execute — run it → returns queryRunId
//   3. GET /query-runs/{runId}/result — poll until status=completed
//   4. GET /queries/{id}/latest/data — get result rows

const BASE_URL = 'https://api.flipsidecrypto.xyz/public/v3';
const API_KEY = process.env.FLIPSIDE_API_KEY || '';

// In-memory cache: key = SQL hash, value = { data, timestamp }
const queryCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Map of SQL hash → query ID (so we can reuse queries)
const queryIdCache = new Map();

/**
 * Execute a SQL query against Flipside and return rows.
 * Reuses existing query objects when possible.
 */
export async function runQuery(sql, cacheTTL = CACHE_TTL) {
    const cacheKey = sql.trim();

    // Check result cache first
    const cached = queryCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < cacheTTL)) {
        return cached.data;
    }

    console.log(`📊 Flipside: ${sql.substring(0, 80)}...`);

    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
    };

    // Step 1: Create or reuse a query
    let queryId = queryIdCache.get(cacheKey);

    if (!queryId) {
        const createRes = await fetch(`${BASE_URL}/queries`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name: `ts_${Date.now()}`,
                sql: cacheKey,
                userAgent: 'api',
            }),
        });

        const createData = await createRes.json();
        if (!createData.id) {
            throw new Error(`Flipside create failed: ${JSON.stringify(createData)}`);
        }
        queryId = createData.id;
        queryIdCache.set(cacheKey, queryId);
    } else {
        // Update SQL in case it changed (shouldn't but just in case)
        await fetch(`${BASE_URL}/queries/${queryId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ sql: cacheKey }),
        });
    }

    // Step 2: Execute the query
    const execRes = await fetch(`${BASE_URL}/queries/${queryId}/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userAgent: 'api' }),
    });

    const execData = await execRes.json();
    if (!execData.queryRunId) {
        throw new Error(`Flipside execute failed: ${JSON.stringify(execData)}`);
    }

    const queryRunId = execData.queryRunId;

    // Step 3: Poll for completion
    const maxAttempts = 120; // up to 120 seconds
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(1000);

        const statusRes = await fetch(`${BASE_URL}/query-runs/${queryRunId}/result`, {
            headers: { 'x-api-key': API_KEY },
        });

        const statusData = await statusRes.json();
        const status = statusData.status?.toUpperCase();

        if (status === 'COMPLETED') {
            // Step 4: Get result data
            const dataRes = await fetch(`${BASE_URL}/queries/${queryId}/latest/data`, {
                headers: { 'x-api-key': API_KEY },
            });

            const resultData = await dataRes.json();
            // Normalize keys to lowercase (Snowflake returns UPPERCASE)
            const rows = (resultData.rows || []).map(row => {
                const normalized = {};
                for (const [key, val] of Object.entries(row)) {
                    normalized[key.toLowerCase()] = val;
                }
                return normalized;
            });

            // Cache it
            queryCache.set(cacheKey, { data: rows, timestamp: Date.now() });
            console.log(`✅ Flipside: ${rows.length} rows in ${((attempt + 1))}s`);
            return rows;
        }

        if (status === 'FAILED' || status === 'CANCELLED') {
            throw new Error(`Flipside query ${status}: ${statusData.errorDetails || 'unknown'}`);
        }

        // Still PENDING/SUBMITTED/RUNNING — continue polling
    }

    throw new Error('Flipside query timed out after 120s');
}

/**
 * Clear caches
 */
export function clearCache() {
    queryCache.clear();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
