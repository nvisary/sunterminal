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

// ─── Output: Trade Execution (LIVE) ───────────────────────────────

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

// ─── Sim Mode (paper trading) ─────────────────────────────────────

export const SimStreamKeys = {
  orders: "sim:orders",
  journal: "sim:journal",
  drawdown: "sim:drawdown",
  exposure: "sim:exposure",
  equity: (accountId: string) => `sim:equity-curve:${accountId}`,
} as const;

export const SimHashKeys = {
  open: (accountId: string) => `sim:positions:${accountId}`,
  openOrders: (accountId: string) => `sim:open-orders:${accountId}`,
  stats: (accountId: string) => `sim:stats:${accountId}`,
} as const;

export const SimSnapshotKeys = {
  account: (accountId: string) => `sim:account:${accountId}`,
  exposure: (accountId: string) => `sim:snapshot:exposure:${accountId}`,
  drawdown: (accountId: string) => `sim:snapshot:drawdown:${accountId}`,
  tradeBlocked: (accountId: string) => `sim:state:trade-blocked:${accountId}`,
  config: "sim:config",
} as const;

export const SimStreamMaxLen = {
  orders: 5_000,
  journal: 10_000,
  drawdown: 5_000,
  exposure: 5_000,
  equity: 50_000,
} as const;

/**
 * Mode-aware journal/positions key resolver.
 * - live: keeps the original `trade:open` / `trade:journal` keys (back-compat).
 * - sim: per-account `sim:positions:{accountId}` / `sim:journal`.
 */
export function resolveJournalKeys(mode: "live" | "sim", accountId: string): {
  openHash: string;
  journalStream: string;
  ordersStream: string;
  equityStream: string;
  statsHash: string;
  journalMaxLen: number;
  ordersMaxLen: number;
  equityMaxLen: number;
} {
  if (mode === "live") {
    return {
      openHash: TradeHashKeys.open,
      journalStream: TradeStreamKeys.journal,
      ordersStream: TradeStreamKeys.orders,
      equityStream: TradeStreamKeys.equity,
      statsHash: TradeHashKeys.stats,
      journalMaxLen: TradeStreamMaxLen.journal,
      ordersMaxLen: TradeStreamMaxLen.orders,
      equityMaxLen: TradeStreamMaxLen.equity,
    };
  }
  return {
    openHash: SimHashKeys.open(accountId),
    journalStream: SimStreamKeys.journal,
    ordersStream: SimStreamKeys.orders,
    equityStream: SimStreamKeys.equity(accountId),
    statsHash: SimHashKeys.stats(accountId),
    journalMaxLen: SimStreamMaxLen.journal,
    ordersMaxLen: SimStreamMaxLen.orders,
    equityMaxLen: SimStreamMaxLen.equity,
  };
}

// ─── Command streams (gateway → trade-execution) ──────────────────

export const CmdStreamKeys = {
  tradeOpen: "cmd:trade:open",
  tradeClose: "cmd:trade:close",
  tradeCloseAll: "cmd:trade:close-all",
  tradeCalcSize: "cmd:trade:calculate-size",
  simOpen: "cmd:sim:trade:open",
  simClose: "cmd:sim:trade:close",
  simCloseAll: "cmd:sim:trade:close-all",
  simReset: "cmd:sim:reset",
  simConfig: "cmd:sim:config",
} as const;

export const CmdConsumerGroup = "trade-exec";
