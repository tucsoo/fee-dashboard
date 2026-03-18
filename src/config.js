// Terminal Stats — Configuration
import 'dotenv/config';

// ─── Terminal Vault Addresses ───
// Each terminal has a set of fee vault addresses that receive trading fees.
// We query Flipside for transfers TO these addresses.

export const TERMINAL_VAULTS = {
  axiom: [
    '4V65jvcDG9DSQioUVqVPiUcUY9v6sb6HKtMnsxSKEz5S',
    '7LCZckF6XXGQ1hDY6HFXBKWAtiUgL9QY5vj1C4Bn1Qjj',
    'CeA3sPZfWWToFEBmw5n1Y93tnV66Vmp8LacLzsVprgxZ',
    'AaG6of1gbj1pbDumvbSiTuJhRCRkkUNaWVxijSbWvTJW',
    '7oi1L8U9MRu5zDz5syFahsiLUric47LzvJBQX6r827ws',
    '9kPrgLggBJ69tx1czYAbp7fezuUmL337BsqQTKETUEhP',
    'DKyUs1xXMDy8Z11zNsLnUg3dy9HZf6hYZidB6WodcaGy',
    '4FobGn5ZWYquoJkxMzh2VUAWvV36xMgxQ3M7uG1pGGhd',
    '76sxKrPtgoJHDJvxwFHqb3cAXWfRHFLe3VpKcLCAHSEf',
    'H2cDR3EkJjtTKDQKk8SJS48du9mhsdzQhy8xJx5UMqQK',
    '8m5GkL7nVy95G4YVUbs79z873oVKqg2afgKRmqxsiiRm',
    '4kuG6NsAFJNwqEkac8GFDMMheCGKUPEbaRVHHyFHSwWz',
    '8vFGAKdwpn4hk7kc1cBgfWZzpyW3MEMDATDzVZhddeQb',
    '86Vh4XGLW2b6nvWbRyDs4ScgMXbuvRCHT7WbUT3RFxKG',
    'DZfEurFKFtSbdWZsKSDTqpqsQgvXxmESpvRtXkAdgLwM',
    'DYVeNgXGLAhZdeLMMYnCw1nPnMxkBN7fJnNpHmizTrrF',
    'Hbj6XdxX6eV4nfbYTseysibp4zZJtVRRPn2J3BhGRuK9',
    '846ah7iBSu9ApuCyEhA5xpnjHHX7d4QJKetWLbwzmJZ8',
    '5BqYhuD4q1YD3DMAYkc1FeTu9vqQVYYdfBAmkZjamyZg',
  ],
  // Other terminals — vault addresses TBD
  gmgn: [
    'BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT',
    'HeZVpHj9jLwTVtMMbzQRf6mLtFPkWNSg11o68qrbUBa3',
    'ByRRgnZenY6W2sddo1VJzX9o4sMU4gPDUkcmgrpGBxRy',
    'DXfkEGoo6WFsdL7x6gLZ7r6Hw2S6HrtrAQVPWYx2A1s9',
    '3t9EKmRiAUcQUYzTZpNojzeGP1KBAVEEbDNmy6wECQpK',
    'DymeoWc5WLNiQBaoLuxrxDnDRvLgGZ1QGsEoCAM7Jsrx',
    'dBhdrmwBkRa66XxBuAK4WZeZnsZ6bHeHCCLXa3a8bTJ'
  ],
  padre: [
    'J5XGHmzrRmnYWbmw45DbYkdZAU2bwERFZ11qCDXPvFB5',
    'DoAsxPQgiyAxyaJNvpAAUb2ups6rbJRdYrCPyWxwRxBb'
  ],
  fomo: [
    'R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX'
  ],
  trojan: [
    '9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco'
  ],
  photon: [
    'AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH'
  ],
  maestro: [
    'MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36'
  ],
  universalx: [
    '3RY3ngufsn1aPSWE46Ga7sX5pZi2KPCvZG5uGS6TFLZJ'
  ],
};

// Anomaly detection thresholds
export const ANOMALY_CONFIG = {
  stablecoinVolumeRatioThreshold: 0.8,
  stablecoinWeight: 0.5,
  cvThreshold: 0.15,
  minDaysForCV: 7,
  consistencyWeight: 0.5,
  anomalyScoreThreshold: 0.6,
};

// Known stablecoin mints on Solana
export const STABLECOIN_MINTS = {
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
};

// Server config
export const SERVER_CONFIG = {
  port: process.env.PORT || 3001,
  cacheTTL: 10 * 60 * 1000, // 10 minutes
};

// Helper: get vault addresses for a terminal (or all terminals for "overall")
export function getVaultsForTerminal(terminal) {
  if (terminal === 'overall') {
    return Object.values(TERMINAL_VAULTS).flat();
  }
  return TERMINAL_VAULTS[terminal] || [];
}

// Helper: format vault addresses for SQL IN clause
export function vaultsToSQL(vaults) {
  return vaults.map(v => `'${v}'`).join(',');
}
