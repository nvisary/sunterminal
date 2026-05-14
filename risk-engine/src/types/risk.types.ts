// ─── Universal Risk Signal ────────────────────────────────────────

export type SignalSource =
  | "drawdown"
  | "levels"
  | "volatility"
  | "correlation"
  | "exposure"
  | "funding";
export type SignalLevel = "info" | "warning" | "danger" | "critical";
export type SignalAction =
  | "alert"
  | "block_new"
  | "reduce"
  | "close_position"
  | "close_all";

export interface RiskSignal {
  id: string;
  source: SignalSource;
  type: string;
  level: SignalLevel;
  exchange?: string;
  symbol?: string;
  payload: Record<string, unknown>;
  action?: SignalAction;
  timestamp: number;
}

// ─── Drawdown ─────────────────────────────────────────────────────

export type DrawdownLevel =
  | "NORMAL"
  | "WARNING"
  | "DANGER"
  | "CRITICAL"
  | "MAX_PEAK"
  | "PER_TRADE";

export interface DrawdownSignal extends RiskSignal {
  source: "drawdown";
  type:
    | "DD_WARNING"
    | "DD_DANGER"
    | "DD_CRITICAL"
    | "DD_MAX_PEAK"
    | "DD_PER_TRADE";
  payload: {
    currentEquity: number;
    peakEquity: number;
    dailyStartEquity: number;
    drawdownPct: number;
    dailyDrawdownPct: number;
    affectedPosition?: {
      exchange: string;
      symbol: string;
      side: "long" | "short";
      drawdownPct: number;
    };
  };
}

export interface DrawdownState {
  equity: number;
  peakEquity: number;
  dailyStartEquity: number;
  dailyResetTime: number;
  peakDrawdownPct: number;
  dailyDrawdownPct: number;
  currentLevel: DrawdownLevel;
  isTradeBlocked: boolean;
}

// ─── Levels ───────────────────────────────────────────────────────

export interface PriceLevel {
  price: number;
  type: "support" | "resistance";
  source: "orderbook" | "swing" | "both";
  strength: number;
  timeframe?: string;
  volume?: number;
  touches: number;
  lastTouchTime: number;
  isSuspectedSpoof: boolean;
  exchange: string;
  symbol: string;
}

export interface LiquidityZone {
  priceFrom: number;
  priceTo: number;
  side: "bid" | "ask";
  totalVolume: number;
  levelCount: number;
  exchange: string;
  symbol: string;
}

// ─── Volatility ───────────────────────────────────────────────────

export type VolatilityRegime =
  | "LOW_VOL"
  | "NORMAL"
  | "HIGH_VOL"
  | "EXTREME_VOL";

export interface VolatilityData {
  exchange: string;
  symbol: string;
  atr: number;
  atrPercent: number;
  historicalVol: number;
  realtimeVol: number;
  regime: VolatilityRegime;
  percentile: number;
  timestamp: number;
}

// ─── Correlation ──────────────────────────────────────────────────

export interface CorrelationMatrix {
  symbols: string[];
  matrix: number[][];
  timeframe: string;
  periods: number;
  timestamp: number;
}

// ─── Exposure ─────────────────────────────────────────────────────

export type ExposureSignalType =
  | "EXP_HIGH"
  | "EXP_IMBALANCE"
  | "EXP_CONCENTRATED"
  | "EXP_EXCHANGE_RISK";

export interface PositionSummary {
  exchange: string;
  symbol: string;
  side: "long" | "short";
  notional: number;
  unrealizedPnl: number;
  leverage: number;
}

export interface ExposureSnapshot {
  netExposure: number;
  grossExposure: number;
  exposureRatio: number;
  equity: number;
  byExchange: Record<string, { long: number; short: number; net: number }>;
  byAsset: Record<string, { long: number; short: number; net: number }>;
  positions: PositionSummary[];
  timestamp: number;
}

// ─── Microstructure ───────────────────────────────────────────────

export interface MicrostructureData {
  exchange: string;
  symbol: string;
  ofi: number; // Order Flow Imbalance
  bookImbalance: number; // -1 to 1
  cvd: number; // Cumulative Volume Delta
  vpin: number; // Order flow toxicity (0 to 1)
  liquidityVoids: LiquidityVoid[];
  buyVolume: number;
  sellVolume: number;
  buyCount: number;
  sellCount: number;
  avgTradeSize: number;
  timestamp: number;
  // Becomes true once the analyzer has enough trades or warmed for
  // long enough. UIs treat false as "warming up".
  ready: boolean;
}

// ─── Footprint ───────────────────────────────────────────────────

export interface FootprintLevel {
  price: number;
  buy: number;
  sell: number;
}

export interface FootprintCandle {
  startMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  poc: number;
  levels: FootprintLevel[];
}

export interface FootprintSnapshot {
  exchange: string;
  symbol: string;
  timeframeMs: number;
  tickSize: number;
  candles: FootprintCandle[];
  timestamp: number;
}

export interface LiquidityVoid {
  priceFrom: number;
  priceTo: number;
  gapSizePct: number;
  side: "bid" | "ask" | "mid";
}

// ─── Alerts ───────────────────────────────────────────────────────

export type AlertChannelType = "ui" | "telegram" | "webhook";

export interface AlertRule {
  id: string;
  enabled: boolean;
  signalType: string;
  channels: AlertChannelType[];
  cooldownMs: number;
}

// ─── Config ───────────────────────────────────────────────────────

export interface RiskEngineConfig {
  redis: { url: string };
  exchanges: string[];
  symbols: string[];
  pollIntervalMs: number;
  drawdown: {
    warningPct: number;
    dangerPct: number;
    criticalPct: number;
    maxPeakPct: number;
    perTradePct: number;
  };
  exposure: {
    highRatio: number;
    imbalanceThreshold: number;
    concentrationThreshold: number;
    exchangeRiskThreshold: number;
  };
  volatility: {
    atrPeriod: number;
    histVolPeriod: number;
    realtimeTickWindow: number;
    percentileWindowDays: number;
  };
  levels: {
    wallThreshold: number;
    clusterTolerance: number;
    spoofLifetimeMs: number;
    spoofFlickerCount: number;
    ohlcvTimeframes: string[];
    swingLookback: number;
  };
  microstructure: {
    tradeWindowMs: number;
    imbalanceDepth: number;
    vpinBucketVolume: number; // Volume per bucket
    vpinBucketCount: number; // Window size in buckets
  };
  footprint: {
    timeframeMs: number; // candle width
    maxCandles: number; // ring buffer length
    tickMultiplier: number; // price bucket = exchange tickSize * multiplier
  };
  heatmap: {
    intervalMs: number; // snapshot cadence
    windowMs: number; // rolling history length
  };
  alerts: {
    telegramBotToken?: string;
    telegramChatId?: string;
    webhookUrl?: string;
    defaultCooldownMs: number;
  };
  logLevel: string;
}
