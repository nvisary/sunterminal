import type { RiskEngineConfig } from "../src/types/risk.types.ts";

const env = process.env;

export const config: RiskEngineConfig = {
  redis: {
    url: env.REDIS_URL ?? "redis://localhost:6379",
  },
  exchanges: (env.RISK_EXCHANGES ?? "binance,bybit")
    .split(",")
    .map((s) => s.trim()),
  symbols: (env.RISK_SYMBOLS ?? "BTC/USDT:USDT,ETH/USDT:USDT")
    .split(",")
    .map((s) => s.trim()),
  pollIntervalMs: Number(env.POLL_INTERVAL_MS) || 5000,

  drawdown: {
    warningPct: Number(env.DD_WARNING_PCT) || 2,
    dangerPct: Number(env.DD_DANGER_PCT) || 4,
    criticalPct: Number(env.DD_CRITICAL_PCT) || 6,
    maxPeakPct: Number(env.DD_MAX_PEAK_PCT) || 15,
    perTradePct: Number(env.DD_PER_TRADE_PCT) || 3,
  },

  exposure: {
    highRatio: Number(env.EXP_HIGH_RATIO) || 3,
    imbalanceThreshold: Number(env.EXP_IMBALANCE) || 0.8,
    concentrationThreshold: Number(env.EXP_CONCENTRATION) || 0.5,
    exchangeRiskThreshold: Number(env.EXP_EXCHANGE_RISK) || 0.7,
  },

  volatility: {
    atrPeriod: 14,
    histVolPeriod: 20,
    realtimeTickWindow: 100,
    percentileWindowDays: 30,
  },

  levels: {
    wallThreshold: 5,
    clusterTolerance: 0.001,
    spoofLifetimeMs: 10_000,
    spoofFlickerCount: 3,
    ohlcvTimeframes: ["5m", "15m", "1h", "4h"],
    swingLookback: 5,
  },

  microstructure: {
    tradeWindowMs: 60_000,
    imbalanceDepth: 10,
    vpinBucketVolume: 5000, // Reduced from 10k to $5k for maximum reactivity
    vpinBucketCount: 30,
  },

  footprint: {
    timeframeMs: 60_000, // 1m candles
    maxCandles: 60,
    tickMultiplier: 1, // 1 × exchange tickSize
  },

  heatmap: {
    intervalMs: 250, // sample at 4 Hz
    windowMs: 5 * 60_000, // 5 min rolling history (~1200 snapshots)
  },

  alerts: {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
    webhookUrl: env.WEBHOOK_URL || undefined,
    defaultCooldownMs: 60_000,
  },

  logLevel: env.LOG_LEVEL ?? "info",
};
