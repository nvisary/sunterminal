import { create } from 'zustand';

export interface LiquidityVoid {
  priceFrom: number;
  priceTo: number;
  gapSizePct: number;
  side: 'bid' | 'ask' | 'mid';
}

export interface MicrostructureData {
  exchange: string;
  symbol: string;
  ofi: number;
  bookImbalance: number;
  cvd: number;
  vpin: number;
  liquidityVoids: LiquidityVoid[];
  buyVolume: number;
  sellVolume: number;
  buyCount: number;
  sellCount: number;
  avgTradeSize: number;
  timestamp: number;
  ready?: boolean;
}

interface MicrostructureStore {
  data: Map<string, MicrostructureData>;
  setData: (key: string, data: MicrostructureData) => void;
}

export const useMicrostructureStore = create<MicrostructureStore>((set) => ({
  data: new Map(),
  setData: (key, data) =>
    set((state) => {
      const map = new Map(state.data);
      map.set(key, data);
      return { data: map };
    }),
}));
