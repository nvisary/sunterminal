// ─── Input: Market Data streams (from market-data module) ─────────

export const MdStreamKeys = {
  trades: (exchange: string, symbol: string) => `md:trades:${exchange}:${symbol}`,
  orderbook: (exchange: string, symbol: string) => `md:orderbook:${exchange}:${symbol}`,
  funding: (exchange: string, symbol: string) => `md:funding:${exchange}:${symbol}`,
  status: "md:status",
  restRequest: "cmd:rest-request",
  restResponse: (reqId: string) => `ml:rest-response:${reqId}`,
} as const;

export const MdSnapshotKeys = {
  orderbook: (exchange: string, symbol: string) => `snapshot:ob:${exchange}:${symbol}`,
  ticker: (exchange: string, symbol: string) => `snapshot:tick:${exchange}:${symbol}`,
  funding: (exchange: string, symbol: string) => `snapshot:funding:${exchange}:${symbol}`,
} as const;

// ─── Output: Risk signal streams ──────────────────────────────────

export const RiskStreamKeys = {
  drawdown: "risk:signals:drawdown",
  levels: "risk:signals:levels",
  volatility: "risk:signals:volatility",
  correlation: "risk:signals:correlation",
  exposure: "risk:signals:exposure",
  alerts: "risk:alerts",
} as const;

export const RiskSnapshotKeys = {
  exposure: "risk:snapshot:exposure",
  volatility: (exchange: string, symbol: string) => `risk:snapshot:volatility:${exchange}:${symbol}`,
  levels: (exchange: string, symbol: string) => `risk:snapshot:levels:${exchange}:${symbol}`,
  zones: (exchange: string, symbol: string) => `risk:snapshot:zones:${exchange}:${symbol}`,
  activeAlerts: "risk:snapshot:active-alerts",
  peakEquity: "risk:state:peak-equity",
  dailyStartEquity: "risk:state:daily-start-equity",
} as const;

export const RiskHistoryKeys = {
  atr: (exchange: string, symbol: string) => `risk:history:atr:${exchange}:${symbol}`,
} as const;

// ─── Consumer group & MAXLEN ──────────────────────────────────────

export const RISK_CONSUMER_GROUP = "risk-engine";
export const riskConsumerName = () => `risk-${process.pid}`;

export const RiskStreamMaxLen = {
  drawdown: 5_000,
  levels: 5_000,
  volatility: 5_000,
  correlation: 1_000,
  exposure: 5_000,
  alerts: 10_000,
} as const;
