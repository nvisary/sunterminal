import { create } from 'zustand';
import { API_BASE } from '../lib/ws-client';

export interface LiveOrder {
  id: string;           // exchange id or virtual-xxx
  exchange: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  amount: number;
  virtual: boolean;
  createdAt: number;
  status: 'pending' | 'open' | 'filled' | 'canceled' | 'rejected';
  error?: string;
}

interface OrdersStore {
  orders: Map<string, LiveOrder>; // id → order
  placeLimit: (p: {
    exchange: string; symbol: string; side: 'buy' | 'sell';
    price: number; amount: number; virtual: boolean;
  }) => Promise<LiveOrder>;
  cancel: (id: string) => Promise<void>;
  syncOpenOrders: (exchange: string, symbol: string) => Promise<void>;
  getBySymbol: (exchange: string, symbol: string) => LiveOrder[];
}

function keyOf(o: { exchange: string; symbol: string }): string {
  return `${o.exchange}:${o.symbol}`;
}

export const useOrdersStore = create<OrdersStore>((set, get) => ({
  orders: new Map(),

  placeLimit: async ({ exchange, symbol, side, price, amount, virtual }) => {
    const tempId = `virtual-${Math.random().toString(36).slice(2, 10)}`;
    const pending: LiveOrder = {
      id: tempId, exchange, symbol, side, price, amount,
      virtual, createdAt: Date.now(), status: 'pending',
    };
    set((s) => {
      const m = new Map(s.orders);
      m.set(tempId, pending);
      return { orders: m };
    });

    if (virtual) {
      const open: LiveOrder = { ...pending, status: 'open' };
      set((s) => {
        const m = new Map(s.orders);
        m.set(tempId, open);
        return { orders: m };
      });
      return open;
    }

    try {
      const res = await fetch(`${API_BASE}/api/trade/limit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange, symbol, side, price, amount }),
      });
      const body = await res.json() as { ok: boolean; order?: { id: string }; error?: string };
      if (res.ok && body.ok && body.order?.id) {
        const realId = body.order.id;
        const placed: LiveOrder = { ...pending, id: realId, status: 'open' };
        set((s) => {
          const m = new Map(s.orders);
          m.delete(tempId);
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

    if (order.virtual) {
      set((s) => {
        const m = new Map(s.orders);
        m.delete(id);
        return { orders: m };
      });
      return;
    }

    set((s) => {
      const m = new Map(s.orders);
      m.set(id, { ...order, status: 'canceled' });
      return { orders: m };
    });

    try {
      await fetch(`${API_BASE}/api/trade/order`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange: order.exchange, symbol: order.symbol, orderId: id }),
      });
    } finally {
      set((s) => {
        const m = new Map(s.orders);
        m.delete(id);
        return { orders: m };
      });
    }
  },

  syncOpenOrders: async (exchange, symbol) => {
    try {
      const res = await fetch(`${API_BASE}/api/trade/open-orders/${exchange}/${encodeURIComponent(symbol)}`);
      if (!res.ok) return;
      const list = await res.json() as Array<{
        id: string; side: string; price: number; amount: number; status?: string;
      }>;
      set((s) => {
        const m = new Map(s.orders);
        // keep virtual orders for this symbol
        for (const [id, o] of m) {
          if (o.exchange === exchange && o.symbol === symbol && !o.virtual) m.delete(id);
        }
        for (const o of list) {
          if (!o.id || !o.price || !o.amount) continue;
          m.set(o.id, {
            id: o.id, exchange, symbol,
            side: (o.side === 'buy' || o.side === 'sell') ? o.side : 'buy',
            price: o.price, amount: o.amount,
            virtual: false, createdAt: Date.now(), status: 'open',
          });
        }
        return { orders: m };
      });
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
