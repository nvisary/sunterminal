import { useEffect, useRef, useState } from 'react';
import { wsClient } from '../lib/ws-client';

interface Trade {
  price: number;
  amount: number;
  cost: number;
  side: string;
  timestamp: number;
}

const MAX_TRADES = 80;

function formatPrice(p: number): string {
  if (p > 1000) return p.toFixed(1);
  if (p > 1) return p.toFixed(2);
  return p.toFixed(5);
}

function formatAmount(a: number): string {
  if (a >= 1000) return (a / 1000).toFixed(2) + 'k';
  if (a >= 10) return a.toFixed(2);
  if (a >= 1) return a.toFixed(3);
  return a.toFixed(4);
}

export function TradesWidget({ exchange, symbol }: { exchange: string; symbol: string }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTrades([]);
    const channel = `trades:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe<Trade>(channel, (data) => {
      if (!data.price) return;
      setTrades((prev) => {
        const next = prev.length >= MAX_TRADES ? prev.slice(prev.length - MAX_TRADES + 1) : prev.slice();
        next.push(data);
        return next;
      });
    });
    return unsub;
  }, [exchange, symbol]);

  // Auto-scroll to rightmost (newest) on update
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
  }, [trades]);

  const baseName = symbol.split('/')[0] ?? symbol;

  const maxAmount = trades.reduce((m, t) => (t.amount > m ? t.amount : m), 0.001);
  const lastTrade = trades[trades.length - 1];

  return (
    <div className="bg-[#0c0c14] rounded border border-[#1a1a2a] h-full overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-2 py-1 border-b border-[#1a1a2a] shrink-0 text-[10px]">
        <span className="text-gray-400 uppercase tracking-wider">Tape — {baseName}</span>
        <span className="text-gray-600">{trades.length} prints</span>
        {lastTrade && (
          <span className={`ml-auto font-mono text-[11px] ${lastTrade.side === 'buy' ? 'text-green-400' : 'text-red-400'}`}>
            {formatPrice(lastTrade.price)}
          </span>
        )}
      </div>

      {/* Horizontal bubble tape */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
        {trades.length === 0 ? (
          <div className="h-full flex items-center justify-center text-gray-600 text-xs">Waiting for trades...</div>
        ) : (
          <div className="h-full flex items-center gap-1 px-2 py-1" style={{ minWidth: '100%' }}>
            {trades.map((t, i) => {
              const isBuy = t.side === 'buy';
              const rel = Math.sqrt(t.amount / maxAmount);
              // Bubble area grows with √volume; container controls visual max via CSS
              const size = Math.max(8, Math.min(56, rel * 56));
              const time = new Date(t.timestamp).toLocaleTimeString('en-GB', {
                hour: '2-digit', minute: '2-digit', second: '2-digit',
              });
              return (
                <div
                  key={i}
                  className="flex flex-col items-center justify-center shrink-0 group"
                  style={{ width: Math.max(28, size + 6) }}
                  title={`${time}\n${isBuy ? 'BUY' : 'SELL'}  ${formatAmount(t.amount)} @ ${formatPrice(t.price)}`}
                >
                  <div
                    className={`rounded-full ${isBuy ? 'bg-green-500/70 group-hover:bg-green-400' : 'bg-red-500/70 group-hover:bg-red-400'}`}
                    style={{
                      width: size,
                      height: size,
                      boxShadow: size > 28 ? `0 0 ${Math.round(size / 3)}px ${isBuy ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)'}` : undefined,
                    }}
                  />
                  <span className={`text-[9px] font-mono mt-0.5 ${isBuy ? 'text-green-400' : 'text-red-400'}`}>
                    {formatPrice(t.price)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
