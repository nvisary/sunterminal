// ─── Redis Stream keys ─────────────────────────────────────────────

export const StreamKeys = {
  trades: (exchange: string, symbol: string) => `md:trades:${exchange}:${symbol}`,
  orderbook: (exchange: string, symbol: string) => `md:orderbook:${exchange}:${symbol}`,
  ticker: (exchange: string, symbol: string) => `md:ticker:${exchange}:${symbol}`,
  funding: (exchange: string, symbol: string) => `md:funding:${exchange}:${symbol}`,
  status: "md:status",

  // Python ML bridge
  mlFeatures: (symbol: string) => `ml:features:${symbol}`,
  mlSignals: (symbol: string) => `ml:signals:${symbol}`,

  // REST command pattern
  restRequest: "cmd:rest-request",
  restResponse: (reqId: string) => `ml:rest-response:${reqId}`,
} as const;

// ─── Snapshot keys (Redis Hash / String) ───────────────────────────

export const SnapshotKeys = {
  orderbook: (exchange: string, symbol: string) => `snapshot:ob:${exchange}:${symbol}`,
  ticker: (exchange: string, symbol: string) => `snapshot:tick:${exchange}:${symbol}`,
  funding: (exchange: string, symbol: string) => `snapshot:funding:${exchange}:${symbol}`,
} as const;

// ─── REST cache prefix ─────────────────────────────────────────────

export const CacheKeys = {
  markets: (exchange: string) => `rest:markets:${exchange}`,
  tickers: (exchange: string) => `rest:tickers:${exchange}`,
  ticker: (exchange: string, symbol: string) => `rest:ticker:${exchange}:${symbol}`,
  currencies: (exchange: string) => `rest:currencies:${exchange}`,
  myTrades: (exchange: string, symbol: string) => `rest:mytrades:${exchange}:${symbol}`,
  ohlcv: (exchange: string, symbol: string, tf: string) => `rest:ohlcv:${exchange}:${symbol}:${tf}`,
  fundingHistory: (exchange: string, symbol: string) => `rest:funding-history:${exchange}:${symbol}`,
  openInterest: (exchange: string, symbol: string) => `rest:oi:${exchange}:${symbol}`,
  leverage: (exchange: string, symbol: string) => `rest:leverage:${exchange}:${symbol}`,
} as const;

// ─── Consumer groups ───────────────────────────────────────────────

export const ConsumerGroups = {
  riskEngine: "risk-engine",
  hedgeEngine: "hedge-engine",
  tradeExec: "trade-exec",
  uiGateway: "ui-gateway",
  pythonMl: "python-ml",
  journal: "journal",
} as const;

// ─── MAXLEN per stream type ────────────────────────────────────────

export const StreamMaxLen = {
  trades: 10_000,
  orderbook: 5_000,
  ticker: 5_000,
  funding: 1_000,
  status: 100,
  mlFeatures: 1_000,
  mlSignals: 1_000,
} as const;
