import { create } from 'zustand';

interface Ticker {
  exchange: string;
  symbol: string;
  price: number;
  side: string;
  timestamp: number;
}

export interface OrderBook {
  bids: number[][];
  asks: number[][];
  exchange: string;
  symbol: string;
  timestamp: number;
}

interface MarketStore {
  tickers: Map<string, Ticker>;
  orderbooks: Map<string, OrderBook>;
  setTicker: (key: string, ticker: Ticker) => void;
  setOrderbook: (key: string, ob: OrderBook) => void;
}

// rAF-coalesced orderbook updates. Exchanges push 10-50 snapshots/sec; React
// can't repaint faster than the monitor anyway, so we collapse multiple updates
// per frame into one — keeps the DOM smooth and cuts wasted commits.
const pendingObs = new Map<string, OrderBook>();
let obRaf: number | null = null;

export const useMarketStore = create<MarketStore>((set) => ({
  tickers: new Map(),
  orderbooks: new Map(),
  setTicker: (key, ticker) =>
    set((state) => {
      const map = new Map(state.tickers);
      map.set(key, ticker);
      return { tickers: map };
    }),
  setOrderbook: (key, ob) => {
    pendingObs.set(key, ob);
    if (obRaf !== null) return;
    obRaf = requestAnimationFrame(() => {
      obRaf = null;
      set((state) => {
        const map = new Map(state.orderbooks);
        for (const [k, v] of pendingObs) map.set(k, v);
        pendingObs.clear();
        return { orderbooks: map };
      });
    });
  },
}));
