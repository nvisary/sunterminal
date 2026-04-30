import { create } from 'zustand';

export interface SimAccount {
  accountId: string;
  initialEquity: number;
  cashUSDT: number;
  realizedPnl: number;
  peakEquity: number;
  dailyStartEquity: number;
  createdAt: number;
  resetAt: number;
  equity: number;
  unrealizedPnl: number;
  openPositions: number;
}

export interface SimPosition {
  id: string;
  exchange: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  size: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number | null;
  fees: number;
  fundingPaid: number;
  openedAt: number;
  markPrice?: number;
  unrealizedPnl?: number;
}

export interface SimDrawdown {
  equity: number;
  peakEquity: number;
  dailyDrawdownPct: number;
  peakDrawdownPct: number;
  currentLevel: 'NORMAL' | 'WARNING' | 'DANGER' | 'CRITICAL' | 'MAX_PEAK';
  isTradeBlocked: boolean;
}

export interface SimExposure {
  equity: number;
  unrealizedPnl: number;
  grossExposure: number;
  netExposure: number;
  exposureRatio: number;
  openPositions: number;
}

interface SimStore {
  account: SimAccount | null;
  positions: SimPosition[];
  drawdown: SimDrawdown | null;
  exposure: SimExposure | null;
  setAccount: (a: SimAccount | null) => void;
  setPositions: (p: SimPosition[]) => void;
  setDrawdown: (d: SimDrawdown) => void;
  setExposure: (e: SimExposure) => void;
}

export const useSimStore = create<SimStore>((set) => ({
  account: null,
  positions: [],
  drawdown: null,
  exposure: null,
  setAccount: (a) => set({ account: a }),
  setPositions: (p) => set({ positions: p }),
  setDrawdown: (d) => set({ drawdown: d }),
  setExposure: (e) => set({ exposure: e }),
}));
