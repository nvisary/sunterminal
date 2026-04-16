import { create } from 'zustand';

interface HedgeState {
  mode: string;
  status: string;
  strategies: {
    autoHedge: { enabled: boolean; mode: string; totalHedgeSize: number; dailyFundingCost: number };
    emergencyExit: { enabled: boolean; lastTriggered: number | null };
  };
}

interface HedgeStore {
  state: HedgeState | null;
  setState: (s: HedgeState) => void;
}

export const useHedgeStore = create<HedgeStore>((set) => ({
  state: null,
  setState: (s) => set({ state: s }),
}));
