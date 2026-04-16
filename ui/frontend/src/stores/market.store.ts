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

export const useMarketStore = create<MarketStore>((set) => ({
  tickers: new Map(),
  orderbooks: new Map(),
  setTicker: (key, ticker) =>
    set((state) => {
      const map = new Map(state.tickers);
      map.set(key, ticker);
      return { tickers: map };
    }),
  setOrderbook: (key, ob) =>
    set((state) => {
      const map = new Map(state.orderbooks);
      map.set(key, ob);
      return { orderbooks: map };
    }),
}));
