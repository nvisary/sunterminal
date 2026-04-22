import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { wsClient, API_BASE } from '../lib/ws-client';
import { useMarketStore } from '../stores/market.store';
import { useOrdersStore } from '../stores/orders.store';
import { EXCHANGES } from '../stores/sync.store';
import type { OrderBook } from '../stores/market.store';
import {
  useTradeAggregates, aggregateVP, computePocVA, computeTapeSpeed,
} from './dom/analytics';

interface OrderBookWidgetProps {
  exchange: string;
  symbol: string;
  isActive?: boolean;
  onChangeSymbol?: (symbol: string) => void;
  onChangeExchange?: (exchange: string) => void;
}

function getTickSteps(price: number): number[] {
  if (price > 10000) return [0.1, 0.5, 1, 5, 10, 50, 100];
  if (price > 1000) return [0.01, 0.05, 0.1, 0.5, 1, 5, 10];
  if (price > 100) return [0.01, 0.05, 0.1, 0.5, 1, 5];
  if (price > 10) return [0.001, 0.005, 0.01, 0.05, 0.1, 0.5];
  if (price > 1) return [0.0001, 0.001, 0.005, 0.01, 0.05, 0.1];
  return [0.00001, 0.0001, 0.001, 0.01];
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

export function OrderBookWidget({ exchange, symbol, isActive, onChangeSymbol, onChangeExchange }: OrderBookWidgetProps) {
  const key = `${exchange}:${symbol}`;
  const orderbook = useMarketStore((s) => s.orderbooks.get(key));
  const setOrderbook = useMarketStore((s) => s.setOrderbook);
  const placeLimit = useOrdersStore((s) => s.placeLimit);
  const cancelOrder = useOrdersStore((s) => s.cancel);
  const getOrders = useOrdersStore((s) => s.getBySymbol);
  const ordersMap = useOrdersStore((s) => s.orders); // subscribe for re-render

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [tickIdx, setTickIdx] = useState(0);
  const [mode, setMode] = useState<DomMode>('dynamic');
  const [scrollOffset, setScrollOffset] = useState(0);
  const [showMenu, setShowMenu] = useState(false);
  const [qty, setQty] = useState('0.01');
  const [virtual, setVirtual] = useState(true); // SAFE DEFAULT
  const [showVP, setShowVP] = useState(true);
  const [flashEnabled, setFlashEnabled] = useState(true);

  const ladderRef = useRef<HTMLDivElement>(null);
  const [containerH, setContainerH] = useState(400);

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

  const doSearch = async (q: string) => {
    if (!q) { setResults([]); return; }
    try {
      const res = await fetch(`${API_BASE}/api/markets/${exchange}/search?q=${encodeURIComponent(q)}`);
      setResults(await res.json() as string[]);
    } catch { setResults([]); }
  };

  const selectSymbol = (sym: string) => {
    onChangeSymbol?.(sym);
    setSearch(''); setResults([]); setSearching(false); setScrollOffset(0);
  };

  const bids = orderbook?.bids ?? [];
  const asks = orderbook?.asks ?? [];
  const bestAsk = asks[0]?.[0] ?? 0;
  const bestBid = bids[0]?.[0] ?? 0;
  const midPrice = (bestBid && bestAsk) ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk || 0);

  const steps = getTickSteps(midPrice);
  const tickSize = steps[Math.min(tickIdx, steps.length - 1)]!;

  const aggBids = aggregateLevels(bids, tickSize);
  const aggAsks = aggregateLevels(asks, tickSize);
  const vp = useMemo(() => aggregateVP(volAtPriceRef.current, tickSize), [tickSize, tick, volAtPriceRef]);
  const pocVA = useMemo(() => computePocVA(vp), [vp]);

  const tape = useMemo(
    () => computeTapeSpeed(recentTradesRef.current, 2000),
    [tick, recentTradesRef],
  );

  const bestAskTick = bestAsk > 0 ? roundTick(Math.ceil(bestAsk / tickSize) * tickSize, tickSize) : 0;
  const bestBidTick = bestBid > 0 ? roundTick(Math.floor(bestBid / tickSize) * tickSize, tickSize) : 0;
  const dp = tickSize >= 1 ? 0 : tickSize >= 0.1 ? 1 : tickSize >= 0.01 ? 2 : tickSize >= 0.001 ? 3 : 4;
  const baseName = symbol.split('/')[0] ?? symbol;

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
    placeLimit({ exchange, symbol, side, price, amount, virtual });
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
      className={`bg-[#0c0c14] rounded border h-full flex flex-col ${isActive ? 'border-[#3a3a5a]' : 'border-[#1a1a2a]'}`}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Header */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[#1a1a2a] shrink-0">
        {searching ? (
          <div className="flex-1 relative">
            <div className="flex gap-1">
              <select value={exchange} onChange={(e) => onChangeExchange?.(e.target.value)}
                className="bg-[#0a0a14] border border-[#2a2a3a] rounded px-1 py-0.5 text-[10px] text-gray-400 outline-none w-16"
              >
                {EXCHANGES.map((ex) => <option key={ex} value={ex}>{ex}</option>)}
              </select>
              <input autoFocus type="text" value={search}
                onChange={(e) => { const v = e.target.value.toUpperCase(); setSearch(v); doSearch(v); }}
                onKeyDown={async (e) => {
                  if (e.key === 'Escape') { setSearching(false); setSearch(''); setResults([]); }
                  if (e.key === 'Enter' && search) {
                    let r = results;
                    if (!r.length) {
                      const res = await fetch(`${API_BASE}/api/markets/${exchange}/search?q=${encodeURIComponent(search)}`);
                      r = await res.json() as string[];
                    }
                    if (r.length) selectSymbol(r[0]!);
                  }
                }}
                onBlur={() => setTimeout(() => { setSearching(false); setResults([]); }, 200)}
                placeholder="Search..."
                className="flex-1 bg-[#0a0a14] border border-[#2a2a3a] rounded px-1.5 py-0.5 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-[#4a4a6a]"
              />
            </div>
            {results.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-[#12121e] border border-[#2a2a3a] rounded shadow-lg z-50">
                {results.map((sym) => (
                  <button key={sym} onMouseDown={(e) => { e.preventDefault(); selectSymbol(sym); }}
                    className="w-full text-left px-2 py-1 text-xs text-gray-300 hover:bg-[#1e1e3e] hover:text-white"
                  >{sym}</button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <button onClick={() => setSearching(true)}
              className="text-left text-xs font-bold text-gray-200 hover:text-white truncate"
              title="Click to change symbol"
            >
              {baseName}
              <span className="text-[10px] text-gray-600 ml-1">{exchange}</span>
            </button>

            {/* Qty input */}
            <div className="flex items-center gap-0.5 ml-1">
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

            {/* Virtual/real toggle */}
            <button
              onClick={() => setVirtual((v) => !v)}
              className={`text-[10px] px-1.5 py-0.5 rounded border ${
                virtual
                  ? 'border-yellow-600/60 text-yellow-400 bg-yellow-900/20'
                  : 'border-red-600/60 text-red-300 bg-red-900/20'
              }`}
              title={virtual ? 'VIRTUAL — orders do not hit exchange' : 'LIVE — real orders!'}
            >{virtual ? 'VIRT' : 'LIVE'}</button>

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
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 text-[10px] text-gray-400 cursor-pointer">
                      <input type="checkbox" checked={showVP} onChange={(e) => setShowVP(e.target.checked)} />
                      Volume Profile
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
          </>
        )}
      </div>

      {/* DOM Ladder */}
      <div ref={ladderRef} className="flex-1 overflow-hidden flex flex-col font-mono text-[11px] leading-none select-none">
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

          return (
            <div
              key={`${row.side}${i}`}
              className={`grid relative shrink-0 ${isBestBid || isBestAsk ? 'bg-white/[0.04]' : ''} ${isLarge ? 'animate-pulse' : ''}`}
              style={{
                height: rowH,
                gridTemplateColumns: showVP
                  ? '10% 15% 17% 16% 17% 15% 10%'
                  : '0% 18% 20% 20% 20% 18% 4%',
              }}
              onMouseDown={(e) => handleRowMouseDown(e, row.price)}
            >
              {/* VP sidebar */}
              {showVP && (
                <div className="relative overflow-hidden">
                  <div
                    className={`absolute inset-y-0 left-0 ${isPOC ? 'bg-yellow-500/40' : inVA ? 'bg-purple-500/20' : 'bg-gray-500/15'}`}
                    style={{ width: `${vpTotalPct}%` }}
                  />
                  {isPOC && (
                    <div className="absolute inset-y-0 left-0 border-l-2 border-yellow-400" />
                  )}
                </div>
              )}

              {/* Buy VP at price */}
              <div className="relative overflow-hidden pr-1 flex items-center justify-end">
                <div className="absolute inset-y-0 left-0 bg-green-500/10" style={{ width: `${vpBuyPct}%` }} />
                <span className="relative z-10 text-green-600/80 tabular-nums text-[10px]">{fmtVol(row.buyVp)}</span>
              </div>

              {/* Bid size */}
              <div className="relative overflow-hidden pr-1 flex items-center justify-end">
                {!isAsk && row.bidSize > 0 && (
                  <div className="absolute inset-y-0 right-0 bg-green-500/25" style={{ width: `${depthPct}%` }} />
                )}
                <span
                  className={`relative z-10 tabular-nums ${isAsk ? 'text-transparent' : 'text-green-300'} ${isBestBid ? 'font-bold' : ''}`}
                >
                  {!isAsk && row.bidSize > 0 ? fmtVol(row.bidSize) : ''}
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

              {/* Ask size */}
              <div className="relative overflow-hidden pl-1 flex items-center">
                {isAsk && row.askSize > 0 && (
                  <div className="absolute inset-y-0 left-0 bg-red-500/25" style={{ width: `${depthPct}%` }} />
                )}
                <span
                  className={`relative z-10 tabular-nums ${!isAsk ? 'text-transparent' : 'text-red-300'} ${isBestAsk ? 'font-bold' : ''}`}
                >
                  {isAsk && row.askSize > 0 ? fmtVol(row.askSize) : ''}
                </span>
              </div>

              {/* Sell VP at price */}
              <div className="relative overflow-hidden pl-1 flex items-center">
                <div className="absolute inset-y-0 right-0 bg-red-500/10" style={{ width: `${vpSellPct}%` }} />
                <span className="relative z-10 text-red-500/70 tabular-nums text-[10px]">{fmtVol(row.sellVp)}</span>
              </div>

              {/* Orders column */}
              <div className="relative flex items-center justify-center gap-0.5">
                {priceOrders.map((o) => (
                  <button
                    key={o.id}
                    onMouseDown={(e) => handleOrderClick(e, o.id)}
                    onContextMenu={(e) => handleOrderClick(e, o.id)}
                    title={`${o.side.toUpperCase()} ${o.amount} @ ${o.price} ${o.virtual ? '(virtual)' : ''} — click to cancel`}
                    className={`text-[9px] px-1 py-0 rounded border leading-tight ${
                      o.side === 'buy'
                        ? 'border-green-600/60 text-green-300 bg-green-900/30'
                        : 'border-red-600/60 text-red-300 bg-red-900/30'
                    } ${o.virtual ? 'opacity-70 border-dashed' : ''} hover:bg-red-600/40 hover:text-white`}
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
  );
}
