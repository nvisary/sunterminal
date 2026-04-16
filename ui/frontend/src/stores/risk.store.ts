import { create } from 'zustand';

interface DrawdownState {
  equity: number;
  peakEquity: number;
  dailyDrawdownPct: number;
  peakDrawdownPct: number;
  currentLevel: string;
  isTradeBlocked: boolean;
}

interface ExposureState {
  netExposure: number;
  grossExposure: number;
  exposureRatio: number;
  equity: number;
}

interface Alert {
  id: string;
  source: string;
  type: string;
  level: string;
  message?: string;
  timestamp: number;
}

interface RiskStore {
  drawdown: DrawdownState | null;
  exposure: ExposureState | null;
  alerts: Alert[];
  setDrawdown: (dd: DrawdownState) => void;
  setExposure: (exp: ExposureState) => void;
  addAlert: (alert: Alert) => void;
  clearAlerts: () => void;
}

export const useRiskStore = create<RiskStore>((set) => ({
  drawdown: null,
  exposure: null,
  alerts: [],
  setDrawdown: (dd) => set({ drawdown: dd }),
  setExposure: (exp) => set({ exposure: exp }),
  addAlert: (alert) =>
    set((state) => ({
      alerts: [...state.alerts.slice(-99), alert],
    })),
  clearAlerts: () => set({ alerts: [] }),
}));
