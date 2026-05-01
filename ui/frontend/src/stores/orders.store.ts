import { create } from 'zustand';
import { API_BASE } from '../lib/ws-client';
import { useSettingsStore } from './settings.store';

export type OrderMode = 'live' | 'sim';

export interface LiveOrder {
  id: string;           // exchange id, sim uuid, or temp 'pending-xxx'
  exchange: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  amount: number;
  mode: OrderMode;
  createdAt: number;
  status: 'pending' | 'open' | 'filled' | 'canceled' | 'rejected';
  error?: string;
}

interface OrdersStore {
  orders: Map<string, LiveOrder>; // id → order
  // Recently canceled ids → expiresAt timestamp. Prevents the 5s poll from
  // resurrecting a just-canceled order before the backend has processed the
  // cancel command (gateway returns 200 as soon as the cmd is queued).
  canceledTombstones: Map<string, number>;
  placeLimit: (p: {
    exchange: string; symbol: string; side: 'buy' | 'sell';
    price: number; amount: number;
  }) => Promise<LiveOrder>;
  cancel: (id: string) => Promise<void>;
  syncOpenOrders: (exchange: string, symbol: string) => Promise<void>;
  getBySymbol: (exchange: string, symbol: string) => LiveOrder[];
}

const CANCEL_TOMBSTONE_TTL_MS = 10_000;

function keyOf(o: { exchange: string; symbol: string }): string {
  return `${o.exchange}:${o.symbol}`;
}

function genTempId(): string {
  return `pending-${Math.random().toString(36).slice(2, 10)}`;
}

function pruneTombstones(prev: Map<string, number>): Map<string, number> {
  const now = Date.now();
  const next = new Map<string, number>();
  for (const [id, expiresAt] of prev) {
    if (expiresAt > now) next.set(id, expiresAt);
  }
  return next;
}

export const useOrdersStore = create<OrdersStore>((set, get) => ({
  orders: new Map(),
  canceledTombstones: new Map(),

  placeLimit: async ({ exchange, symbol, side, price, amount }) => {
    const mode = useSettingsStore.getState().mode;
    const tempId = genTempId();
    const pending: LiveOrder = {
      id: tempId, exchange, symbol, side, price, amount,
      mode, createdAt: Date.now(), status: 'pending',
    };
    set((s) => {
      const m = new Map(s.orders);
      m.set(tempId, pending);
      return { orders: m };
    });

    const url = mode === 'sim'
      ? `${API_BASE}/api/sim/trade/limit`
      : `${API_BASE}/api/trade/limit`;
    const payload = mode === 'sim'
      ? { exchange, symbol, side, price, amount, orderId: tempId }
      : { exchange, symbol, side, price, amount };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json() as { ok: boolean; order?: { id: string }; error?: string };

      if (res.ok && body.ok) {
        // sim: tempId is also the real id (we passed it as orderId).
        // live: backend returns the exchange order id; swap.
        const realId = mode === 'sim' ? tempId : (body.order?.id ?? tempId);
        const placed: LiveOrder = { ...pending, id: realId, status: 'open' };
        set((s) => {
          const m = new Map(s.orders);
          if (realId !== tempId) m.delete(tempId);
          m.set(realId, placed);
          return { orders: m };
        });
        return placed;
      }

      const rejected: LiveOrder = { ...pending, status: 'rejected', error: body.error ?? 'unknown' };
      set((s) => {
        const m = new Map(s.orders);
        m.set(tempId, rejected);
        return { orders: m };
      });
      return rejected;
    } catch (err) {
      const rejected: LiveOrder = { ...pending, status: 'rejected', error: String(err) };
      set((s) => {
        const m = new Map(s.orders);
        m.set(tempId, rejected);
        return { orders: m };
      });
      return rejected;
    }
  },

  cancel: async (id) => {
    const order = get().orders.get(id);
    if (!order) return;

    // Optimistically remove and tombstone the id so the periodic syncOpenOrders
    // poll can't re-insert it before the backend has processed the cancel.
    set((s) => {
      const orders = new Map(s.orders);
      orders.delete(id);
      const tombstones = new Map(s.canceledTombstones);
      tombstones.set(id, Date.now() + CANCEL_TOMBSTONE_TTL_MS);
      return { orders, canceledTombstones: tombstones };
    });

    try {
      if (order.mode === 'sim') {
        await fetch(`${API_BASE}/api/sim/trade/order/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
      } else {
        await fetch(`${API_BASE}/api/trade/order`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exchange: order.exchange, symbol: order.symbol, orderId: id }),
        });
      }
    } catch {
      // Tombstone still suppresses the order for CANCEL_TOMBSTONE_TTL_MS even if
      // the request errored — user can retry, and stale entries GC themselves.
    }
  },

  syncOpenOrders: async (exchange, symbol) => {
    const mode = useSettingsStore.getState().mode;
    try {
      if (mode === 'sim') {
        const res = await fetch(`${API_BASE}/api/sim/open-orders`);
        if (!res.ok) return;
        const list = await res.json() as Array<{
          id: string; exchange: string; symbol: string;
          side: 'buy' | 'sell'; price: number; amount: number;
        }>;
        set((s) => {
          const m = new Map(s.orders);
          const tombstones = pruneTombstones(s.canceledTombstones);
          // Drop sim orders for this symbol (we'll re-populate from server).
          // Keep live orders untouched.
          for (const [id, o] of m) {
            if (o.mode === 'sim' && o.exchange === exchange && o.symbol === symbol) {
              m.delete(id);
            }
          }
          for (const o of list) {
            if (o.exchange !== exchange || o.symbol !== symbol) continue;
            if (!o.id || !o.price || !o.amount) continue;
            if (tombstones.has(o.id)) continue; // recently canceled — backend hasn't caught up yet
            m.set(o.id, {
              id: o.id, exchange: o.exchange, symbol: o.symbol,
              side: o.side, price: o.price, amount: o.amount,
              mode: 'sim', createdAt: Date.now(), status: 'open',
            });
          }
          return { orders: m, canceledTombstones: tombstones };
        });
      } else {
        const res = await fetch(`${API_BASE}/api/trade/open-orders/${exchange}/${encodeURIComponent(symbol)}`);
        if (!res.ok) return;
        const list = await res.json() as Array<{
          id: string; side: string; price: number; amount: number; status?: string;
        }>;
        set((s) => {
          const m = new Map(s.orders);
          const tombstones = pruneTombstones(s.canceledTombstones);
          for (const [id, o] of m) {
            if (o.mode === 'live' && o.exchange === exchange && o.symbol === symbol) m.delete(id);
          }
          for (const o of list) {
            if (!o.id || !o.price || !o.amount) continue;
            if (tombstones.has(o.id)) continue;
            m.set(o.id, {
              id: o.id, exchange, symbol,
              side: (o.side === 'buy' || o.side === 'sell') ? o.side : 'buy',
              price: o.price, amount: o.amount,
              mode: 'live', createdAt: Date.now(), status: 'open',
            });
          }
          return { orders: m, canceledTombstones: tombstones };
        });
      }
    } catch {
      // ignore
    }
  },

  getBySymbol: (exchange, symbol) => {
    const out: LiveOrder[] = [];
    for (const o of get().orders.values()) {
      if (o.exchange === exchange && o.symbol === symbol
          && (o.status === 'open' || o.status === 'pending')) {
        out.push(o);
      }
    }
    return out;
  },
}));

export { keyOf };
