import type { ExchangeConfig, MarketDataConfig } from "../src/types/market-data.types.ts";

const env = process.env;

const binance: ExchangeConfig = {
  id: "binance",
  enabled: env.BINANCE_ENABLED !== "false",
  ccxtClass: "binance",
  type: (env.BINANCE_TYPE as "spot" | "swap") ?? "swap",
  apiKey: env.BINANCE_API_KEY,
  secret: env.BINANCE_SECRET,
  defaultSymbols: ["BTC/USDT:USDT", "ETH/USDT:USDT"],
  orderbookDepth: Number(env.ORDERBOOK_DEPTH) || 50,
  sandbox: env.SANDBOX === "true",
};

const bybit: ExchangeConfig = {
  id: "bybit",
  enabled: env.BYBIT_ENABLED !== "false",
  ccxtClass: "bybit",
  type: (env.BYBIT_TYPE as "spot" | "swap") ?? "swap",
  apiKey: env.BYBIT_API_KEY,
  secret: env.BYBIT_SECRET,
  defaultSymbols: ["BTC/USDT:USDT", "ETH/USDT:USDT"],
  orderbookDepth: Number(env.ORDERBOOK_DEPTH) || 50,
  sandbox: env.SANDBOX === "true",
};

const okx: ExchangeConfig = {
  id: "okx",
  enabled: env.OKX_ENABLED === "true",
  ccxtClass: "okx",
  type: (env.OKX_TYPE as "spot" | "swap") ?? "swap",
  apiKey: env.OKX_API_KEY,
  secret: env.OKX_SECRET,
  passphrase: env.OKX_PASSPHRASE,
  defaultSymbols: ["BTC/USDT:USDT", "ETH/USDT:USDT"],
  orderbookDepth: Number(env.ORDERBOOK_DEPTH) || 50,
  sandbox: env.SANDBOX === "true",
};

export const config: MarketDataConfig = {
  redis: {
    url: env.REDIS_URL ?? "redis://localhost:6379",
  },
  exchanges: [binance, bybit, okx].filter((e) => e.enabled),
  maxStreamLen: Number(env.MAX_STREAM_LEN) || 10_000,
  logLevel: env.LOG_LEVEL ?? "info",
};
