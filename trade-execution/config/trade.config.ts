import type { TradeConfig, GuardLevel } from "../src/types/trade.types.ts";

const env = process.env;

export const config: TradeConfig = {
  redis: {
    url: env.REDIS_URL ?? "redis://localhost:6379",
  },

  positionSizer: {
    riskPerTrade: Number(env.RISK_PER_TRADE) || 1,
    maxPositionUSD: Number(env.MAX_POSITION_USD) || 100,
    maxOpenPositions: Number(env.MAX_OPEN_POSITIONS) || 3,
    defaultLeverage: Number(env.DEFAULT_LEVERAGE) || 5,
    atrMultiplier: Number(env.ATR_MULTIPLIER) || 1.5,
    marginReserve: Number(env.MARGIN_RESERVE) || 10,
  },

  smartOrder: {
    defaultStrategy: (env.DEFAULT_STRATEGY as "market" | "limit") ?? "limit",
    limitTimeout: Number(env.LIMIT_TIMEOUT) || 30_000,
    maxSlippage: Number(env.MAX_SLIPPAGE) || 0.5,
  },

  guards: {
    riskEngineBlock: (env.GUARD_RISK_BLOCK as GuardLevel) ?? "block",
    hedgeLock: (env.GUARD_HEDGE_LOCK as GuardLevel) ?? "block",
    balanceCheck: (env.GUARD_BALANCE as GuardLevel) ?? "block",
    maxPositions: (env.GUARD_MAX_POSITIONS as GuardLevel) ?? "block",
    volatilityRegime: (env.GUARD_VOLATILITY as GuardLevel) ?? "warning",
    levelProximity: (env.GUARD_LEVEL_PROXIMITY as GuardLevel) ?? "warning",
    fundingCost: (env.GUARD_FUNDING_COST as GuardLevel) ?? "warning",
  },

  sim: {
    accountId: env.SIM_ACCOUNT_ID ?? "default",
    initialEquity: Number(env.SIM_INITIAL_EQUITY) || 1000,
    takerFeePct: Number(env.SIM_TAKER_FEE_PCT) || 0.05,
    makerFeePct: Number(env.SIM_MAKER_FEE_PCT) || 0.02,
    slippageFallbackPct: Number(env.SIM_SLIPPAGE_FALLBACK_PCT) || 0.05,
    fundingIntervalMs: Number(env.SIM_FUNDING_INTERVAL_MS) || 60_000,
    markToMarketIntervalMs: Number(env.SIM_MTM_INTERVAL_MS) || 1_000,
    drawdownWarningPct: Number(env.SIM_DD_WARNING_PCT) || 2,
    drawdownDangerPct: Number(env.SIM_DD_DANGER_PCT) || 4,
    drawdownCriticalPct: Number(env.SIM_DD_CRITICAL_PCT) || 6,
    drawdownMaxPeakPct: Number(env.SIM_DD_MAX_PEAK_PCT) || 15,
  },

  logLevel: env.LOG_LEVEL ?? "info",
};
