import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { wsClient, API_BASE } from '../lib/ws-client';
import { useMarketStore } from '../stores/market.store';
import { useOrdersStore } from '../stores/orders.store';
import { useSettingsStore } from '../stores/settings.store';
import { useSimStore } from '../stores/sim.store';
import { useLayoutStore } from '../stores/layout.store';
import { useMarketInfo } from '../stores/marketInfo.store';
import type { OrderBook } from '../stores/market.store';
import type { WidgetConfig } from '../stores/layout.store';
import {
  useTradeAggregates, aggregateVP, computePocVA, computeTapeSpeed,
} from './dom/analytics';
import { HeatmapStrip, type DomSnapshot, type DomLadderRow } from './dom/HeatmapStrip';

// Liquidity heatmap strip parameters — small window so the strip stays
// "live" and reactive next to the current ladder.
const HEATMAP_WINDOW_MS = 12_000;
const HEATMAP_SNAP_MS = 250;
const HEATMAP_W = 84;

interface OrderBookWidgetProps {
  exchange: string;
  symbol: string;
  isActive?: boolean;
  /** Widget config — used for persisting per-widget settings (tickIdx, mode) into widget.props. */
  widget?: WidgetConfig;
}

// Multipliers applied to the instrument's tickSize to build aggregation ladder.
// Index 0 = raw tickSize; default selection lives at TICK_DEFAULT_IDX.
const TICK_MULTIPLIERS = [1, 2, 5, 10, 25, 50, 100, 250] as const;
const TICK_DEFAULT_IDX = 3; // ×10 — comfortable scalping default

/** Heuristic-based fallback when marketInfo hasn't loaded yet. */
function getTickStepsFromPrice(price: number): number[] {
  if (price > 10000) return [0.1, 0.5, 1, 5, 10, 50, 100];
  if (price > 1000) return [0.01, 0.05, 0.1, 0.5, 1, 5, 10];
  if (price > 100) return [0.01, 0.05, 0.1, 0.5, 1, 5];
  if (price > 10) return [0.001, 0.005, 0.01, 0.05, 0.1, 0.5];
  if (price > 1) return [0.0001, 0.001, 0.005, 0.01, 0.05, 0.1];
  return [0.00001, 0.0001, 0.001, 0.01];
}

function buildTickSteps(tickSize: number | null, fallbackPrice: number): number[] {
  if (tickSize && tickSize > 0) {
    return TICK_MULTIPLIERS.map((m) => roundTick(tickSize * m, tickSize));
  }
  return getTickStepsFromPrice(fallbackPrice);
}

function roundTick(value: number, tickSize: number): number {
  const precision = Math.max(0, -Math.floor(Math.log10(tickSize)));
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function aggregateLevels(levels: number[][], tickSize: number): Map<number, number> {
  const map = new Map<number, number>();
  for (const [price, vol] of levels) {
    if (price == null || vol == null) continue;
    const key = roundTick(Math.floor(price / tickSize) * tickSize, tickSize);
    map.set(key, (map.get(key) ?? 0) + vol);
  }
  return map;
}

function fmtVol(v: number): string {
  if (v === 0) return '';
  if (v >= 1000) return v.toFixed(0);
  if (v >= 100) return v.toFixed(1);
  if (v >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

type DomMode = 'static' | 'dynamic';

interface Row {
  price: number;
  askSize: number;
  bidSize: number;
  buyVp: number;
  sellVp: number;
  totalVp: number;
  side: 'ask' | 'bid' | 'spread';
}

export function OrderBookWidget({ exchange, symbol, isActive, widget }: OrderBookWidgetProps) {
  const key = `${exchange}:${symbol}`;
  const orderbook = useMarketStore((s) => s.orderbooks.get(key));
  const setOrderbook = useMarketStore((s) => s.setOrderbook);
  const placeLimit = useOrdersStore((s) => s.placeLimit);
  const cancelOrder = useOrdersStore((s) => s.cancel);
  const getOrders = useOrdersStore((s) => s.getBySymbol);
  const syncOrders = useOrdersStore((s) => s.syncOpenOrders);
  const ordersMap = useOrdersStore((s) => s.orders); // subscribe for re-render
  const tradingMode = useSettingsStore((s) => s.mode);
  const simPositions = useSimStore((s) => s.positions);
  const simSymbolPositions = useMemo(
    () => tradingMode === 'sim'
      ? simPositions.filter((p) => p.exchange === exchange && p.symbol === symbol)
      : [],
    [tradingMode, simPositions, exchange, symbol],
  );
  // Aggregate same-symbol positions into a single net view so multiple opens
  // (each click creates a new trade) don't make CLOSE feel broken.
  const simPosition = useMemo(() => {
    if (simSymbolPositions.length === 0) return undefined;
    if (simSymbolPositions.length === 1) return simSymbolPositions[0];
    let netSize = 0;
    let weightedEntry = 0;
    let totalUpnl = 0;
    let mark = 0;
    for (const p of simSymbolPositions) {
      const signed = (p.side === 'long' ? 1 : -1) * p.size;
      netSize += signed;
      weightedEntry += p.entryPrice * Math.abs(signed);
      totalUpnl += p.unrealizedPnl ?? 0;
      mark = p.markPrice ?? mark;
    }
    const absSize = simSymbolPositions.reduce((a, p) => a + p.size, 0);
    return {
      ...simSymbolPositions[0]!,
      id: '__agg__',
      side: netSize >= 0 ? 'long' as const : 'short' as const,
      entryPrice: absSize > 0 ? weightedEntry / absSize : simSymbolPositions[0]!.entryPrice,
      size: absSize,
      stopLoss: 0,
      takeProfit: null,
      markPrice: mark,
      unrealizedPnl: totalUpnl,
    };
  }, [simSymbolPositions]);
  const updateWidgetProps = useLayoutStore((s) => s.updateWidgetProps);
  const marketInfo = useMarketInfo(exchange, symbol);

  const persisted = (widget?.props ?? {}) as {
    tickIdx?: number; mode?: DomMode;
    showVP?: boolean; showHeatmap?: boolean; flashEnabled?: boolean; qty?: string;
  };

  const [tickIdx, setTickIdx] = useState<number>(persisted.tickIdx ?? TICK_DEFAULT_IDX);
  const [mode, setMode] = useState<DomMode>(persisted.mode ?? 'dynamic');
  const [scrollOffset, setScrollOffset] = useState(0);
  const [showMenu, setShowMenu] = useState(false);
  const [qty, setQty] = useState<string>(persisted.qty ?? '0.01');
  const [showVP, setShowVP] = useState<boolean>(persisted.showVP ?? true);
  const [showHeatmap, setShowHeatmap] = useState<boolean>(persisted.showHeatmap ?? false);
  const [flashEnabled, setFlashEnabled] = useState<boolean>(persisted.flashEnabled ?? true);

  // Persist UI state to widget.props so it survives reloads / pane swaps.
  useEffect(() => {
    if (!widget?.id) return;
    updateWidgetProps(widget.id, { tickIdx, mode, showVP, showHeatmap, flashEnabled, qty });
  }, [widget?.id, tickIdx, mode, showVP, showHeatmap, flashEnabled, qty, updateWidgetProps]);

  const ladderRef = useRef<HTMLDivElement>(null);
  const [containerH, setContainerH] = useState(400);

  // Liquidity heatmap strip — orderbook snapshots over a short window, drawn
  // as a Bookmap-style ribbon to the left of the ladder.
  const snapshotsRef = useRef<DomSnapshot[]>([]);
  const rowsRef = useRef<DomLadderRow[]>([]);

  const { volAtPriceRef, recentTradesRef, printsRef, tick } = useTradeAggregates(exchange, symbol);

  // Orderbook subscription
  useEffect(() => {
    fetch(`${API_BASE}/api/snapshot/ob/${exchange}/${encodeURIComponent(symbol)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.bids) setOrderbook(key, data as OrderBook); })
      .catch(() => {});
    const channel = `orderbook:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe<OrderBook>(channel, (data) => setOrderbook(key, data));
    return unsub;
  }, [exchange, symbol, key, setOrderbook]);

  // Track container height
  useEffect(() => {
    const el = ladderRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerH(el.clientHeight));
    ro.observe(el);
    setContainerH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Wheel navigation in static mode
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (mode === 'static') {
      e.preventDefault();
      setScrollOffset((prev) => prev + (e.deltaY > 0 ? 3 : -3));
    }
  }, [mode]);

  // Reset scroll position when symbol changes (different price scale).
  useEffect(() => { setScrollOffset(0); }, [exchange, symbol]);

  // Pull open orders for the current symbol on mount, mode-switch, or symbol-change.
  // Poll periodically so fills/cancels from elsewhere reflect in the DOM.
  useEffect(() => {
    syncOrders(exchange, symbol);
    const t = setInterval(() => syncOrders(exchange, symbol), 5_000);
    return () => clearInterval(t);
  }, [exchange, symbol, tradingMode, syncOrders]);

  const bids = orderbook?.bids ?? [];
  const asks = orderbook?.asks ?? [];
  const bestAsk = asks[0]?.[0] ?? 0;
  const bestBid = bids[0]?.[0] ?? 0;
  const midPrice = (bestBid && bestAsk) ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk || 0);

  const steps = useMemo(
    () => buildTickSteps(marketInfo?.tickSize ?? null, midPrice),
    [marketInfo?.tickSize, midPrice],
  );
  const tickSize = steps[Math.min(tickIdx, steps.length - 1)]!;

  const aggBids = aggregateLevels(bids, tickSize);
  const aggAsks = aggregateLevels(asks, tickSize);
  const vp = useMemo(() => aggregateVP(volAtPriceRef.current, tickSize), [tickSize, tick, volAtPriceRef]);
  const pocVA = useMemo(() => computePocVA(vp), [vp]);

  // Heatmap snapshot pump. Samples on a fixed cadence so the ribbon advances
  // even when the orderbook is quiet; drops snapshots older than the window.
  useEffect(() => { snapshotsRef.current = []; }, [tickSize, exchange, symbol]);
  useEffect(() => {
    if (!showHeatmap) return;
    const id = setInterval(() => {
      const ob = useMarketStore.getState().orderbooks.get(key);
      if (!ob) return;
      const snap: DomSnapshot = {
        t: Date.now(),
        bids: aggregateLevels(ob.bids, tickSize),
        asks: aggregateLevels(ob.asks, tickSize),
      };
      snapshotsRef.current.push(snap);
      const cutoff = Date.now() - HEATMAP_WINDOW_MS;
      while (snapshotsRef.current.length && snapshotsRef.current[0]!.t < cutoff) {
        snapshotsRef.current.shift();
      }
    }, HEATMAP_SNAP_MS);
    return () => clearInterval(id);
  }, [showHeatmap, key, tickSize]);

  const tape = useMemo(
    () => computeTapeSpeed(recentTradesRef.current, 2000),
    [tick, recentTradesRef],
  );

  const bestAskTick = bestAsk > 0 ? roundTick(Math.ceil(bestAsk / tickSize) * tickSize, tickSize) : 0;
  const bestBidTick = bestBid > 0 ? roundTick(Math.floor(bestBid / tickSize) * tickSize, tickSize) : 0;
  const dp = tickSize >= 1 ? 0 : tickSize >= 0.1 ? 1 : tickSize >= 0.01 ? 2 : tickSize >= 0.001 ? 3 : 4;

  const rowH = 18;
  const spreadRowH = mode === 'static' ? 22 : 0;
  const totalRows = Math.max(4, Math.floor((containerH - spreadRowH) / rowH));

  // Build rows
  const rows: Row[] = [];
  const buildRow = (p: number, side: 'ask' | 'bid'): Row => {
    const s = vp.get(p) ?? { buyVol: 0, sellVol: 0 };
    return {
      price: p,
      askSize: aggAsks.get(p) ?? 0,
      bidSize: aggBids.get(p) ?? 0,
      buyVp: s.buyVol,
      sellVp: s.sellVol,
      totalVp: s.buyVol + s.sellVol,
      side,
    };
  };

  if (mode === 'dynamic') {
    const centerTick = roundTick(Math.round(midPrice / tickSize) * tickSize, tickSize);
    for (let i = Math.floor(totalRows / 2); i >= -Math.ceil(totalRows / 2); i--) {
      const p = roundTick(centerTick + (i + scrollOffset) * tickSize, tickSize);
      const askVol = aggAsks.get(p) ?? 0;
      const bidVol = aggBids.get(p) ?? 0;
      let side: 'ask' | 'bid';
      if (askVol > 0 && bidVol === 0) side = 'ask';
      else if (bidVol > 0 && askVol === 0) side = 'bid';
      else side = p >= bestAskTick ? 'ask' : 'bid';
      rows.push(buildRow(p, side));
    }
  } else {
    const halfRows = Math.floor(totalRows / 2);
    const askRows: Row[] = [];
    for (let i = halfRows - 1; i >= 0; i--) {
      askRows.push(buildRow(roundTick(bestAskTick + (i + scrollOffset) * tickSize, tickSize), 'ask'));
    }
    const bidRows: Row[] = [];
    for (let i = 0; i < halfRows; i++) {
      bidRows.push(buildRow(roundTick(bestBidTick - (i + scrollOffset) * tickSize, tickSize), 'bid'));
    }
    rows.push(...askRows);
    rows.push({ price: 0, askSize: 0, bidSize: 0, buyVp: 0, sellVp: 0, totalVp: 0, side: 'spread' });
    rows.push(...bidRows);
  }

  // Mirror current ladder rows into a ref so the HeatmapStrip canvas can
  // align cells with each visible price level without re-subscribing.
  rowsRef.current = rows.map((r) => ({ price: r.price, side: r.side }));

  // Normalizers for bars
  const dataRows = rows.filter((r) => r.side !== 'spread');
  const maxDepth = Math.max(...dataRows.map((r) => Math.max(r.askSize, r.bidSize)), 0.001);
  const maxVp = Math.max(...dataRows.map((r) => r.totalVp), 0.001);

  // Large order threshold (3x median non-zero depth)
  const depths = dataRows.flatMap((r) => [r.askSize, r.bidSize]).filter((v) => v > 0).sort((a, b) => a - b);
  const median = depths.length ? depths[Math.floor(depths.length / 2)]! : 0;
  const largeThreshold = median * 3;

  // Orders at price
  const symOrders = useMemo(
    () => getOrders(exchange, symbol),
    [exchange, symbol, ordersMap, getOrders],
  );
  const ordersByPrice = useMemo(() => {
    const m = new Map<number, typeof symOrders>();
    for (const o of symOrders) {
      const k = roundTick(Math.round(o.price / tickSize) * tickSize, tickSize);
      const arr = m.get(k) ?? [];
      arr.push(o);
      m.set(k, arr);
    }
    return m;
  }, [symOrders, tickSize]);

  // Click handlers
  const handlePlaceLimit = (price: number, side: 'buy' | 'sell') => {
    const amount = Number(qty);
    if (!amount || amount <= 0) return;
    placeLimit({ exchange, symbol, side, price, amount });
  };

  const handleRowMouseDown = (e: React.MouseEvent, price: number) => {
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    const side: 'buy' | 'sell' = e.button === 0 ? 'buy' : 'sell';
    handlePlaceLimit(price, side);
  };

  const handleOrderClick = (e: React.MouseEvent, orderId: string) => {
    e.preventDefault();
    e.stopPropagation();
    cancelOrder(orderId);
  };

  const tapeColor =
    tape.hot === 'hot' ? (tape.delta > 0 ? 'text-green-400' : tape.delta < 0 ? 'text-red-400' : 'text-yellow-400')
    : tape.hot === 'warm' ? 'text-yellow-500/80'
    : 'text-gray-500';

  return (
    <div
      className={`h-full flex flex-col ${isActive ? '' : ''}`}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Toolbar (qty / virt / tape / settings) */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[#1a1a2a] shrink-0">
        {/* Qty input */}
            <div className="flex items-center gap-0.5">
              <span className="text-[9px] text-gray-600 uppercase">Qty</span>
              <input
                type="text"
                value={qty}
                onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
                onWheel={(e) => {
                  e.currentTarget.blur();
                  const n = Number(qty) || 0;
                  const step = n >= 10 ? 1 : n >= 1 ? 0.1 : n >= 0.1 ? 0.01 : 0.001;
                  const next = e.deltaY < 0 ? n + step : Math.max(0, n - step);
                  setQty(String(Number(next.toFixed(6))));
                }}
                className="w-16 bg-[#0a0a14] border border-[#2a2a3a] rounded px-1 py-0.5 text-[11px] text-gray-200 tabular-nums outline-none focus:border-[#4a4a6a]"
                title="Order qty (base). Scroll to step."
              />
            </div>

            {/* Quick legend so the user knows what each click does */}
            <span className="text-[9px] text-gray-500 ml-1" title="Left-click on a price = limit BUY at that price · Right-click = limit SELL">
              <span className="text-green-400">LMB</span>=BUY · <span className="text-red-400">RMB</span>=SELL
            </span>

            <div className="flex-1" />

            {/* Tape speed */}
            <div className={`text-[10px] font-mono tabular-nums ${tapeColor}`} title="Trades/sec · $/sec · delta">
              {tape.tps.toFixed(1)}/s
              <span className="text-gray-600 ml-1">${tape.usdPerSec >= 1000 ? `${(tape.usdPerSec / 1000).toFixed(1)}k` : tape.usdPerSec.toFixed(0)}</span>
            </div>

            <div className="relative">
              <button
                onClick={() => setShowMenu(!showMenu)}
                className={`text-[10px] px-1.5 py-0.5 rounded ${showMenu ? 'text-gray-200 bg-[#1e1e2e]' : 'text-gray-600 hover:text-gray-400'}`}
              >&#9881;</button>
              {showMenu && (
                <div className="absolute top-full right-0 mt-1 w-52 bg-[#12121e] border border-[#2a2a3a] rounded shadow-lg z-50 p-2 space-y-2"
                  onMouseLeave={() => setShowMenu(false)}
                >
                  <div>
                    <div className="text-[9px] text-gray-500 uppercase mb-1">Mode</div>
                    <div className="flex gap-1">
                      {(['dynamic', 'static'] as DomMode[]).map((m) => (
                        <button key={m} onClick={() => { setMode(m); setScrollOffset(0); }}
                          className={`flex-1 px-2 py-1 text-[10px] rounded ${mode === m ? 'bg-[#2a2a4a] text-white' : 'text-gray-500 hover:text-gray-300'}`}
                        >{m === 'dynamic' ? 'Dynamic' : 'Static'}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] text-gray-500 uppercase mb-1">Tick Size</div>
                    <div className="flex flex-wrap gap-1">
                      {steps.map((s, i) => (
                        <button key={s} onClick={() => setTickIdx(i)}
                          className={`px-1.5 py-0.5 text-[10px] rounded ${tickIdx === i ? 'bg-[#2a2a4a] text-white' : 'text-gray-500 hover:text-gray-300'}`}
                        >{s}</button>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="flex items-center gap-1 text-[10px] text-gray-400 cursor-pointer">
                      <input type="checkbox" checked={showVP} onChange={(e) => setShowVP(e.target.checked)} />
                      Volume Profile
                    </label>
                    <label className="flex items-center gap-1 text-[10px] text-gray-400 cursor-pointer">
                      <input type="checkbox" checked={showHeatmap} onChange={(e) => setShowHeatmap(e.target.checked)} />
                      Liquidity heatmap
                    </label>
                    <label className="flex items-center gap-1 text-[10px] text-gray-400 cursor-pointer">
                      <input type="checkbox" checked={flashEnabled} onChange={(e) => setFlashEnabled(e.target.checked)} />
                      Flash large
                    </label>
                  </div>
                  {mode === 'static' && scrollOffset !== 0 && (
                    <button onClick={() => setScrollOffset(0)}
                      className="w-full text-[10px] text-gray-500 hover:text-gray-300 py-0.5"
                    >Center on market</button>
                  )}
                  {pocVA.poc != null && (
                    <div className="text-[9px] text-gray-500 pt-1 border-t border-[#1e1e2e]">
                      POC {pocVA.poc.toFixed(dp)} · VA [{pocVA.val?.toFixed(dp)} — {pocVA.vah?.toFixed(dp)}]
                    </div>
                  )}
                </div>
              )}
            </div>
            <span className="text-[10px] text-gray-500 font-mono ml-0.5 tabular-nums">
              {midPrice > 0 ? midPrice.toFixed(dp) : '—'}
            </span>
      </div>

      {/* Open limit orders banner — every resting order shown explicitly so the
          user can see what's been placed even if it's far off-screen in the DOM. */}
      {symOrders.length > 0 && (
        <div className="flex flex-col gap-0.5 px-2 py-1 border-b border-blue-700/40 bg-blue-950/30 text-[10px] shrink-0">
          {symOrders.map((o) => (
            <div key={o.id} className="flex items-center gap-2">
              <span className={`font-bold ${o.side === 'buy' ? 'text-green-400' : 'text-red-400'}`}>
                {o.side === 'buy' ? 'BUY' : 'SELL'} {o.amount.toFixed(4)}
              </span>
              <span className="text-gray-400">
                @ <span className="text-gray-200 font-mono">{o.price.toFixed(dp)}</span>
              </span>
              <span className={`text-[9px] uppercase ${
                o.status === 'open' ? 'text-blue-400' :
                o.status === 'pending' ? 'text-yellow-400' :
                'text-gray-500'
              }`}>{o.status}</span>
              <div className="flex-1" />
              <button
                onClick={() => cancelOrder(o.id)}
                className="text-[10px] px-1.5 py-0.5 rounded border border-gray-600 text-gray-300 hover:border-red-500 hover:text-red-300"
                title="Cancel this order"
              >×</button>
            </div>
          ))}
        </div>
      )}

      {/* Sim position banner — gives immediate feedback that an order filled. */}
      {simPosition && (
        <div className="flex items-center gap-2 px-2 py-1 border-b border-yellow-700/40 bg-yellow-950/30 text-[10px] shrink-0">
          <span className={`font-bold ${simPosition.side === 'long' ? 'text-green-400' : 'text-red-400'}`}>
            {simPosition.side === 'long' ? 'LONG' : 'SHORT'} {simPosition.size.toFixed(4)}
          </span>
          <span className="text-gray-400">
            @ <span className="text-gray-200 font-mono">{simPosition.entryPrice.toFixed(dp)}</span>
          </span>
          {simPosition.unrealizedPnl != null && (
            <span className={`font-mono ${simPosition.unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {simPosition.unrealizedPnl >= 0 ? '+' : ''}{simPosition.unrealizedPnl.toFixed(2)}$
            </span>
          )}
          {simPosition.stopLoss > 0 && (
            <span className="text-red-300/80">SL <span className="font-mono">{simPosition.stopLoss.toFixed(dp)}</span></span>
          )}
          {simPosition.takeProfit != null && (
            <span className="text-green-300/80">TP <span className="font-mono">{simPosition.takeProfit.toFixed(dp)}</span></span>
          )}
          <div className="flex-1" />
          <button
            onClick={async () => {
              const ids = simSymbolPositions.map((p) => p.id);
              if (ids.length === 0) return;
              // Tombstone + drop locally first so concurrent sim:exposure-driven
              // refreshPositions can't resurrect them while the cmd is in flight.
              useSimStore.getState().markPositionsClosing(ids);
              try {
                // Fire all closes in parallel — each goes through cmd:sim:trade:close.
                await Promise.all(
                  ids.map((id) =>
                    fetch(`${API_BASE}/api/sim/trade/close/${encodeURIComponent(id)}`, { method: 'POST' })
                      .then(async (res) => {
                        if (!res.ok) console.error('sim close failed', id, res.status, await res.text());
                      }),
                  ),
                );
              } catch (err) {
                console.error('sim close error', err);
              }
            }}
            className="text-[10px] px-1.5 py-0.5 rounded border border-red-700/60 text-red-200 bg-red-900/30 hover:bg-red-800/50 font-bold"
            title={`Close all ${simSymbolPositions.length} sim position(s) on this symbol at market`}
          >CLOSE{simSymbolPositions.length > 1 ? ` ALL (${simSymbolPositions.length})` : ''}</button>
        </div>
      )}

      {/* DOM Ladder — Tiger-style: liquidity heatmap (optional) | volume cluster | size | price | orders */}
      <div ref={ladderRef} className="flex-1 overflow-hidden flex font-mono text-[11px] leading-none select-none">
        {showHeatmap && orderbook && (bids.length > 0 || asks.length > 0) && (
          <div className="shrink-0 border-r border-[#1a1a2a]" style={{ width: HEATMAP_W }}>
            <HeatmapStrip
              snapshotsRef={snapshotsRef}
              rowsRef={rowsRef}
              rowH={rowH}
              spreadRowH={spreadRowH}
              windowMs={HEATMAP_WINDOW_MS}
            />
          </div>
        )}
        <div className="flex-1 flex flex-col min-w-0">
        {!orderbook || (bids.length === 0 && asks.length === 0) ? (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-xs">Waiting for data...</div>
        ) : rows.map((row, i) => {
          if (row.side === 'spread') {
            return (
              <div key="spread" className="flex items-center justify-center border-y border-[#1e1e2e] bg-[#08080e] shrink-0"
                style={{ height: spreadRowH }}
              >
                {bestBid > 0 && bestAsk > 0 ? (
                  <span className="text-[10px]">
                    <span className="text-yellow-500/80 font-bold">{(bestAsk - bestBid).toFixed(dp)}</span>
                    <span className="text-gray-600 ml-1">({((bestAsk - bestBid) / bestBid * 100).toFixed(3)}%)</span>
                  </span>
                ) : <span className="text-[10px] text-gray-600">—</span>}
              </div>
            );
          }

          const isAsk = row.side === 'ask';
          const isBestBid = Math.abs(row.price - bestBidTick) < tickSize * 0.5;
          const isBestAsk = Math.abs(row.price - bestAskTick) < tickSize * 0.5;
          const isPOC = pocVA.poc != null && Math.abs(row.price - pocVA.poc) < tickSize * 0.5;
          const inVA = pocVA.vah != null && pocVA.val != null
            && row.price <= pocVA.vah && row.price >= pocVA.val;

          const depthPct = isAsk ? (row.askSize / maxDepth) * 100 : (row.bidSize / maxDepth) * 100;
          const vpBuyPct = maxVp > 0 ? (row.buyVp / maxVp) * 100 : 0;
          const vpSellPct = maxVp > 0 ? (row.sellVp / maxVp) * 100 : 0;
          const vpTotalPct = maxVp > 0 ? (row.totalVp / maxVp) * 100 : 0;

          const curSize = isAsk ? row.askSize : row.bidSize;
          const isLarge = flashEnabled && largeThreshold > 0 && curSize > largeThreshold;

          const print = printsRef.current.get(roundTick(Math.round(row.price / tickSize) * tickSize, tickSize));
          const hasPrint = print && (Date.now() - print.time < 1500);
          const printAge = hasPrint ? Date.now() - print.time : 0;
          const printOpacity = hasPrint ? Math.max(0, 1 - printAge / 1500) : 0;

          const priceOrders = ordersByPrice.get(row.price) ?? [];

          // Position overlay: paint the band between entry and mark price (P&L zone),
          // mark the entry / SL / TP rows. Only for the symbol that holds the position.
          let posBand: 'profit' | 'loss' | null = null;
          let isEntryRow = false;
          let isStopRow = false;
          let isTakeRow = false;
          if (simPosition) {
            const entry = simPosition.entryPrice;
            const mark = simPosition.markPrice ?? entry;
            const top = Math.max(entry, mark);
            const bot = Math.min(entry, mark);
            if (top - bot >= tickSize * 0.5
                && row.price <= top + tickSize * 0.5
                && row.price >= bot - tickSize * 0.5) {
              const isProfit = simPosition.side === 'long' ? mark >= entry : mark <= entry;
              posBand = isProfit ? 'profit' : 'loss';
            }
            isEntryRow = Math.abs(row.price - entry) < tickSize * 0.5;
            if (simPosition.stopLoss > 0) {
              isStopRow = Math.abs(row.price - simPosition.stopLoss) < tickSize * 0.5;
            }
            if (simPosition.takeProfit != null && simPosition.takeProfit > 0) {
              isTakeRow = Math.abs(row.price - simPosition.takeProfit) < tickSize * 0.5;
            }
          }

          return (
            <div
              key={`${row.side}${i}`}
              className={`grid relative shrink-0 ${isBestBid || isBestAsk ? 'bg-white/[0.04]' : ''} ${isLarge ? 'animate-pulse' : ''}`}
              style={{
                height: rowH,
                // Tiger-style: all volume info sits left of price; orders right of it.
                // Cols: TotalVP-bar | BuyVP | SellVP | Size(bid|ask unified) | Price | Orders
                gridTemplateColumns: showVP
                  ? '8% 12% 12% 18% 26% 24%'
                  : '0% 0% 0% 36% 32% 32%',
              }}
              onMouseDown={(e) => handleRowMouseDown(e, row.price)}
            >
              {/* Position overlay (P&L band + entry/SL/TP markers). Drawn first so
                  it sits behind all column content but above the row background. */}
              {posBand && (
                <div className={`absolute inset-0 pointer-events-none z-0 ${
                  posBand === 'profit' ? 'bg-green-500/15' : 'bg-red-500/15'
                }`} />
              )}
              {isEntryRow && (
                <div className="absolute inset-x-0 top-0 h-px bg-yellow-400/80 pointer-events-none z-10" />
              )}
              {isEntryRow && (
                <div className="absolute left-0 top-0 bottom-0 px-0.5 flex items-center bg-yellow-500/80 text-[8px] font-bold text-black z-20 pointer-events-none">
                  {simPosition?.side === 'long' ? 'L' : 'S'}
                </div>
              )}
              {isStopRow && (
                <div className="absolute inset-x-0 top-1/2 h-px bg-red-500/80 pointer-events-none z-10" />
              )}
              {isStopRow && (
                <div className="absolute right-0 top-0 bottom-0 px-0.5 flex items-center bg-red-600/70 text-[8px] font-bold text-white z-20 pointer-events-none">
                  SL
                </div>
              )}
              {isTakeRow && (
                <div className="absolute inset-x-0 top-1/2 h-px bg-green-500/80 pointer-events-none z-10" />
              )}
              {isTakeRow && (
                <div className="absolute right-0 top-0 bottom-0 px-0.5 flex items-center bg-green-600/70 text-[8px] font-bold text-white z-20 pointer-events-none">
                  TP
                </div>
              )}

              {/* Open limit orders sitting at this price — full-width band so they're impossible to miss. */}
              {priceOrders.length > 0 && (() => {
                const first = priceOrders[0]!;
                const totalAmt = priceOrders.reduce((a, o) => a + o.amount, 0);
                const isBuy = first.side === 'buy';
                return (
                  <>
                    <div
                      className={`absolute inset-x-0 top-1/2 h-[2px] pointer-events-none z-10 ${
                        isBuy ? 'bg-green-400' : 'bg-red-400'
                      }`}
                    />
                    <div
                      className={`absolute left-0 top-0 bottom-0 px-1 flex items-center text-[9px] font-bold z-20 pointer-events-none ${
                        isBuy ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
                      }`}
                    >
                      {isBuy ? 'BUY' : 'SELL'} {fmtVol(totalAmt)}
                    </div>
                  </>
                );
              })()}

              {/* TotalVP heatmap-style sidebar (POC / VA highlight). Width 0 when showVP=false. */}
              <div className="relative overflow-hidden">
                {showVP && (
                  <>
                    <div
                      className={`absolute inset-y-0 left-0 ${isPOC ? 'bg-yellow-500/40' : inVA ? 'bg-purple-500/20' : 'bg-gray-500/15'}`}
                      style={{ width: `${vpTotalPct}%` }}
                    />
                    {isPOC && (
                      <div className="absolute inset-y-0 left-0 border-l-2 border-yellow-400" />
                    )}
                  </>
                )}
              </div>

              {/* Buy VP at price */}
              <div className="relative overflow-hidden pr-1 flex items-center justify-end">
                {showVP && (
                  <>
                    <div className="absolute inset-y-0 left-0 bg-green-500/10" style={{ width: `${vpBuyPct}%` }} />
                    <span className="relative z-10 text-green-600/80 tabular-nums text-[10px]">{fmtVol(row.buyVp)}</span>
                  </>
                )}
              </div>

              {/* Sell VP at price — same orientation as Buy so the eye can scan one column */}
              <div className="relative overflow-hidden pr-1 flex items-center justify-end">
                {showVP && (
                  <>
                    <div className="absolute inset-y-0 left-0 bg-red-500/10" style={{ width: `${vpSellPct}%` }} />
                    <span className="relative z-10 text-red-500/80 tabular-nums text-[10px]">{fmtVol(row.sellVp)}</span>
                  </>
                )}
              </div>

              {/* Size — unified bid/ask column. Color follows the side; bar grows from
                  the price edge (right) leftward, so liquidity "pushes against" price. */}
              <div className="relative overflow-hidden pr-1 flex items-center justify-end">
                {curSize > 0 && (
                  <div
                    className={`absolute inset-y-0 right-0 ${isAsk ? 'bg-red-500/25' : 'bg-green-500/25'}`}
                    style={{ width: `${depthPct}%` }}
                  />
                )}
                <span
                  className={`relative z-10 tabular-nums ${
                    isAsk ? 'text-red-300' : 'text-green-300'
                  } ${(isBestBid || isBestAsk) ? 'font-bold' : ''}`}
                >
                  {curSize > 0 ? fmtVol(curSize) : ''}
                </span>
              </div>

              {/* Price */}
              <div className={`relative flex items-center justify-center tabular-nums ${
                isBestBid ? 'text-green-200 font-bold'
                : isBestAsk ? 'text-red-200 font-bold'
                : isAsk ? 'text-red-400/70' : 'text-green-400/70'
              }`}>
                {hasPrint && (
                  <div
                    className={`absolute inset-0 ${print!.side === 'buy' ? 'bg-green-500' : 'bg-red-500'}`}
                    style={{ opacity: printOpacity * 0.25 }}
                  />
                )}
                <span className="relative z-10">{row.price.toFixed(dp)}</span>
              </div>

              {/* Orders column */}
              <div className="relative flex items-center justify-center gap-0.5">
                {priceOrders.map((o) => (
                  <button
                    key={o.id}
                    onMouseDown={(e) => handleOrderClick(e, o.id)}
                    onContextMenu={(e) => handleOrderClick(e, o.id)}
                    title={`${o.side.toUpperCase()} ${o.amount} @ ${o.price} ${o.mode === 'sim' ? '(sim)' : ''} — click to cancel`}
                    className={`text-[9px] px-1 py-0 rounded border leading-tight ${
                      o.side === 'buy'
                        ? 'border-green-600/60 text-green-300 bg-green-900/30'
                        : 'border-red-600/60 text-red-300 bg-red-900/30'
                    } ${o.mode === 'sim' ? 'opacity-80 border-dashed' : ''} hover:bg-red-600/40 hover:text-white`}
                  >
                    {fmtVol(o.amount)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}
