require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');

const txSignature = 'iQMAVokwBSVSZUqJmn9YeAaYgmjRUYBNNy1nLavgYMUPXVidbJn1JL6MAW4M2J5XJJoxg2zWjcwCzmWnSFpWEvs';

async function fetchTx() {
    try {
        const apiKey = process.env.HELIUS_API_KEY;
        const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'my-id',
                method: 'getParsedTransaction',
                params: [
                    txSignature,
                    { maxSupportedTransactionVersion: 0 }
                ]
            })
        });

        const data = await response.json();
        console.log(JSON.stringify(data.result, null, 2));
    } catch (e) {
        console.error(e);
    }
}

fetchTx();
