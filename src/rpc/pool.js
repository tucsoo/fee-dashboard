import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch'; // web3.js uses native fetch, but we might pass custom fetch if needed

/**
 * List of RPC Nodes. 
 * We use Jupiter's frontend RPCs with spoofed headers to bypass rate limits.
 */
const RPC_NODES = [
    {
        name: "Mercuria Frontend",
        url: "https://mercuria-fronten-1cd8.mainnet.rpcpool.com",
        headers: {
            "Origin": "https://jup.ag",
            "Referer": "https://jup.ag/"
        }
    },
    {
        name: "Jupiter Frontend",
        url: "https://jupiter-frontend.rpcpool.com",
        headers: {
            "Origin": "https://jup.ag",
            "Referer": "https://jup.ag/"
        }
    },
    {
        name: "Jupiter FE Helius",
        url: "https://jupiter-fe.helius-rpc.com",
        headers: {
            "Origin": "https://jup.ag",
            "Referer": "https://jup.ag/"
        }
    },
    {
        name: "Solana Public",
        url: "https://api.mainnet-beta.solana.com",
        headers: {}
    }
];

export class RpcPool {
    constructor() {
        this.currentIndex = 0;
        this.nodes = RPC_NODES.map(config => ({
            ...config,
            connection: new Connection(config.url, {
                httpHeaders: config.headers,
                commitment: 'confirmed'
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
