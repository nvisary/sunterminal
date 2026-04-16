import type { HedgeConfig, HedgeMode } from "../src/types/hedge.types.ts";

const env = process.env;

export const config: HedgeConfig = {
  redis: {
    url: env.REDIS_URL ?? "redis://localhost:6379",
  },
  exchanges: (env.HEDGE_EXCHANGES ?? "binance,bybit").split(",").map((s) => s.trim()),
  globalMode: (env.HEDGE_MODE as HedgeMode) ?? "advisor",

  autoHedge: {
    enabled: env.AUTO_HEDGE_ENABLED !== "false",
    mode: (env.AUTO_HEDGE_MODE as HedgeMode) ?? (env.HEDGE_MODE as HedgeMode) ?? "advisor",
    hedgeThreshold: Number(env.AUTO_HEDGE_THRESHOLD) || 25,
    unhedgeThreshold: Number(env.AUTO_HEDGE_UNHEDGE_THRESHOLD) || 10,
    hedgeRatio: Number(env.AUTO_HEDGE_RATIO) || 0.5,
    hedgeExchange: env.AUTO_HEDGE_EXCHANGE ?? "auto",
    maxHedgeSize: Number(env.AUTO_HEDGE_MAX_SIZE) || 100,
    checkInterval: Number(env.AUTO_HEDGE_INTERVAL) || 5000,
    maxCostPercent: Number(env.AUTO_HEDGE_MAX_COST_PCT) || 0.1,
  },

  deltaNeutral: {
    enabled: env.DELTA_NEUTRAL_ENABLED === "true",
    mode: (env.DELTA_NEUTRAL_MODE as HedgeMode) ?? (env.HEDGE_MODE as HedgeMode) ?? "advisor",
    targetDelta: Number(env.DELTA_NEUTRAL_TARGET) || 0,
    deltaThreshold: Number(env.DELTA_NEUTRAL_THRESHOLD) || 15,
    rebalanceInterval: Number(env.DELTA_NEUTRAL_INTERVAL) || 30000,
    maxRebalanceSize: Number(env.DELTA_NEUTRAL_MAX_SIZE) || 50,
    rebalanceExchange: env.DELTA_NEUTRAL_EXCHANGE ?? "auto",
  },

  emergencyExit: {
    autoTriggerEnabled: env.EMERGENCY_AUTO_TRIGGER !== "false",
    triggers: {
      ddCritical: env.EMERGENCY_DD_CRITICAL !== "false",
      ddMaxPeak: env.EMERGENCY_DD_MAX_PEAK !== "false",
      allConnectorsDown: env.EMERGENCY_ALL_DOWN === "true",
      telegramKill: env.EMERGENCY_TELEGRAM_KILL !== "false",
    },
    retryAttempts: Number(env.EMERGENCY_RETRY_ATTEMPTS) || 3,
    retryDelay: Number(env.EMERGENCY_RETRY_DELAY) || 3000,
  },

  logLevel: env.LOG_LEVEL ?? "info",
};
