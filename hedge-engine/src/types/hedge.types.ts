// ─── Operating Modes ──────────────────────────────────────────────

export type HedgeMode = "advisor" | "controller";
export type HedgeStatus = "idle" | "active" | "emergency" | "locked";

// ─── Hedge State (published to UI) ───────────────────────────────

export interface HedgeState {
  mode: HedgeMode;
  status: HedgeStatus;
  strategies: {
    autoHedge: {
      enabled: boolean;
      mode: HedgeMode;
      activeHedges: HedgePosition[];
      totalHedgeSize: number;
      dailyFundingCost: number;
      lastCheck: number;
    };
    deltaNeutral: {
      enabled: boolean;
      mode: HedgeMode;
      currentDelta: number;
      targetDelta: number;
      lastRebalance: number;
    };
    emergencyExit: {
      enabled: boolean;
      manualButtonActive: true;
      lastTriggered: number | null;
    };
  };
  timestamp: number;
}

// ─── Hedge Position ───────────────────────────────────────────────

export interface HedgePosition {
  id: string;
  exchange: string;
  symbol: string;
  side: "long" | "short";
  size: number;           // USD notional
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  fundingPaid: number;
  openedAt: number;
  reason: string;
}

// ─── Hedge Action (action log) ────────────────────────────────────

export type ActionType = "open_hedge" | "close_hedge" | "rebalance" | "emergency_exit" | "cancel_orders";
export type StrategyName = "auto_hedge" | "delta_neutral" | "emergency";
export type ActionMode = "executed" | "recommended";

export interface HedgeAction {
  id: string;
  type: ActionType;
  strategy: StrategyName;
  mode: ActionMode;
  details: {
    exchange: string;
    symbol: string;
    side: "buy" | "sell";
    amount: number;
    price?: number;
    orderId?: string;
    fillPrice?: number;
    slippage?: number;
  };
  reason: string;
  timestamp: number;
}

// ─── Exit Result ──────────────────────────────────────────────────

export interface ExitResult {
  success: boolean;
  closedPositions: number;
  cancelledOrders: number;
  failedPositions: Array<{ exchange: string; symbol: string; error: string }>;
  timestamp: number;
}

// ─── Configuration ────────────────────────────────────────────────

export interface HedgeConfig {
  redis: { url: string };
  exchanges: string[];
  globalMode: HedgeMode;

  autoHedge: {
    enabled: boolean;
    mode: HedgeMode;
    hedgeThreshold: number;
    unhedgeThreshold: number;
    hedgeRatio: number;
    hedgeExchange: string | "auto";
    maxHedgeSize: number;
    checkInterval: number;
    maxCostPercent: number;
  };

  deltaNeutral: {
    enabled: boolean;
    mode: HedgeMode;
    targetDelta: number;
    deltaThreshold: number;
    rebalanceInterval: number;
    maxRebalanceSize: number;
    rebalanceExchange: string | "auto";
  };

  emergencyExit: {
    autoTriggerEnabled: boolean;
    triggers: {
      ddCritical: boolean;
      ddMaxPeak: boolean;
      allConnectorsDown: boolean;
      telegramKill: boolean;
    };
    retryAttempts: number;
    retryDelay: number;
  };

  logLevel: string;
}
