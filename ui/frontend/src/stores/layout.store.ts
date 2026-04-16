import { create } from 'zustand';
import type { LayoutItem, Layout } from 'react-grid-layout';

export type { LayoutItem, Layout };

export interface WidgetConfig {
  id: string;
  type: string;
  title: string;
  props?: Record<string, unknown>;
}

export const WIDGET_REGISTRY: Record<string, { title: string; defaultW: number; defaultH: number; minW?: number; minH?: number }> = {
  orderbook: { title: 'Order Book', defaultW: 4, defaultH: 8, minW: 3, minH: 4 },
  trades: { title: 'Trades', defaultW: 3, defaultH: 6, minW: 2, minH: 3 },
  chart: { title: 'Price Chart', defaultW: 4, defaultH: 3, minW: 3, minH: 2 },
  tradeForm: { title: 'Trade Form', defaultW: 3, defaultH: 5, minW: 2, minH: 3 },
  drawdown: { title: 'Drawdown', defaultW: 3, defaultH: 4, minW: 2, minH: 3 },
  exposure: { title: 'Exposure', defaultW: 3, defaultH: 4, minW: 2, minH: 3 },
  alerts: { title: 'Alerts', defaultW: 6, defaultH: 4, minW: 3, minH: 2 },
  hedge: { title: 'Hedge Engine', defaultW: 6, defaultH: 4, minW: 3, minH: 2 },
};

const DEFAULT_WIDGETS: WidgetConfig[] = [
  { id: 'ob1', type: 'orderbook', title: 'BTC Order Book', props: { panelIndex: 0 } },
  { id: 'ob2', type: 'orderbook', title: 'ETH Order Book', props: { panelIndex: 1 } },
  { id: 'chart1', type: 'chart', title: 'BTC Chart', props: { panelIndex: 0 } },
  { id: 'chart2', type: 'chart', title: 'ETH Chart', props: { panelIndex: 1 } },
  { id: 'trades1', type: 'trades', title: 'Trades' },
  { id: 'form1', type: 'tradeForm', title: 'Trade' },
  { id: 'dd1', type: 'drawdown', title: 'Drawdown' },
  { id: 'exp1', type: 'exposure', title: 'Exposure' },
  { id: 'alerts1', type: 'alerts', title: 'Alerts' },
  { id: 'hedge1', type: 'hedge', title: 'Hedge' },
];

const DEFAULT_LAYOUT: LayoutItem[] = [
  { i: 'ob1', x: 0, y: 0, w: 4, h: 8, minW: 3, minH: 4 },
  { i: 'ob2', x: 4, y: 0, w: 4, h: 8, minW: 3, minH: 4 },
  { i: 'chart1', x: 0, y: 8, w: 4, h: 3, minW: 3, minH: 2 },
  { i: 'chart2', x: 4, y: 8, w: 4, h: 3, minW: 3, minH: 2 },
  { i: 'trades1', x: 8, y: 0, w: 4, h: 5, minW: 2, minH: 3 },
  { i: 'form1', x: 8, y: 5, w: 4, h: 3, minW: 2, minH: 3 },
  { i: 'dd1', x: 8, y: 8, w: 2, h: 3, minW: 2, minH: 3 },
  { i: 'exp1', x: 10, y: 8, w: 2, h: 3, minW: 2, minH: 3 },
  { i: 'alerts1', x: 0, y: 11, w: 6, h: 3, minW: 3, minH: 2 },
  { i: 'hedge1', x: 6, y: 11, w: 6, h: 3, minW: 3, minH: 2 },
];

// Mutable copy for store (library Layout is readonly)
type MutableLayout = LayoutItem[];

interface LayoutStore {
  widgets: WidgetConfig[];
  layout: MutableLayout;
  setLayout: (layout: Layout) => void;
  addWidget: (type: string) => void;
  removeWidget: (id: string) => void;
  resetLayout: () => void;
}

let counter = 100;

export const useLayoutStore = create<LayoutStore>((set) => ({
  widgets: DEFAULT_WIDGETS,
  layout: DEFAULT_LAYOUT,
  setLayout: (layout) => set({ layout: [...layout] }),
  addWidget: (type) => {
    const reg = WIDGET_REGISTRY[type];
    if (!reg) return;
    const id = `${type}_${++counter}`;
    set((s) => ({
      widgets: [...s.widgets, { id, type, title: reg.title }],
      layout: [...s.layout, {
        i: id, x: 0, y: 999,
        w: reg.defaultW, h: reg.defaultH,
        minW: reg.minW, minH: reg.minH,
      }],
    }));
  },
  removeWidget: (id) =>
    set((s) => ({
      widgets: s.widgets.filter((w) => w.id !== id),
      layout: s.layout.filter((l) => l.i !== id),
    })),
  resetLayout: () => set({ widgets: DEFAULT_WIDGETS, layout: [...DEFAULT_LAYOUT] }),
}));
