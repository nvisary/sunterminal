import { create } from 'zustand';

export interface PanelConfig {
  exchange: string;
  symbol: string;
}

interface PanelsStore {
  panels: PanelConfig[];
  activePanel: number;
  setActivePanel: (i: number) => void;
  updatePanel: (idx: number, update: Partial<PanelConfig>) => void;
  addPanel: (symbol: string, exchange: string) => void;
  removePanel: (idx: number) => void;
}

export const usePanelsStore = create<PanelsStore>((set) => ({
  panels: [
    { exchange: 'bybit', symbol: 'BTC/USDT:USDT' },
    { exchange: 'bybit', symbol: 'ETH/USDT:USDT' },
  ],
  activePanel: 0,
  setActivePanel: (i) => set({ activePanel: i }),
  updatePanel: (idx, update) =>
    set((s) => ({
      panels: s.panels.map((p, i) => (i === idx ? { ...p, ...update } : p)),
    })),
  addPanel: (symbol, exchange) =>
    set((s) => ({
      panels: [...s.panels, { exchange, symbol }],
      activePanel: s.panels.length,
    })),
  removePanel: (idx) =>
    set((s) => {
      if (s.panels.length <= 1) return s;
      const panels = s.panels.filter((_, i) => i !== idx);
      return { panels, activePanel: Math.min(s.activePanel, panels.length - 1) };
    }),
}));
