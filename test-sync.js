import 'dotenv/config';
import { syncVault } from './src/fetcher.js';
import { getDB, initDB, getSummary } from './src/database.js';
import { SERVER_CONFIG, AXIOM_FEE_VAULTS } from './src/config.js';

initDB();
SERVER_CONFIG.daysToFetch = 1; // Just 1 day for quick test
console.log('Testing single vault sync...');
syncVault(AXIOM_FEE_VAULTS[0]).then(() => {
    console.log(getSummary());
}).catch(console.error);
