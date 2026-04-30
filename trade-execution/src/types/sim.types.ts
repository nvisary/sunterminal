import type { OrderRequest, TradeRecord } from "./trade.types.ts";

export interface SimAccountState {
  accountId: string;
  initialEquity: number;
  cashUSDT: number; // free cash (collateral pool, perps don't lock notional)
  realizedPnl: number;
  peakEquity: number;
  dailyStartEquity: number;
  dailyStartedAt: number;
  createdAt: number;
  resetAt: number;
}

export interface SimAccountSnapshot extends SimAccountState {
  equity: number; // cash + sum of unrealized
  unrealizedPnl: number;
  openPositions: number;
}

/** Open sim-position. Stored in `sim:positions:{accountId}` hash, key=tradeId. */
export interface SimPositionRecord extends TradeRecord {
  markPrice: number;
  unrealizedPnl: number;
  lastFundingAccrualAt: number;
}

/** Open sim limit order. Stored in `sim:open-orders:{accountId}` hash. */
export interface SimOpenOrder {
  id: string;
  accountId: string;
  exchange: string;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  amount: number;
  reduceOnly: boolean;
  // For position-opening orders, the planned SL/TP/leverage to apply on fill
  stopLoss?: number;
  takeProfit?: number;
  leverage?: number;
  riskAmount?: number;
  createdAt: number;
}

export interface SimFillResult {
  filled: boolean;
  filledAmount: number;
  averagePrice: number;
  slippagePct: number;
  fees: number;
  reason?: string;
}

export interface SimOpenTradeRequest {
  accountId: string;
  exchange: string;
  symbol: string;
  side: "buy" | "sell";
  strategy?: "market" | "limit";
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  leverage?: number;
  riskPercent?: number;
}

export interface SimCloseTradeRequest {
  accountId: string;
  tradeId: string;
}

/** Re-export for convenience */
export type { OrderRequest };
