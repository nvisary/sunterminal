import { useEffect, useState } from 'react';
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

export function OrderBookWidget({ exchange, symbol, isActive, onChangeSymbol, onChangeExchange }: OrderBookWidgetProps) {
  const key = `${exchange}:${symbol}`;
  const orderbook = useMarketStore((s) => s.orderbooks.get(key));
  const setOrderbook = useMarketStore((s) => s.setOrderbook);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const channel = `orderbook:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe(channel, (data) => {
      setOrderbook(key, data as any);
    });
    return unsub;
  }, [exchange, symbol, key, setOrderbook]);

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

  const askLevels = asks.slice(0, 15).reverse();
  const bidLevels = bids.slice(0, 15);
  const maxVol = Math.max(
    ...bidLevels.map((b) => b[1] ?? 0),
    ...askLevels.map((a) => a[1] ?? 0),
    0.001
  );

  const dp = midPrice > 1000 ? 1 : midPrice > 1 ? 2 : 4;
  const baseName = symbol.split('/')[0] ?? symbol;

  return (
    <div className={`bg-[#0c0c14] rounded border h-full flex flex-col ${isActive ? 'border-[#3a3a5a]' : 'border-[#1a1a2a]'}`}>
      {/* Header */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[#1a1a2a] shrink-0">
        {searching ? (
          <div className="flex-1 relative">
            <div className="flex gap-1">
              <select
                value={exchange}
                onChange={(e) => onChangeExchange?.(e.target.value)}
                className="bg-[#0a0a14] border border-[#2a2a3a] rounded px-1 py-0.5 text-[10px] text-gray-400 outline-none w-16"
              >
                {EXCHANGES.map((ex) => <option key={ex} value={ex}>{ex}</option>)}
              </select>
              <input
                autoFocus
                type="text"
                value={search}
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
          <button onClick={() => setSearching(true)}
            className="flex-1 text-left text-xs font-bold text-gray-200 hover:text-white truncate"
            title="Click to change symbol"
          >
            {baseName}
            <span className="text-[10px] text-gray-600 ml-1.5">{exchange}</span>
          </button>
        )}
        <span className="text-[10px] text-gray-500 font-mono shrink-0">
          {midPrice > 0 ? midPrice.toFixed(dp) : '—'}
        </span>
      </div>

      {/* Scalper ladder */}
      <div className="flex-1 overflow-hidden flex flex-col font-mono text-[11px] leading-none">
        {/* Column headers */}
        <div className="flex items-center h-4 text-[9px] text-gray-600 uppercase tracking-wider px-1 shrink-0">
          <span className="w-1/3 text-right pr-1">Vol</span>
          <span className="w-1/3 text-center">Price</span>
          <span className="w-1/3 pl-1">Vol</span>
        </div>

        {/* Asks (lowest at bottom) */}
        <div className="flex-1 flex flex-col justify-end overflow-hidden">
          {askLevels.map(([price, vol], i) => (
            <div key={`a${i}`} className="flex items-center h-[17px] relative">
              <div className="absolute inset-y-0 right-1/2 bg-red-500/10"
                style={{ width: `${((vol ?? 0) / maxVol) * 50}%` }} />
              <span className="w-1/3 text-right pr-1 text-red-400/60 relative z-10">{(vol ?? 0).toFixed(3)}</span>
              <span className="w-1/3 text-center text-red-400 relative z-10">{(price ?? 0).toFixed(dp)}</span>
              <span className="w-1/3 relative z-10" />
            </div>
          ))}
        </div>

        {/* Spread */}
        <div className="h-5 flex items-center justify-center border-y border-[#1e1e2e] bg-[#08080e] shrink-0">
          {bids[0]?.[0] && asks[0]?.[0] ? (
            <span className="text-[10px] text-yellow-500/80 font-bold">
              {(asks[0][0] - bids[0][0]).toFixed(dp)}
              <span className="text-gray-600 font-normal ml-1">
                ({((asks[0][0] - bids[0][0]) / bids[0][0] * 100).toFixed(3)}%)
              </span>
            </span>
          ) : <span className="text-[10px] text-gray-600">—</span>}
        </div>

        {/* Bids */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {bidLevels.map(([price, vol], i) => (
            <div key={`b${i}`} className="flex items-center h-[17px] relative">
              <div className="absolute inset-y-0 left-1/2 bg-green-500/10"
                style={{ width: `${((vol ?? 0) / maxVol) * 50}%` }} />
              <span className="w-1/3 relative z-10" />
              <span className="w-1/3 text-center text-green-400 relative z-10">{(price ?? 0).toFixed(dp)}</span>
              <span className="w-1/3 pl-1 text-green-400/60 relative z-10">{(vol ?? 0).toFixed(3)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
