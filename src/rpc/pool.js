import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import dotenv from 'dotenv';
dotenv.config();

// Full browser fingerprint to bypass Cloudflare / WAF blocks
const BROWSER_HEADERS = {
    "Origin": "https://jup.ag",
    "Referer": "https://jup.ag/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
    "Sec-Ch-Ua": '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
};

/**
 * List of RPC Nodes. 
 * We use Jupiter's frontend RPCs with fully spoofed browser headers to bypass rate limits and IP blocks.
 */
const RPC_NODES = [
    {
        name: "Mercuria Frontend",
        url: "https://mercuria-fronten-1cd8.mainnet.rpcpool.com",
        headers: BROWSER_HEADERS
    },
    {
        name: "Jupiter Frontend",
        url: "https://jupiter-frontend.rpcpool.com",
        headers: BROWSER_HEADERS
    },
    {
        name: "Jupiter FE Helius",
        url: "https://jupiter-fe.helius-rpc.com",
        headers: BROWSER_HEADERS
    },
    {
        name: "Solana Public",
        url: "https://api.mainnet-beta.solana.com",
        headers: {}
    }
];

// Setup HTTP Proxy if provided
const proxyUrl = process.env.HTTP_PROXY;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
if (proxyAgent) {
    console.log(`[RpcPool] Proxy configured: Routing all RPC traffic through ${proxyUrl}`);
} else {
    console.warn(`[RpcPool] WARNING: No HTTP_PROXY set. Render IPs will likely be blocked (403 Forbidden).`);
}

// Custom fetch to force web3.js to use our proxy agent
const customFetch = (url, options) => {
    return fetch(url, { ...options, agent: proxyAgent });
};

export class RpcPool {
    constructor() {
        this.currentIndex = 0;
        this.nodes = RPC_NODES.map(config => ({
            ...config,
            connection: new Connection(config.url, {
                httpHeaders: config.headers,
                commitment: 'confirmed',
                fetch: customFetch
            })
        }));
    }

    /**
     * Get the current active node
     */
    getCurrentNode() {
        return this.nodes[this.currentIndex];
    }

    /**
     * Rotate to the next node in the pool
     */
    rotate() {
        this.currentIndex = (this.currentIndex + 1) % this.nodes.length;
        console.log(`[RpcPool] Switched to RPC Node: ${this.getCurrentNode().name}`);
    }

    /**
     * Execute an RPC call with automatic rotation on failure (rate limits/timeouts)
     */
    async fetchWithRotation(actionFn, maxRetries = 10) {
        let retries = 0;

        while (retries < maxRetries) {
            const node = this.getCurrentNode();
            try {
                return await actionFn(node.connection);
            } catch (err) {
                const msg = err.message || err.toString();
                
                // Typical errors: 429 Too Many Requests, limit exceeded, timeout
                if (msg.includes('429') || msg.includes('limit') || msg.includes('fetch') || msg.includes('timeout') || msg.includes('403')) {
                    console.warn(`[RpcPool] Node ${node.name} failed: ${msg}. Rotating...`);
                    this.rotate();
                    retries++;
                    // short backoff to not immediately smash the next one if it's struggling globally
                    await new Promise(r => setTimeout(r, 500));
                } else {
                    // It's a legitimate error from the chain (e.g. invalid signature)
                    throw err;
                }
            }
        }
        
        throw new Error(`[RpcPool] Completely failed after ${maxRetries} retries across all nodes.`);
    }

    /**
     * Helper to get signatures
     */
    async getSignaturesForAddress(address, options = {}) {
        const pubkey = new PublicKey(address);
        return this.fetchWithRotation(async (conn) => {
            return await conn.getSignaturesForAddress(pubkey, options);
        });
    }

    /**
     * Helper to get parsed transactions
     */
    async getParsedTransactions(signatures, options = {}) {
        return this.fetchWithRotation(async (conn) => {
            return await conn.getParsedTransactions(signatures, {
                maxSupportedTransactionVersion: 0,
                ...options
            });
        });
    }
}

// Export a singleton instance
export const rpcPool = new RpcPool();
