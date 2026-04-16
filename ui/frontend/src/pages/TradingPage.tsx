import { useState, useCallback, useEffect, useRef } from 'react';
import { API_BASE } from '../lib/ws-client';
import { OrderBookWidget } from '../widgets/OrderBookWidget';
import { TradesWidget } from '../widgets/TradesWidget';
import { TradeFormWidget } from '../widgets/TradeFormWidget';
import { DrawdownWidget } from '../widgets/DrawdownWidget';
import { ExposureWidget } from '../widgets/ExposureWidget';
import { AlertsWidget } from '../widgets/AlertsWidget';
import { HedgeWidget } from '../widgets/HedgeWidget';

const EXCHANGES = ['bybit', 'binance', 'okx'];

interface PanelConfig {
  exchange: string;
  symbol: string;
}

function SymbolSearch({
  exchange,
  placeholder,
  onSelect,
}: {
  exchange: string;
  placeholder?: string;
  onSelect: (symbol: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const doSearch = async (q: string) => {
    if (!q) { setResults([]); return []; }
    try {
      const res = await fetch(`${API_BASE}/api/markets/${exchange}/search?q=${encodeURIComponent(q)}`);
      const data = await res.json() as string[];
      setResults(data);
      setOpen(data.length > 0);
      return data;
    } catch {
      setResults([]);
      return [];
    }
  };

  return (
    <div ref={ref} className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => {
          const v = e.target.value.toUpperCase();
          setQuery(v);
          doSearch(v);
        }}
        onFocus={() => { if (results.length > 0) setOpen(true); else if (query) doSearch(query); }}
        onKeyDown={async (e) => {
          if (e.key !== 'Enter' || !query) return;
          e.preventDefault();
          let r = results;
          if (r.length === 0) r = await doSearch(query);
          if (r.length > 0) {
            onSelect(r[0]!);
            setQuery('');
            setOpen(false);
            setResults([]);
          }
        }}
        placeholder={placeholder ?? 'Search symbol...'}
        className="w-40 bg-[#0a0a14] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-[#4a4a6a]"
      />
      {open && results.length > 0 && (
        <div className="absolute top-full left-0 mt-1 w-64 max-h-60 overflow-y-auto bg-[#12121e] border border-[#2a2a3a] rounded shadow-lg z-50">
          {results.map((sym) => (
            <button
              key={sym}
              onClick={() => { onSelect(sym); setQuery(''); setOpen(false); setResults([]); }}
              className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-[#1e1e3e] hover:text-white transition-colors"
            >
              {sym}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TradingPage({ onOpenLogs }: { onOpenLogs?: () => void }) {
  const [panels, setPanels] = useState<PanelConfig[]>([
    { exchange: 'bybit', symbol: 'BTC/USDT:USDT' },
    { exchange: 'bybit', symbol: 'ETH/USDT:USDT' },
  ]);

  const [activePanel, setActivePanel] = useState(0);

  const updatePanel = useCallback((idx: number, update: Partial<PanelConfig>) => {
    setPanels((prev) => prev.map((p, i) => (i === idx ? { ...p, ...update } : p)));
  }, []);

  const addPanel = useCallback((symbol: string, exchange: string) => {
    setPanels((prev) => {
      const next = [...prev, { exchange, symbol }];
      setActivePanel(next.length - 1);
      return next;
    });
  }, []);

  const removePanel = useCallback((idx: number) => {
    setPanels((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((_, i) => i !== idx);
      setActivePanel((a) => Math.min(a, next.length - 1));
      return next;
    });
  }, []);

  const active = panels[activePanel] ?? panels[0]!;

  return (
    <div className="flex-1 p-2 grid grid-cols-12 grid-rows-[auto_1fr_auto] gap-2 min-h-0">
      {/* Top bar */}
      <div className="col-span-12 flex items-center gap-2 px-2 py-1 bg-[#0d0d14] rounded border border-[#1e1e2e] overflow-x-auto">
        <span className="text-sm font-bold text-white shrink-0">SunTerminal</span>
        <span className="text-xs text-gray-600 shrink-0">|</span>

        {/* Panel tabs */}
        <div className="flex gap-1 shrink-0">
          {panels.map((p, i) => (
            <button
              key={i}
              onClick={() => setActivePanel(i)}
              className={`px-2 py-0.5 rounded text-xs transition-colors ${
                i === activePanel
                  ? 'bg-[#1e1e3e] text-white border border-[#3a3a5a]'
                  : 'text-gray-500 hover:text-gray-300 border border-transparent'
              }`}
            >
              {p.symbol.split('/')[0]}
              {panels.length > 1 && (
                <span
                  onClick={(e) => { e.stopPropagation(); removePanel(i); }}
                  className="ml-1 text-gray-600 hover:text-red-400 cursor-pointer"
                >
                  x
                </span>
              )}
            </button>
          ))}
        </div>

        <span className="text-xs text-gray-600 shrink-0">|</span>

        {/* Exchange selector */}
        <select
          value={active.exchange}
          onChange={(e) => updatePanel(activePanel, { exchange: e.target.value })}
          className="bg-[#0a0a14] border border-[#2a2a3a] rounded px-1.5 py-1 text-xs text-gray-300 outline-none"
        >
          {EXCHANGES.map((ex) => (
            <option key={ex} value={ex}>{ex}</option>
          ))}
        </select>

        {/* Change active panel symbol */}
        <SymbolSearch
          exchange={active.exchange}
          placeholder="Change symbol..."
          onSelect={(sym) => updatePanel(activePanel, { symbol: sym })}
        />

        {/* Add new panel */}
        <SymbolSearch
          exchange={active.exchange}
          placeholder="+ Add orderbook..."
          onSelect={(sym) => addPanel(sym, active.exchange)}
        />

        <div className="flex-1" />
        {onOpenLogs && (
          <button
            onClick={onOpenLogs}
            className="px-2 py-0.5 rounded text-xs text-gray-500 hover:text-gray-200 border border-[#2a2a3a] hover:border-[#4a4a6a] shrink-0"
          >
            Logs
          </button>
        )}
        <span className="text-xs text-gray-600 shrink-0">Ctrl+L: logs | Ctrl+Shift+K: emergency</span>
      </div>

      {/* Order books */}
      <div className="col-span-8 row-span-1 overflow-hidden">
        <div className="h-full grid gap-2 overflow-hidden" style={{
          gridTemplateColumns: `repeat(${Math.min(panels.length, 4)}, 1fr)`,
        }}>
          {panels.map((p, i) => (
            <div
              key={`${p.exchange}:${p.symbol}:${i}`}
              className={`overflow-hidden rounded cursor-pointer ${
                i === activePanel ? 'ring-1 ring-[#3a3a5a]' : ''
              }`}
              onClick={() => setActivePanel(i)}
            >
              <OrderBookWidget exchange={p.exchange} symbol={p.symbol} />
            </div>
          ))}
        </div>
      </div>

      {/* Right sidebar */}
      <div className="col-span-4 row-span-1 space-y-2 overflow-y-auto">
        <TradesWidget exchange={active.exchange} symbol={active.symbol} />
        <TradeFormWidget exchange={active.exchange} symbol={active.symbol} />
        <DrawdownWidget />
        <ExposureWidget />
      </div>

      {/* Bottom panels */}
      <div className="col-span-6">
        <AlertsWidget />
      </div>
      <div className="col-span-6">
        <HedgeWidget />
      </div>
    </div>
  );
}
