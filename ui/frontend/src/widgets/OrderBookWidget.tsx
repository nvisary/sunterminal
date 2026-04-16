import { useEffect, useState, useCallback, useRef } from 'react';
import { wsClient, API_BASE } from '../lib/ws-client';
import { useMarketStore } from '../stores/market.store';

interface OrderBookWidgetProps {
  exchange: string;
  symbol: string;
  isActive?: boolean;
  onChangeSymbol?: (symbol: string) => void;
  onChangeExchange?: (exchange: string) => void;
}

const EXCHANGES = ['bybit', 'binance', 'okx'];

// Tick grouping steps per price magnitude
function getTickSteps(price: number): number[] {
  if (price > 10000) return [0.1, 0.5, 1, 5, 10, 50, 100];
  if (price > 1000) return [0.1, 0.5, 1, 5, 10, 50];
  if (price > 100) return [0.01, 0.05, 0.1, 0.5, 1, 5];
  if (price > 10) return [0.001, 0.005, 0.01, 0.05, 0.1, 0.5];
  if (price > 1) return [0.0001, 0.001, 0.005, 0.01, 0.05, 0.1];
  return [0.00001, 0.0001, 0.001, 0.01];
}

// Aggregate levels by tick size
function aggregateLevels(levels: number[][], tickSize: number): Map<number, number> {
  const map = new Map<number, number>();
  for (const [price, vol] of levels) {
    if (price == null || vol == null) continue;
    const key = Math.round(Math.floor(price / tickSize) * tickSize * 1e8) / 1e8;
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

export function OrderBookWidget({ exchange, symbol, isActive, onChangeSymbol, onChangeExchange }: OrderBookWidgetProps) {
  const key = `${exchange}:${symbol}`;
  const orderbook = useMarketStore((s) => s.orderbooks.get(key));
  const setOrderbook = useMarketStore((s) => s.setOrderbook);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [tickIdx, setTickIdx] = useState(2); // index into tick steps
  const ladderRef = useRef<HTMLDivElement>(null);
  const recentTradesRef = useRef<Map<number, RecentTrade>>(new Map());

  useEffect(() => {
    const channel = `orderbook:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe(channel, (data) => {
      setOrderbook(key, data as any);
    });
    return unsub;
  }, [exchange, symbol, key, setOrderbook]);

  // Subscribe to trades for prints on DOM
  useEffect(() => {
    recentTradesRef.current.clear();
    const channel = `trades:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe(channel, (data) => {
      const t = data as unknown as RecentTrade;
      if (!t.price) return;
      const map = recentTradesRef.current;
      // Keep last trade per price level (for display)
      const rounded = Math.round(t.price * 1e4) / 1e4;
      map.set(rounded, { ...t, time: Date.now() });
      // Cleanup old trades (> 3s)
      const now = Date.now();
      for (const [k, v] of map) {
        if (now - v.time > 3000) map.delete(k);
      }
    });
    return unsub;
  }, [exchange, symbol]);

  // Mouse wheel = change tick grouping
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const bids = orderbook?.bids ?? [];
    const midP = bids[0]?.[0] ?? 0;
    const steps = getTickSteps(midP);
    setTickIdx((prev) => Math.max(0, Math.min(steps.length - 1, prev + (e.deltaY > 0 ? 1 : -1))));
  }, [orderbook]);

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
  };

  const bids = orderbook?.bids ?? [];
  const asks = orderbook?.asks ?? [];
  const midPrice = bids[0]?.[0] && asks[0]?.[0]
    ? (bids[0][0] + asks[0][0]) / 2
    : bids[0]?.[0] ?? asks[0]?.[0] ?? 0;

  const steps = getTickSteps(midPrice);
  const tickSize = steps[Math.min(tickIdx, steps.length - 1)]!;

  // Aggregate raw levels into tick-grouped map
  const aggBids = aggregateLevels(bids, tickSize);
  const aggAsks = aggregateLevels(asks, tickSize);

  // Calculate how many rows fit
  const containerH = ladderRef.current?.clientHeight ?? 400;
  const rowH = 17;
  const spreadRowH = 22;
  const totalRows = Math.max(4, Math.floor((containerH - spreadRowH) / rowH));
  const halfRows = Math.floor(totalRows / 2);

  // Build complete price ladder from best bid/ask outward
  // Fill every tick step even if volume is 0
  const bestAsk = asks[0]?.[0] ?? 0;
  const bestBid = bids[0]?.[0] ?? 0;
  const bestAskTick = bestAsk > 0 ? Math.ceil(bestAsk / tickSize) * tickSize : 0;
  const bestBidTick = bestBid > 0 ? Math.floor(bestBid / tickSize) * tickSize : 0;

  const askDisplay: number[] = [];
  for (let i = halfRows - 1; i >= 0; i--) {
    const p = Math.round((bestAskTick + i * tickSize) * 1e8) / 1e8;
    askDisplay.push(p);
  }

  const bidDisplay: number[] = [];
  for (let i = 0; i < halfRows; i++) {
    const p = Math.round((bestBidTick - i * tickSize) * 1e8) / 1e8;
    bidDisplay.push(p);
  }

  const maxVol = Math.max(
    ...askDisplay.map((p) => aggAsks.get(p) ?? 0),
    ...bidDisplay.map((p) => aggBids.get(p) ?? 0),
    0.001
  );

  const dp = tickSize >= 1 ? 0 : tickSize >= 0.1 ? 1 : tickSize >= 0.01 ? 2 : tickSize >= 0.001 ? 3 : 4;
  const baseName = symbol.split('/')[0] ?? symbol;

  // Check if a trade print exists near a price level
  const getTradePrint = (price: number): RecentTrade | null => {
    const map = recentTradesRef.current;
    const now = Date.now();
    // Find trade within tick range
    for (const [tp, trade] of map) {
      if (Math.abs(tp - price) <= tickSize && now - trade.time < 3000) {
        return trade;
      }
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
            {/* Tick size indicator */}
            <span className="text-[9px] text-gray-600 font-mono" title="Scroll to change tick grouping">
              tick {tickSize}
            </span>
            <span className="text-[10px] text-gray-500 font-mono ml-1">
              {midPrice > 0 ? midPrice.toFixed(dp) : '—'}
            </span>
          </>
        )}
      </div>

      {/* DOM Ladder */}
      <div ref={ladderRef} className="flex-1 overflow-hidden flex flex-col font-mono text-[11px] leading-none select-none">
        {/* Asks (lowest at bottom) */}
        <div className="flex-1 flex flex-col justify-end overflow-hidden">
          {askDisplay.map((price) => {
            const vol = aggAsks.get(price) ?? 0;
            const pct = (vol / maxVol) * 100;
            const trade = getTradePrint(price);
            return (
              <div key={`a${price}`} className="flex items-center relative group" style={{ height: rowH }}>
                {/* Volume bar */}
                <div className="absolute inset-y-0 left-0 bg-red-500/15 transition-all duration-75"
                  style={{ width: `${pct}%` }} />
                {/* Trade print */}
                {trade && (
                  <div className={`absolute left-0.5 top-1/2 -translate-y-1/2 rounded-full z-20 ${
                    trade.side === 'buy' ? 'bg-green-400' : 'bg-red-400'
                  }`} style={{ width: Math.max(4, Math.min(12, Math.sqrt(trade.amount) * 4)), height: Math.max(4, Math.min(12, Math.sqrt(trade.amount) * 4)) }} />
                )}
                {/* Volume */}
                <span className="w-[35%] text-right pr-1.5 text-red-400/50 relative z-10 tabular-nums">
                  {vol > 0 ? vol.toFixed(vol > 100 ? 0 : 3) : ''}
                </span>
                {/* Price */}
                <span className="w-[30%] text-center text-red-300 relative z-10 tabular-nums">
                  {price.toFixed(dp)}
                </span>
                {/* Empty bid side */}
                <span className="w-[35%] relative z-10" />
              </div>
            );
          })}
        </div>

        {/* Spread */}
        <div className="flex items-center justify-center border-y border-[#1e1e2e] bg-[#08080e] shrink-0" style={{ height: spreadRowH }}>
          {bids[0]?.[0] && asks[0]?.[0] ? (
            <span className="text-[10px]">
              <span className="text-yellow-500/80 font-bold">{(asks[0][0] - bids[0][0]).toFixed(dp)}</span>
              <span className="text-gray-600 ml-1">({((asks[0][0] - bids[0][0]) / bids[0][0] * 100).toFixed(3)}%)</span>
            </span>
          ) : <span className="text-[10px] text-gray-600">—</span>}
        </div>

        {/* Bids */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {bidDisplay.map((price) => {
            const vol = aggBids.get(price) ?? 0;
            const pct = (vol / maxVol) * 100;
            const trade = getTradePrint(price);
            return (
              <div key={`b${price}`} className="flex items-center relative group" style={{ height: rowH }}>
                {/* Volume bar (from right) */}
                <div className="absolute inset-y-0 right-0 bg-green-500/15 transition-all duration-75"
                  style={{ width: `${pct}%` }} />
                {/* Empty ask side */}
                <span className="w-[35%] relative z-10" />
                {/* Price */}
                <span className="w-[30%] text-center text-green-300 relative z-10 tabular-nums">
                  {price.toFixed(dp)}
                </span>
                {/* Volume */}
                <span className="w-[35%] pl-1.5 text-green-400/50 relative z-10 tabular-nums">
                  {vol > 0 ? vol.toFixed(vol > 100 ? 0 : 3) : ''}
                </span>
                {/* Trade print */}
                {trade && (
                  <div className={`absolute right-0.5 top-1/2 -translate-y-1/2 rounded-full z-20 ${
                    trade.side === 'buy' ? 'bg-green-400' : 'bg-red-400'
                  }`} style={{ width: Math.max(4, Math.min(12, Math.sqrt(trade.amount) * 4)), height: Math.max(4, Math.min(12, Math.sqrt(trade.amount) * 4)) }} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
