// ─── Order ─────────────────────────────────────────────────────────

export type OrderStrategy = "market" | "limit" | "twap" | "iceberg" | "sniper";
export type OrderStatus = "pending" | "partial" | "filled" | "cancelled" | "rejected" | "error";
export type GuardLevel = "block" | "warning" | "off";

export interface OrderRequest {
  exchange: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  amount: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  strategy: OrderStrategy;
  reduceOnly?: boolean;
  leverage?: number;
}

export interface OrderState {
  id: string;
  request: OrderRequest;
  status: OrderStatus;
  exchangeOrderIds: string[];
  filledAmount: number;
  averagePrice: number;
  slippage: number;
  fees: number;
  createdAt: number;
  updatedAt: number;
}

// ─── Position Sizer ───────────────────────────────────────────────

export interface PositionSizeResult {
  positionSizeUSD: number;
  positionSizeBase: number;
  riskAmount: number;
  stopLoss: number;
  takeProfit?: number;
  leverage: number;
  requiredMargin: number;
  riskRewardRatio?: number;
  warnings: string[];
}

// ─── Pre-Trade Guard ──────────────────────────────────────────────

export interface GuardCheck {
  name: string;
  type: "block" | "warning";
  message: string;
}

export interface PreTradeResult {
  allowed: boolean;
  blocks: GuardCheck[];
  warnings: GuardCheck[];
}

// ─── Trade Journal ────────────────────────────────────────────────

export type TradeMode = "live" | "sim";

export interface TradeRecord {
  id: string;
  mode: TradeMode;
  accountId: string;
  exchange: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number | null;
  size: number;
  leverage: number;
  realizedPnl: number | null;
  fees: number;
  fundingPaid: number;
  netPnl: number | null;
  stopLoss: number;
  takeProfit: number | null;
  riskAmount: number;
  strategy: string;
  slippage: number;
  volatilityRegime: string;
  fundingRate: number;
  portfolioDrawdown: number;
  openedAt: number;
  closedAt: number | null;
  duration: number | null;
  tags: string[];
  notes: string;
}

export interface PnLStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  expectancy: number;
  maxConsecutiveLosses: number;
  totalPnl: number;
  totalFees: number;
  totalFunding: number;
  netPnl: number;
  avgSlippage: number;
  period: string;
}

export interface EquityPoint {
  equity: number;
  timestamp: number;
}

// ─── Config ───────────────────────────────────────────────────────

export interface TradeConfig {
  redis: { url: string };
  positionSizer: {
    riskPerTrade: number;
    maxPositionUSD: number;
    maxOpenPositions: number;
    defaultLeverage: number;
    atrMultiplier: number;
    marginReserve: number;
  };
  smartOrder: {
    defaultStrategy: "market" | "limit";
    limitTimeout: number;
    maxSlippage: number;
  };
  guards: {
    riskEngineBlock: GuardLevel;
    hedgeLock: GuardLevel;
    balanceCheck: GuardLevel;
    maxPositions: GuardLevel;
    volatilityRegime: GuardLevel;
    levelProximity: GuardLevel;
    fundingCost: GuardLevel;
  };
  sim: {
    accountId: string;
    initialEquity: number;
    takerFeePct: number; // e.g. 0.05 = 0.05%
    makerFeePct: number; // e.g. 0.02 = 0.02%
    slippageFallbackPct: number; // applied when orderbook walk impossible
    fundingIntervalMs: number; // accrual cadence
    markToMarketIntervalMs: number;
    drawdownWarningPct: number;
    drawdownDangerPct: number;
    drawdownCriticalPct: number;
    drawdownMaxPeakPct: number;
  };
  logLevel: string;
}
