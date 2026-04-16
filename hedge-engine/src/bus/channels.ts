// ─── Input: Risk Engine signals ───────────────────────────────────

export const RiskStreamKeys = {
  drawdown: "risk:signals:drawdown",
  exposure: "risk:signals:exposure",
  volatility: "risk:signals:volatility",
} as const;

export const RiskSnapshotKeys = {
  exposure: "risk:snapshot:exposure",
} as const;

// ─── Input: Market Data ───────────────────────────────────────────

export const MdSnapshotKeys = {
  ticker: (exchange: string, symbol: string) => `snapshot:tick:${exchange}:${symbol}`,
  funding: (exchange: string, symbol: string) => `snapshot:funding:${exchange}:${symbol}`,
} as const;

export const MdStreamKeys = {
  restRequest: "cmd:rest-request",
  restResponse: (reqId: string) => `ml:rest-response:${reqId}`,
} as const;

// ─── Output: Hedge Engine ─────────────────────────────────────────

export const HedgeStreamKeys = {
  state: "hedge:state",
  actions: "hedge:actions",
  recommendations: "hedge:recommendations",
} as const;

export const HedgeSnapshotKeys = {
  state: "hedge:snapshot:state",
  config: "config:hedge",
} as const;

// ─── Consumer group ───────────────────────────────────────────────

export const HEDGE_CONSUMER_GROUP = "hedge-engine";
export const hedgeConsumerName = () => `hedge-${process.pid}`;

export const HedgeStreamMaxLen = {
  state: 5_000,
  actions: 10_000,
  recommendations: 5_000,
} as const;
