import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LayoutItem, Layout } from 'react-grid-layout';

export type { LayoutItem, Layout };

export interface WidgetConfig {
  id: string;
  type: string;
  title: string;
  props?: Record<string, unknown>;
}

export interface Pane {
  id: string;
  name: string;
  widgets: WidgetConfig[];
  layout: LayoutItem[];
}

export const WIDGET_REGISTRY: Record<string, { title: string; defaultW: number; defaultH: number; minW?: number; minH?: number }> = {
  orderbook: { title: 'Order Book', defaultW: 4, defaultH: 8, minW: 3, minH: 4 },
  trades: { title: 'Tape', defaultW: 8, defaultH: 3, minW: 3, minH: 2 },
  volumeProfile: { title: 'Volume Profile', defaultW: 3, defaultH: 8, minW: 2, minH: 4 },
  funding: { title: 'Funding', defaultW: 3, defaultH: 4, minW: 2, minH: 3 },
  volatility: { title: 'Volatility / ATR', defaultW: 3, defaultH: 4, minW: 2, minH: 3 },
  levels: { title: 'Key Levels', defaultW: 3, defaultH: 6, minW: 2, minH: 4 },
  chart: { title: 'Sparkline', defaultW: 4, defaultH: 3, minW: 3, minH: 2 },
  candleChart: { title: 'Candle Chart', defaultW: 6, defaultH: 7, minW: 4, minH: 5 },
  tradeForm: { title: 'Trade Form', defaultW: 3, defaultH: 5, minW: 2, minH: 3 },
  drawdown: { title: 'Drawdown', defaultW: 3, defaultH: 4, minW: 2, minH: 3 },
  exposure: { title: 'Exposure', defaultW: 3, defaultH: 4, minW: 2, minH: 3 },
  alerts: { title: 'Alerts', defaultW: 6, defaultH: 4, minW: 3, minH: 2 },
  hedge: { title: 'Hedge Engine', defaultW: 6, defaultH: 4, minW: 3, minH: 2 },
};

function makeDefaultPane(id: string, name: string): Pane {
  return {
    id, name,
    widgets: [
      { id: `${id}_ob1`, type: 'orderbook', title: 'BTC Order Book', props: { panelIndex: 0 } },
      { id: `${id}_ob2`, type: 'orderbook', title: 'ETH Order Book', props: { panelIndex: 1 } },
      { id: `${id}_chart1`, type: 'chart', title: 'BTC Sparkline', props: { panelIndex: 0 } },
      { id: `${id}_chart2`, type: 'chart', title: 'ETH Sparkline', props: { panelIndex: 1 } },
      { id: `${id}_trades`, type: 'trades', title: 'Trades' },
      { id: `${id}_form`, type: 'tradeForm', title: 'Trade' },
      { id: `${id}_dd`, type: 'drawdown', title: 'Drawdown' },
      { id: `${id}_exp`, type: 'exposure', title: 'Exposure' },
      { id: `${id}_alerts`, type: 'alerts', title: 'Alerts' },
      { id: `${id}_hedge`, type: 'hedge', title: 'Hedge' },
    ],
    layout: [
      { i: `${id}_ob1`, x: 0, y: 0, w: 4, h: 8, minW: 3, minH: 4 },
      { i: `${id}_ob2`, x: 4, y: 0, w: 4, h: 8, minW: 3, minH: 4 },
      { i: `${id}_chart1`, x: 0, y: 8, w: 4, h: 3, minW: 3, minH: 2 },
      { i: `${id}_chart2`, x: 4, y: 8, w: 4, h: 3, minW: 3, minH: 2 },
      { i: `${id}_trades`, x: 0, y: 14, w: 8, h: 4, minW: 4, minH: 3 },
      { i: `${id}_form`, x: 8, y: 5, w: 4, h: 3, minW: 2, minH: 3 },
      { i: `${id}_dd`, x: 8, y: 8, w: 2, h: 3, minW: 2, minH: 3 },
      { i: `${id}_exp`, x: 10, y: 8, w: 2, h: 3, minW: 2, minH: 3 },
      { i: `${id}_alerts`, x: 0, y: 11, w: 6, h: 3, minW: 3, minH: 2 },
      { i: `${id}_hedge`, x: 6, y: 11, w: 6, h: 3, minW: 3, minH: 2 },
    ],
  };
}

function makeChartPane(id: string, name: string): Pane {
  return {
    id, name,
    widgets: [
      { id: `${id}_candle`, type: 'candleChart', title: 'BTC Chart' },
      { id: `${id}_trades`, type: 'trades', title: 'Trades' },
      { id: `${id}_alerts`, type: 'alerts', title: 'Alerts' },
    ],
    layout: [
      { i: `${id}_candle`, x: 0, y: 0, w: 8, h: 10, minW: 4, minH: 5 },
      { i: `${id}_trades`, x: 0, y: 10, w: 8, h: 4, minW: 4, minH: 3 },
      { i: `${id}_alerts`, x: 8, y: 6, w: 4, h: 4, minW: 3, minH: 2 },
    ],
  };
}

const DEFAULT_PANES: Pane[] = [
  makeDefaultPane('scalper', 'Scalper'),
  makeChartPane('chart', 'Chart'),
];

interface LayoutStore {
  panes: Pane[];
  activePaneId: string;
  sidebarOpen: boolean;
  setActivePane: (id: string) => void;
  setLayout: (layout: Layout) => void;
  addWidget: (type: string) => void;
  removeWidget: (id: string) => void;
  addPane: (name: string) => void;
  removePane: (id: string) => void;
  renamePane: (id: string, name: string) => void;
  renameWidget: (id: string, title: string) => void;
  resetLayout: () => void;
  toggleSidebar: () => void;
  // Derived getters
  activePane: () => Pane;
}

let counter = Date.now();

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set, get) => ({
      panes: DEFAULT_PANES,
      activePaneId: DEFAULT_PANES[0]!.id,
      sidebarOpen: false,

      setActivePane: (id) => set({ activePaneId: id }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

      setLayout: (layout) =>
        set((s) => ({
          panes: s.panes.map((p) =>
            p.id === s.activePaneId ? { ...p, layout: [...layout] } : p
          ),
        })),

      addWidget: (type) => {
        const reg = WIDGET_REGISTRY[type];
        if (!reg) return;
        const id = `${type}_${++counter}`;
        set((s) => ({
          panes: s.panes.map((p) =>
            p.id === s.activePaneId
              ? {
                  ...p,
                  widgets: [...p.widgets, { id, type, title: reg.title }],
                  layout: [...p.layout, {
                    i: id, x: 0, y: 999,
                    w: reg.defaultW, h: reg.defaultH,
                    minW: reg.minW, minH: reg.minH,
                  }],
                }
              : p
          ),
        }));
      },

      removeWidget: (id) =>
        set((s) => ({
          panes: s.panes.map((p) =>
            p.id === s.activePaneId
              ? {
                  ...p,
                  widgets: p.widgets.filter((w) => w.id !== id),
                  layout: p.layout.filter((l) => l.i !== id),
                }
              : p
          ),
        })),

      addPane: (name) => {
        const id = `pane_${++counter}`;
        set((s) => ({
          panes: [...s.panes, { id, name, widgets: [], layout: [] }],
          activePaneId: id,
        }));
      },

      removePane: (id) =>
        set((s) => {
          if (s.panes.length <= 1) return s;
          const panes = s.panes.filter((p) => p.id !== id);
          return {
            panes,
            activePaneId: s.activePaneId === id ? panes[0]!.id : s.activePaneId,
          };
        }),

      renamePane: (id, name) =>
        set((s) => ({
          panes: s.panes.map((p) => (p.id === id ? { ...p, name } : p)),
        })),

      renameWidget: (id, title) =>
        set((s) => ({
          panes: s.panes.map((p) =>
            p.id === s.activePaneId
              ? { ...p, widgets: p.widgets.map((w) => w.id === id ? { ...w, title } : w) }
              : p
          ),
        })),

      resetLayout: () => set({ panes: DEFAULT_PANES.map((p) => ({ ...p, layout: [...p.layout], widgets: [...p.widgets] })), activePaneId: DEFAULT_PANES[0]!.id }),

      activePane: () => {
        const s = get();
        return s.panes.find((p) => p.id === s.activePaneId) ?? s.panes[0]!;
      },
    }),
    {
      name: 'sun-layout',
      partialize: (s) => ({ panes: s.panes, activePaneId: s.activePaneId, sidebarOpen: s.sidebarOpen }),
    },
  ),
);
