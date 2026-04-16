// ─── Input: from other modules ────────────────────────────────────

export const MdStreamKeys = {
  restRequest: "cmd:rest-request",
  restResponse: (reqId: string) => `ml:rest-response:${reqId}`,
} as const;

export const MdSnapshotKeys = {
  ticker: (exchange: string, symbol: string) => `snapshot:tick:${exchange}:${symbol}`,
  orderbook: (exchange: string, symbol: string) => `snapshot:ob:${exchange}:${symbol}`,
  funding: (exchange: string, symbol: string) => `snapshot:funding:${exchange}:${symbol}`,
} as const;

export const RiskSnapshotKeys = {
  exposure: "risk:snapshot:exposure",
  volatility: (exchange: string, symbol: string) => `risk:snapshot:volatility:${exchange}:${symbol}`,
  levels: (exchange: string, symbol: string) => `risk:snapshot:levels:${exchange}:${symbol}`,
} as const;

export const HedgeSnapshotKeys = {
  state: "hedge:snapshot:state",
} as const;

// ─── Output: Trade Execution ──────────────────────────────────────

export const TradeStreamKeys = {
  orders: "trade:orders",
  journal: "trade:journal",
  equity: "trade:equity",
  router: "trade:router",
} as const;

export const TradeHashKeys = {
  open: "trade:open",
  stats: "trade:stats",
} as const;

export const TradeStreamMaxLen = {
  orders: 10_000,
  journal: 10_000,
  equity: 50_000,
  router: 1_000,
} as const;
