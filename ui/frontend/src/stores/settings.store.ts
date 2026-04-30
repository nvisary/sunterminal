import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type TradeMode = 'live' | 'sim';

interface SettingsStore {
  mode: TradeMode;
  /** Sim runtime config — kept in sync with backend GET /api/sim/config */
  simInitialEquity: number;
  simTakerFeePct: number;
  simMakerFeePct: number;
  setMode: (mode: TradeMode) => void;
  setSimConfig: (cfg: Partial<Pick<SettingsStore, 'simInitialEquity' | 'simTakerFeePct' | 'simMakerFeePct'>>) => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      mode: 'sim',
      simInitialEquity: 1000,
      simTakerFeePct: 0.05,
      simMakerFeePct: 0.02,
      setMode: (mode) => set({ mode }),
      setSimConfig: (cfg) => set((s) => ({ ...s, ...cfg })),
    }),
    {
      name: 'sun-settings',
      partialize: (s) => ({
        mode: s.mode,
        simInitialEquity: s.simInitialEquity,
        simTakerFeePct: s.simTakerFeePct,
        simMakerFeePct: s.simMakerFeePct,
      }),
    },
  ),
);
