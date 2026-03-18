// Axiom Fee Dashboard — Anomaly Detection Tests
import { scoreTrader, detectAnomalies } from '../src/anomaly.js';

console.log('🧪 Running anomaly detection tests...\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ❌ ${name}: ${err.message}`);
        failed++;
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg);
}

// ─── Pattern 1: Stablecoin Wash Trading ───
console.log('Pattern 1: Stablecoin Wash Trading');

test('Should flag wallet with >80% stablecoin volume', () => {
    const trader = {
        wallet: 'wash_trader_1',
        totalSOL: 0.5,
        txCount: 100,
        dailyVolumes: { '2025-01-01': 0.1, '2025-01-02': 0.1 },
        tokenVolumes: {
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 900, // USDC
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 50,  // USDT
            'some_random_token': 50,
        },
    };
    const result = scoreTrader(trader);
    assert(result.patterns.stablecoinWash.score > 0.5, `Expected high score, got ${result.patterns.stablecoinWash.score}`);
    assert(result.patterns.stablecoinWash.triggered, 'Should be triggered');
});

test('Should NOT flag wallet with low stablecoin volume', () => {
    const trader = {
        wallet: 'normal_trader_1',
        totalSOL: 1.0,
        txCount: 50,
        dailyVolumes: { '2025-01-01': 0.5, '2025-01-10': 0.5 },
        tokenVolumes: {
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 100, // USDC
            'random_memecoin_1': 500,
            'random_memecoin_2': 400,
        },
    };
    const result = scoreTrader(trader);
    assert(result.patterns.stablecoinWash.score < 0.3, `Expected low score, got ${result.patterns.stablecoinWash.score}`);
});

// ─── Pattern 2: Consistent Daily Volume ───
console.log('\nPattern 2: Consistent Daily Volume');

test('Should flag wallet with very consistent daily volume (CV < 0.15)', () => {
    const dailyVolumes = {};
    for (let i = 0; i < 10; i++) {
        dailyVolumes[`2025-01-${(i + 1).toString().padStart(2, '0')}`] = 1.0 + Math.random() * 0.05;
    }

    const trader = {
        wallet: 'bot_trader_1',
        totalSOL: 10.0,
        txCount: 200,
        dailyVolumes,
        tokenVolumes: {},
    };
    const result = scoreTrader(trader);
    assert(result.patterns.consistentVolume.score > 0.7, `Expected high score, got ${result.patterns.consistentVolume.score}`);
    assert(result.patterns.consistentVolume.triggered, 'Should be triggered');
});

test('Should NOT flag wallet with variable daily volume', () => {
    const trader = {
        wallet: 'human_trader_1',
        totalSOL: 5.0,
        txCount: 30,
        dailyVolumes: {
            '2025-01-01': 0.5,
            '2025-01-02': 2.0,
            '2025-01-03': 0.1,
            '2025-01-05': 3.5,
            '2025-01-08': 0.3,
            '2025-01-10': 1.2,
            '2025-01-15': 0.8,
        },
        tokenVolumes: {},
    };
    const result = scoreTrader(trader);
    assert(result.patterns.consistentVolume.score < 0.3, `Expected low score, got ${result.patterns.consistentVolume.score}`);
});

test('Should NOT flag wallet with too few days', () => {
    const trader = {
        wallet: 'new_trader_1',
        totalSOL: 0.2,
        txCount: 5,
        dailyVolumes: {
            '2025-01-01': 0.1,
            '2025-01-02': 0.1,
        },
        tokenVolumes: {},
    };
    const result = scoreTrader(trader);
    assert(result.patterns.consistentVolume.score === 0, `Expected 0, got ${result.patterns.consistentVolume.score}`);
});

// ─── Combined Scoring ───
console.log('\nCombined Scoring');

test('Should flag combined anomaly (both patterns)', () => {
    const dailyVolumes = {};
    for (let i = 0; i < 10; i++) {
        dailyVolumes[`2025-01-${(i + 1).toString().padStart(2, '0')}`] = 1.0;
    }

    const trader = {
        wallet: 'mega_bot_1',
        totalSOL: 10.0,
        txCount: 500,
        dailyVolumes,
        tokenVolumes: {
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 900,
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 100,
        },
    };
    const result = scoreTrader(trader);
    assert(result.isAnomaly, `Expected isAnomaly=true, got false. Score: ${result.anomalyScore}`);
    assert(result.anomalyScore >= 0.6, `Expected score >= 0.6, got ${result.anomalyScore}`);
});

test('Should NOT flag normal trader', () => {
    const trader = {
        wallet: 'legit_degen_1',
        totalSOL: 2.0,
        txCount: 25,
        dailyVolumes: {
            '2025-01-01': 0.5,
            '2025-01-03': 1.0,
            '2025-01-07': 0.2,
            '2025-01-10': 0.3,
        },
        tokenVolumes: {
            'random_memecoin': 800,
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 50,
        },
    };
    const result = scoreTrader(trader);
    assert(!result.isAnomaly, `Expected isAnomaly=false, got true. Score: ${result.anomalyScore}`);
});

// ─── detectAnomalies batch ───
console.log('\nBatch Detection');

test('detectAnomalies correctly separates clean and anomalous', () => {
    const traders = [
        {
            wallet: 'clean_1', totalSOL: 1, txCount: 10, dailyVolumes: { '2025-01-01': 0.5, '2025-01-10': 0.5 }, tokenVolumes: { 'random': 100 },
        },
        {
            wallet: 'bot_1', totalSOL: 10, txCount: 200,
            dailyVolumes: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`2025-01-${(i + 1).toString().padStart(2, '0')}`, 1.0])),
            tokenVolumes: { 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 900, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 100 },
        },
    ];

    const result = detectAnomalies(traders);
    assert(result.clean.length === 1, `Expected 1 clean, got ${result.clean.length}`);
    assert(result.anomalous.length === 1, `Expected 1 anomalous, got ${result.anomalous.length}`);
    assert(result.stats.anomalyRate === 50, `Expected 50%, got ${result.stats.anomalyRate}`);
});

// ─── Results ───
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
    console.log('🎉 All tests passed!\n');
} else {
    console.log('⚠️  Some tests failed!\n');
    process.exit(1);
}
