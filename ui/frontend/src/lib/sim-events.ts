import { wsClient, API_BASE } from './ws-client';
import { useOrdersStore, type LiveOrder } from '../stores/orders.store';
import { useSimStore, type SimPosition } from '../stores/sim.store';

// Mirror of trade-execution's SimEvent type. Kept inline (rather than a shared
// package) because the backend repo isn't pulled in as a dependency.
type SimEvent =
  | { type: 'order-placed'; at: number; order: ServerOrder }
  | { type: 'order-canceled'; at: number; orderId: string }
  | { type: 'order-filled'; at: number; orderId: string; tradeId: string; fillPrice: number; fillAmount: number }
  | { type: 'order-rejected'; at: number; orderId: string; reason: string }
  | { type: 'position-opened'; at: number; position: ServerPosition }
  | { type: 'position-updated'; at: number; position: ServerPosition }
  | { type: 'position-closed'; at: number; positionId: string; exitPrice: number; realizedPnl: number };

interface ServerOrder {
  id: string;
  exchange: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  amount: number;
  reduceOnly?: boolean;
}

interface ServerPosition {
  id: string;
  exchange: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  size: number;
  leverage: number;
  stopLoss?: number;
  takeProfit?: number | null;
  fees: number;
  fundingPaid?: number;
  openedAt: number;
  markPrice?: number;
  unrealizedPnl?: number;
}

function orderFromServer(o: ServerOrder): LiveOrder {
  return {
    id: o.id,
    exchange: o.exchange,
    symbol: o.symbol,
    side: o.side,
    price: o.price,
    amount: o.amount,
    mode: 'sim',
    createdAt: Date.now(),
    status: 'open',
  };
}

function positionFromServer(p: ServerPosition): SimPosition {
  return {
    id: p.id,
    exchange: p.exchange,
    symbol: p.symbol,
    side: p.side,
    entryPrice: p.entryPrice,
    size: p.size,
    leverage: p.leverage,
    stopLoss: p.stopLoss ?? 0,
    takeProfit: p.takeProfit ?? null,
    fees: p.fees,
    fundingPaid: p.fundingPaid ?? 0,
    openedAt: p.openedAt,
    markPrice: p.markPrice,
    unrealizedPnl: p.unrealizedPnl,
  };
}

/**
 * One-shot bootstrap: fetch current open orders and positions so the UI has a
 * baseline before events start flowing. Called on initial connect and on
 * every WS reconnect.
 */
async function bootstrap(): Promise<void> {
  try {
    const [ordersRes, positionsRes] = await Promise.all([
      fetch(`${API_BASE}/api/sim/open-orders`),
      fetch(`${API_BASE}/api/sim/positions`),
    ]);
    if (ordersRes.ok) {
      const list = await ordersRes.json() as ServerOrder[];
      const orders = useOrdersStore.getState().orders;
      const next = new Map(orders);
      const serverIds = new Set<string>();
      for (const o of list) {
        if (!o.id || !o.price || !o.amount) continue;
        serverIds.add(o.id);
        next.set(o.id, orderFromServer(o));
      }
      // Drop any local sim orders the server doesn't know about (filled or
      // canceled while we were disconnected). Live orders untouched.
      for (const [id, o] of orders) {
        if (o.mode === 'sim' && !serverIds.has(id)) next.delete(id);
      }
      useOrdersStore.setState({ orders: next });
    }
    if (positionsRes.ok) {
      const list = await positionsRes.json() as ServerPosition[];
      const clean = list.filter((p) => p.id).map(positionFromServer);
      useSimStore.getState().setPositions(clean);
    }
  } catch {
    // If bootstrap fails, events still come through — the UI will lag but
    // eventually converge as state changes happen.
  }
}

function applyEvent(ev: SimEvent): void {
  const orders = useOrdersStore.getState();
  const sim = useSimStore.getState();
  switch (ev.type) {
    case 'order-placed':
      orders.applyOrderPlaced(orderFromServer(ev.order));
      break;
    case 'order-canceled':
      orders.applyOrderCanceled(ev.orderId);
      break;
    case 'order-filled':
      orders.applyOrderFilled(ev.orderId);
      break;
    case 'order-rejected':
      orders.applyOrderRejected(ev.orderId, ev.reason);
      break;
    case 'position-opened':
    case 'position-updated':
      sim.upsertPosition(positionFromServer(ev.position));
      break;
    case 'position-closed':
      sim.removePosition(ev.positionId);
      break;
  }
}

/**
 * Wire the sim:events stream into the local stores. Call once at app start.
 */
export function startSimEventStream(): () => void {
  // Bootstrap once now, then re-bootstrap whenever the WS reconnects so
  // missed events during the gap are reconciled from the authoritative
  // snapshot endpoints.
  void bootstrap();
  const unsubReconnect = wsClient.onReconnect(() => { void bootstrap(); });
  const unsubEvents = wsClient.subscribe<SimEvent>('sim:events', applyEvent);
  return () => {
    unsubReconnect();
    unsubEvents();
  };
}
