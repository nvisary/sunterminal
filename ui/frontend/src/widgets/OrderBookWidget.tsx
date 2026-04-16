import { useEffect, useState, useCallback, useRef } from 'react';
import { wsClient, API_BASE } from '../lib/ws-client';
import { useMarketStore } from '../stores/market.store';
import type { OrderBook } from '../stores/market.store';

interface OrderBookWidgetProps {
  exchange: string;
  symbol: string;
  isActive?: boolean;
  onChangeSymbol?: (symbol: string) => void;
  onChangeExchange?: (exchange: string) => void;
}

const EXCHANGES = ['bybit', 'binance', 'okx'];

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

interface RecentTrade {
  price: number;
  amount: number;
  side: string;
  time: number;
}

type DomMode = 'static' | 'dynamic';

export function OrderBookWidget({ exchange, symbol, isActive, onChangeSymbol, onChangeExchange }: OrderBookWidgetProps) {
  const key = `${exchange}:${symbol}`;
  const orderbook = useMarketStore((s) => s.orderbooks.get(key));
  const setOrderbook = useMarketStore((s) => s.setOrderbook);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [tickIdx, setTickIdx] = useState(0);
  const [mode, setMode] = useState<DomMode>('dynamic');
  const [scrollOffset, setScrollOffset] = useState(0); // for static mode: shift in tick steps
  const [showMenu, setShowMenu] = useState(false);
  const ladderRef = useRef<HTMLDivElement>(null);
  const recentTradesRef = useRef<Map<number, RecentTrade>>(new Map());

  useEffect(() => {
    const channel = `orderbook:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe<OrderBook>(channel, (data) => {
      setOrderbook(key, data);
    });
    return unsub;
  }, [exchange, symbol, key, setOrderbook]);

  useEffect(() => {
    recentTradesRef.current.clear();
    const channel = `trades:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe<RecentTrade>(channel, (data) => {
      if (!data.price) return;
      const map = recentTradesRef.current;
      const rounded = Math.round(data.price * 1e4) / 1e4;
      map.set(rounded, { ...data, time: Date.now() });
      const now = Date.now();
      for (const [k, v] of map) {
        if (now - v.time > 3000) map.delete(k);
      }
    });
    return unsub;
  }, [exchange, symbol]);

  // Scroll = navigate price levels (static) or no-op (dynamic)
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    if (mode === 'static') {
      setScrollOffset((prev) => prev + (e.deltaY > 0 ? 3 : -3));
    }
    // In dynamic mode scroll does nothing — price follows market
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
    setSearch('');
    setResults([]);
    setSearching(false);
    setScrollOffset(0);
  };

  const bids = orderbook?.bids ?? [];
  const asks = orderbook?.asks ?? [];
  const midPrice = bids[0]?.[0] && asks[0]?.[0]
    ? (bids[0][0] + asks[0][0]) / 2
    : bids[0]?.[0] ?? asks[0]?.[0] ?? 0;

  const steps = getTickSteps(midPrice);
  const tickSize = steps[Math.min(tickIdx, steps.length - 1)]!;

  const aggBids = aggregateLevels(bids, tickSize);
  const aggAsks = aggregateLevels(asks, tickSize);

  const containerH = ladderRef.current?.clientHeight ?? 400;
  const rowH = 17;
  const spreadRowH = mode === 'static' ? 22 : 0; // dynamic has no spread row
  const totalRows = Math.max(4, Math.floor((containerH - spreadRowH) / rowH));

  const bestAsk = asks[0]?.[0] ?? 0;
  const bestBid = bids[0]?.[0] ?? 0;
  const bestAskTick = bestAsk > 0 ? roundTick(Math.ceil(bestAsk / tickSize) * tickSize, tickSize) : 0;
  const bestBidTick = bestBid > 0 ? roundTick(Math.floor(bestBid / tickSize) * tickSize, tickSize) : 0;

  const dp = tickSize >= 1 ? 0 : tickSize >= 0.1 ? 1 : tickSize >= 0.01 ? 2 : tickSize >= 0.001 ? 3 : 4;
  const baseName = symbol.split('/')[0] ?? symbol;

  // Build price rows depending on mode
  let rows: Array<{ price: number; vol: number; side: 'ask' | 'bid' | 'spread' }> = [];

  if (mode === 'dynamic') {
    // Dynamic: single continuous ladder centered on mid price, moves with market
    const centerTick = roundTick(Math.round(midPrice / tickSize) * tickSize, tickSize);
    const offset = scrollOffset; // allow slight manual shift too
    for (let i = Math.floor(totalRows / 2); i >= -Math.ceil(totalRows / 2); i--) {
      const p = roundTick(centerTick + (i + offset) * tickSize, tickSize);
      const askVol = aggAsks.get(p) ?? 0;
      const bidVol = aggBids.get(p) ?? 0;
      if (askVol > 0 && bidVol > 0) {
        rows.push({ price: p, vol: askVol, side: 'ask' }); // overlap — show ask
      } else if (askVol > 0) {
        rows.push({ price: p, vol: askVol, side: 'ask' });
      } else if (bidVol > 0) {
        rows.push({ price: p, vol: bidVol, side: 'bid' });
      } else {
        // Empty level — determine side by position relative to mid
        rows.push({ price: p, vol: 0, side: p >= bestAskTick ? 'ask' : 'bid' });
      }
    }
  } else {
    // Static: split view with spread in middle
    const halfRows = Math.floor(totalRows / 2);
    const askRows: typeof rows = [];
    for (let i = halfRows - 1; i >= 0; i--) {
      const p = roundTick(bestAskTick + (i + scrollOffset) * tickSize, tickSize);
      askRows.push({ price: p, vol: aggAsks.get(p) ?? 0, side: 'ask' });
    }
    const bidRows: typeof rows = [];
    for (let i = 0; i < halfRows; i++) {
      const p = roundTick(bestBidTick - (i + scrollOffset) * tickSize, tickSize);
      bidRows.push({ price: p, vol: aggBids.get(p) ?? 0, side: 'bid' });
    }
    rows = [...askRows, { price: 0, vol: 0, side: 'spread' }, ...bidRows];
  }

  const maxVol = Math.max(...rows.filter((r) => r.side !== 'spread').map((r) => r.vol), 0.001);

  const getTradePrint = (price: number): RecentTrade | null => {
    const map = recentTradesRef.current;
    const now = Date.now();
    for (const [tp, trade] of map) {
      if (Math.abs(tp - price) <= tickSize * 0.6 && now - trade.time < 3000) return trade;
    }
    return null;
  };

  return (
    <div
      className={`bg-[#0c0c14] rounded border h-full flex flex-col ${isActive ? 'border-[#3a3a5a]' : 'border-[#1a1a2a]'}`}
      onWheel={handleWheel}
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
                    if (!r.length) { const res = await fetch(`${API_BASE}/api/markets/${exchange}/search?q=${encodeURIComponent(search)}`); r = await res.json() as string[]; }
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
            <div className="flex-1" />
            {/* Settings menu button */}
            <div className="relative">
              <button
                onClick={() => setShowMenu(!showMenu)}
                className={`text-[10px] px-1.5 py-0.5 rounded ${showMenu ? 'text-gray-200 bg-[#1e1e2e]' : 'text-gray-600 hover:text-gray-400'}`}
              >&#9881;</button>
              {showMenu && (
                <div className="absolute top-full right-0 mt-1 w-48 bg-[#12121e] border border-[#2a2a3a] rounded shadow-lg z-50 p-2 space-y-2"
                  onMouseLeave={() => setShowMenu(false)}
                >
                  {/* Mode toggle */}
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
                  {/* Tick grouping */}
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
                  {mode === 'static' && scrollOffset !== 0 && (
                    <button onClick={() => setScrollOffset(0)}
                      className="w-full text-[10px] text-gray-500 hover:text-gray-300 py-0.5"
                    >Center on market</button>
                  )}
                </div>
              )}
            </div>
            <span className="text-[9px] text-gray-600 font-mono">{tickSize}</span>
            <span className="text-[10px] text-gray-500 font-mono ml-0.5">
              {midPrice > 0 ? midPrice.toFixed(dp) : '—'}
            </span>
          </>
        )}
      </div>

      {/* DOM Ladder */}
      <div ref={ladderRef} className="flex-1 overflow-hidden flex flex-col font-mono text-[11px] leading-none select-none">
        {rows.map((row, i) => {
          if (row.side === 'spread') {
            return (
              <div key="spread" className="flex items-center justify-center border-y border-[#1e1e2e] bg-[#08080e] shrink-0" style={{ height: spreadRowH }}>
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
          const pct = (row.vol / maxVol) * 100;
          const trade = getTradePrint(row.price);
          const isBestBid = Math.abs(row.price - bestBidTick) < tickSize * 0.5;
          const isBestAsk = Math.abs(row.price - bestAskTick) < tickSize * 0.5;
          const highlight = (isBestBid || isBestAsk) ? 'bg-white/[0.03]' : '';

          return (
            <div key={`${row.side}${i}`} className={`flex items-center relative ${highlight}`} style={{ height: rowH }}>
              {/* Volume bar */}
              <div
                className={`absolute inset-y-0 ${isAsk ? 'left-0 bg-red-500/15' : 'right-0 bg-green-500/15'}`}
                style={{ width: `${pct}%` }}
              />
              {/* Trade print */}
              {trade && (
                <div className={`absolute ${isAsk ? 'left-0.5' : 'right-0.5'} top-1/2 -translate-y-1/2 rounded-full z-20 ${
                  trade.side === 'buy' ? 'bg-green-400' : 'bg-red-400'
                }`} style={{
                  width: Math.max(4, Math.min(14, Math.sqrt(trade.amount) * 4)),
                  height: Math.max(4, Math.min(14, Math.sqrt(trade.amount) * 4)),
                }} />
              )}
              {/* Ask volume */}
              <span className="w-[35%] text-right pr-1.5 relative z-10 tabular-nums" style={{
                color: isAsk && row.vol > 0 ? 'rgba(248,113,113,0.5)' : 'transparent',
              }}>
                {isAsk && row.vol > 0 ? row.vol.toFixed(row.vol > 100 ? 0 : 3) : ''}
              </span>
              {/* Price */}
              <span className={`w-[30%] text-center relative z-10 tabular-nums ${
                isAsk ? 'text-red-300' : 'text-green-300'
              } ${(isBestBid || isBestAsk) ? 'font-bold' : ''}`}>
                {row.price.toFixed(dp)}
              </span>
              {/* Bid volume */}
              <span className="w-[35%] pl-1.5 relative z-10 tabular-nums" style={{
                color: !isAsk && row.vol > 0 ? 'rgba(74,222,128,0.5)' : 'transparent',
              }}>
                {!isAsk && row.vol > 0 ? row.vol.toFixed(row.vol > 100 ? 0 : 3) : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
