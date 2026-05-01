import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../../lib/ws-client';
import { EXCHANGES } from '../../stores/sync.store';

export interface SymbolPickerProps {
  exchange: string;
  symbol: string;
  onChange: (next: { exchange: string; symbol: string }) => void;
  /** Compact mode: hide exchange badge in collapsed state. */
  compact?: boolean;
  /** If set, shows a colored dot indicating the sync group. */
  groupColor?: string | null;
  className?: string;
}

function baseName(symbol: string): string {
  return symbol.split('/')[0] ?? symbol;
}

export function SymbolPicker({
  exchange,
  symbol,
  onChange,
  compact = false,
  groupColor = null,
  className = '',
}: SymbolPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [draftExchange, setDraftExchange] = useState(exchange);
  const [error, setError] = useState(false);
  const blurTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraftExchange(exchange);
    setQuery('');
    setResults([]);
    setError(false);
  }, [open, exchange]);

  useEffect(() => {
    if (!open || !query) {
      setResults([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/api/markets/${draftExchange}/search?q=${encodeURIComponent(query)}`,
        );
        const list = (await res.json()) as string[];
        if (!cancelled) setResults(list);
      } catch {
        if (!cancelled) setResults([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, query, draftExchange]);

  const select = (sym: string) => {
    onChange({ exchange: draftExchange, symbol: sym });
    setOpen(false);
  };

  const close = () => {
    setOpen(false);
    setQuery('');
    setResults([]);
    setError(false);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Click to change symbol"
        className={`flex items-center gap-1 text-left text-xs font-bold text-gray-200 hover:text-white truncate ${className}`}
      >
        {groupColor && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: groupColor }}
          />
        )}
        <span className="truncate">{baseName(symbol)}</span>
        {!compact && (
          <span className="text-[10px] text-gray-600 ml-0.5 shrink-0">{exchange}</span>
        )}
      </button>
    );
  }

  return (
    <div className={`relative flex-1 min-w-0 ${className}`}>
      <div className="flex gap-1">
        <select
          value={draftExchange}
          onChange={(e) => setDraftExchange(e.target.value)}
          className="bg-[#0a0a14] border border-[#2a2a3a] rounded px-1 py-0.5 text-[10px] text-gray-400 outline-none w-16 shrink-0"
        >
          {EXCHANGES.map((ex) => (
            <option key={ex} value={ex}>
              {ex}
            </option>
          ))}
        </select>
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value.toUpperCase());
            setError(false);
          }}
          onKeyDown={async (e) => {
            if (e.key === 'Escape') {
              close();
              return;
            }
            if (e.key === 'Enter' && query) {
              let r = results;
              if (!r.length) {
                try {
                  const res = await fetch(
                    `${API_BASE}/api/markets/${draftExchange}/search?q=${encodeURIComponent(query)}`,
                  );
                  r = (await res.json()) as string[];
                } catch {
                  r = [];
                }
              }
              if (r.length) select(r[0]!);
              else setError(true);
            }
          }}
          onFocus={() => {
            if (blurTimer.current) {
              window.clearTimeout(blurTimer.current);
              blurTimer.current = null;
            }
          }}
          onBlur={() => {
            blurTimer.current = window.setTimeout(close, 200);
          }}
          placeholder="Search symbol..."
          className={`flex-1 min-w-0 bg-[#0a0a14] border rounded px-1.5 py-0.5 text-xs text-gray-200 placeholder-gray-600 outline-none ${
            error ? 'border-red-500' : 'border-[#2a2a3a] focus:border-[#4a4a6a]'
          }`}
        />
      </div>
      {results.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-[#12121e] border border-[#2a2a3a] rounded shadow-lg z-50">
          {results.map((sym) => (
            <button
              key={sym}
              onMouseDown={(e) => {
                e.preventDefault();
                select(sym);
              }}
              className="w-full text-left px-2 py-1 text-xs text-gray-300 hover:bg-[#1e1e3e] hover:text-white"
            >
              {sym}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
