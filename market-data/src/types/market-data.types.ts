import type { Exchange as CcxtExchange } from "ccxt";

// ─── Exchange Config ───────────────────────────────────────────────

export interface ExchangeConfig {
  id: string;
  enabled: boolean;
  ccxtClass: string;
  type: "spot" | "swap";
  apiKey?: string;
  secret?: string;
  passphrase?: string; // OKX
  defaultSymbols: string[];
  orderbookDepth: number;
  sandbox: boolean;
}

export interface MarketDataConfig {
  redis: { url: string };
  exchanges: ExchangeConfig[];
  maxStreamLen: number;
  logLevel: string;
}

// ─── Funding ───────────────────────────────────────────────────────

export interface FundingData {
  exchange: string;
  symbol: string; // 'BTC/USDT:USDT'
  rate: number; // 0.0001 = 0.01%
  predictedRate: number | null;
  nextFundingTime: number; // Unix ms
  interval: 1 | 4 | 8; // Hours
  annualizedRate: number; // rate * (365*24 / interval)
  timestamp: number;
}

export type FundingSignal =
  | "FUNDING_EXTREME_HIGH"
  | "FUNDING_EXTREME_LOW"
  | "FUNDING_FLIP"
  | "FUNDING_COST_WARN";

// ─── Ticker Info (enriched) ────────────────────────────────────────

export interface TickerInfo {
  symbol: string;
  last: number | undefined;
  bid: number | undefined;
  ask: number | undefined;
  baseVolume: number | undefined;
  quoteVolume: number | undefined;
  change: number | undefined;
  percentage: number | undefined;
  timestamp: number | undefined;
  minAmount: number | undefined;
  pricePrecision: number | undefined;
  amountPrecision: number | undefined;
  makerFee: number | undefined;
  takerFee: number | undefined;
  contractSize: number | undefined;
  type: string | undefined;
}

// ─── Connector status ──────────────────────────────────────────────

export type ConnectorStatus = "connected" | "connecting" | "error" | "stopped";

// ─── Subscription tracking ─────────────────────────────────────────

export interface SubscriptionEntry {
  exchange: string;
  symbol: string;
  refCount: number;
}

// ─── Cache options ─────────────────────────────────────────────────

export interface CacheOptions {
  ttl: number; // Seconds
  staleWhileRevalidate?: boolean; // default: true
  forceRefresh?: boolean; // Skip cache
}

// ─── Redis Stream message ──────────────────────────────────────────

export interface StreamMessage {
  [key: string]: string;
}

// ─── REST command pattern (for Python bridge) ──────────────────────

export interface RestCommand {
  method: string;
  exchange: string;
  args: unknown[];
  replyTo: string;
}

// ─── Re-export CCXT types we use frequently ────────────────────────

export type {
  Trade,
  OrderBook,
  Ticker,
  Market,
  Balances,
  Position,
  Order,
  OHLCV,
  Currency,
  FundingRate,
  OpenInterest,
} from "ccxt";

export type ProExchange = CcxtExchange & {
  watchTrades(symbol: string, since?: number, limit?: number): Promise<import("ccxt").Trade[]>;
  watchOrderBook(symbol: string, limit?: number): Promise<import("ccxt").OrderBook>;
  watchTicker(symbol: string): Promise<import("ccxt").Ticker>;
};
