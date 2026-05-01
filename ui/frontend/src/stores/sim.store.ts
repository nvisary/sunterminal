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
  // Recently closed position ids → expiresAt. The close cmd is async (gateway
  // XADDs and returns 200 immediately, sim-engine processes a few ms later),
  // so a concurrent /api/sim/positions read can briefly still see the position
  // and resurrect it via setPositions. Tombstones suppress that window.
  closedTombstones: Map<string, number>;
  setAccount: (a: SimAccount | null) => void;
  setPositions: (p: SimPosition[]) => void;
  markPositionsClosing: (ids: string[]) => void;
  setDrawdown: (d: SimDrawdown) => void;
  setExposure: (e: SimExposure) => void;
}

const POSITION_TOMBSTONE_TTL_MS = 10_000;

function pruneTombstones(prev: Map<string, number>): Map<string, number> {
  const now = Date.now();
  const next = new Map<string, number>();
  for (const [id, expiresAt] of prev) {
    if (expiresAt > now) next.set(id, expiresAt);
  }
  return next;
}

export const useSimStore = create<SimStore>((set) => ({
  account: null,
  positions: [],
  drawdown: null,
  exposure: null,
  closedTombstones: new Map(),
  setAccount: (a) => set({ account: a }),
  setPositions: (p) => set((s) => {
    const tombstones = pruneTombstones(s.closedTombstones);
    return {
      positions: tombstones.size > 0 ? p.filter((pos) => !tombstones.has(pos.id)) : p,
      closedTombstones: tombstones,
    };
  }),
  markPositionsClosing: (ids) => set((s) => {
    if (ids.length === 0) return s;
    const tombstones = pruneTombstones(s.closedTombstones);
    const expiresAt = Date.now() + POSITION_TOMBSTONE_TTL_MS;
    for (const id of ids) tombstones.set(id, expiresAt);
    return {
      positions: s.positions.filter((p) => !tombstones.has(p.id)),
      closedTombstones: tombstones,
    };
  }),
  setDrawdown: (d) => set({ drawdown: d }),
  setExposure: (e) => set({ exposure: e }),
}));
