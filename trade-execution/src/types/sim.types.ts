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
  /**
   * Visible volume sitting ahead of us in the queue at this price level at
   * placement time. The matcher decrements this on every aggressor trade at
   * the limit price and only fills when it reaches zero (or the market price
   * strictly crosses through the limit). Models "wait your turn" so a freshly
   * placed limit at the touch doesn't vanish on the very next print.
   * Optional for backwards compatibility with orders persisted before this
   * field existed — undefined is treated as zero (fills on first touch).
   */
  volumeAhead?: number;
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

// ─── UI event stream (sim:events) ─────────────────────────────────
//
// Every state change the UI needs to reflect is published as an event here.
// The UI maintains a local model and applies these deltas — it never polls
// and replaces. This eliminates the wipe-and-readd flicker that plagued the
// poll-based design.
//
// All payloads are self-contained so a client can subscribe mid-stream and
// catch up via snapshot endpoints, then apply subsequent events idempotently.

export type SimEvent =
  | {
      type: "order-placed";
      at: number;
      order: SimOpenOrder;
    }
  | {
      type: "order-canceled";
      at: number;
      orderId: string;
    }
  | {
      type: "order-filled";
      at: number;
      orderId: string;
      tradeId: string;
      fillPrice: number;
      fillAmount: number;
    }
  | {
      type: "order-rejected";
      at: number;
      orderId: string;
      reason: string;
    }
  | {
      // Position was newly opened (or appeared after a flip).
      type: "position-opened";
      at: number;
      position: TradeRecord;
    }
  | {
      // Position size / SL / TP changed (e.g. averaged up, partial close).
      // UI just replaces its local copy by id.
      type: "position-updated";
      at: number;
      position: TradeRecord;
    }
  | {
      type: "position-closed";
      at: number;
      positionId: string;
      exitPrice: number;
      realizedPnl: number;
    }
  | {
      type: "account-updated";
      at: number;
      account: SimAccountSnapshot;
    };
