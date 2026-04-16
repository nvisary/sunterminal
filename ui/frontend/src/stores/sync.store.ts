import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const SYNC_GROUPS = [
  { id: '1', color: '#3b82f6', label: 'Blue' },
  { id: '2', color: '#ef4444', label: 'Red' },
  { id: '3', color: '#22c55e', label: 'Green' },
  { id: '4', color: '#f59e0b', label: 'Yellow' },
  { id: '5', color: '#a855f7', label: 'Purple' },
  { id: '6', color: '#06b6d4', label: 'Cyan' },
] as const;

export type SyncGroupId = typeof SYNC_GROUPS[number]['id'] | null;

interface SyncGroupState {
  exchange: string;
  symbol: string;
}

interface SyncStore {
  // Widget -> group assignment: widgetId -> groupId
  assignments: Record<string, SyncGroupId>;
  // Group symbol state: groupId -> { exchange, symbol }
  groupState: Record<string, SyncGroupState>;
  // Assign widget to a group (null = independent)
  setWidgetGroup: (widgetId: string, groupId: SyncGroupId) => void;
  // Update symbol for a group (all widgets in group follow)
  setGroupSymbol: (groupId: string, exchange: string, symbol: string) => void;
  // Get resolved exchange/symbol for a widget
  getWidgetSymbol: (widgetId: string, fallbackExchange: string, fallbackSymbol: string) => SyncGroupState;
}

const DEFAULT_GROUP_STATE: Record<string, SyncGroupState> = {
  '1': { exchange: 'bybit', symbol: 'BTC/USDT:USDT' },
  '2': { exchange: 'bybit', symbol: 'ETH/USDT:USDT' },
  '3': { exchange: 'bybit', symbol: 'SOL/USDT:USDT' },
  '4': { exchange: 'bybit', symbol: 'BTC/USDT:USDT' },
  '5': { exchange: 'bybit', symbol: 'BTC/USDT:USDT' },
  '6': { exchange: 'bybit', symbol: 'BTC/USDT:USDT' },
};

export const useSyncStore = create<SyncStore>()(
  persist(
    (set, get) => ({
      assignments: {},
      groupState: DEFAULT_GROUP_STATE,

      setWidgetGroup: (widgetId, groupId) =>
        set((s) => ({ assignments: { ...s.assignments, [widgetId]: groupId } })),

      setGroupSymbol: (groupId, exchange, symbol) =>
        set((s) => ({
          groupState: { ...s.groupState, [groupId]: { exchange, symbol } },
        })),

      getWidgetSymbol: (widgetId, fallbackExchange, fallbackSymbol) => {
        const s = get();
        const groupId = s.assignments[widgetId];
        if (groupId && s.groupState[groupId]) {
          return s.groupState[groupId];
        }
        return { exchange: fallbackExchange, symbol: fallbackSymbol };
      },
    }),
    {
      name: 'sun-sync',
      partialize: (s) => ({ assignments: s.assignments, groupState: s.groupState }),
    },
  ),
);
