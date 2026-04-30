import { create } from 'zustand';
import { useEffect } from 'react';
import { API_BASE } from '../lib/ws-client';

export interface MarketInfo {
  symbol: string;
  base: string | null;
  quote: string | null;
  type: string | null;
  active: boolean;
  tickSize: number | null;
  amountStep: number | null;
  pricePrecision: number | null;
  amountPrecision: number | null;
  minQty: number | null;
  minCost: number | null;
  contractSize: number;
  makerFee: number | null;
  takerFee: number | null;
}

type Entry =
  | { status: 'loading' }
  | { status: 'ready'; info: MarketInfo }
  | { status: 'error'; error: string };

interface MarketInfoStore {
  byKey: Map<string, Entry>;
  load: (exchange: string, symbol: string) => Promise<void>;
  get: (exchange: string, symbol: string) => MarketInfo | null;
}

function keyOf(exchange: string, symbol: string): string {
  return `${exchange}:${symbol}`;
}

export const useMarketInfoStore = create<MarketInfoStore>((set, get) => ({
  byKey: new Map(),
  load: async (exchange, symbol) => {
    const key = keyOf(exchange, symbol);
    const existing = get().byKey.get(key);
    if (existing && existing.status !== 'error') return; // already loading or ready

    set((state) => {
      const map = new Map(state.byKey);
      map.set(key, { status: 'loading' });
      return { byKey: map };
    });

    try {
      const res = await fetch(
        `${API_BASE}/api/markets/${exchange}/${encodeURIComponent(symbol)}/info`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const info = (await res.json()) as MarketInfo;
      set((state) => {
        const map = new Map(state.byKey);
        map.set(key, { status: 'ready', info });
        return { byKey: map };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set((state) => {
        const map = new Map(state.byKey);
        map.set(key, { status: 'error', error: msg });
        return { byKey: map };
      });
    }
  },
  get: (exchange, symbol) => {
    const entry = get().byKey.get(keyOf(exchange, symbol));
    return entry && entry.status === 'ready' ? entry.info : null;
  },
}));

/**
 * Subscribe to market info for a symbol. Triggers a lazy load on first use.
 * Returns null while loading or on error — callers should fall back to defaults.
 */
export function useMarketInfo(exchange: string | null | undefined, symbol: string | null | undefined): MarketInfo | null {
  const load = useMarketInfoStore((s) => s.load);
  const entry = useMarketInfoStore((s) =>
    exchange && symbol ? s.byKey.get(keyOf(exchange, symbol)) : undefined,
  );

  useEffect(() => {
    if (exchange && symbol) {
      void load(exchange, symbol);
    }
  }, [exchange, symbol, load]);

  return entry && entry.status === 'ready' ? entry.info : null;
}
