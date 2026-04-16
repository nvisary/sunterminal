import { useEffect, useState } from 'react';
import { wsClient } from '../lib/ws-client';

interface Trade {
  price: number;
  amount: number;
  cost: number;
  side: string;
  timestamp: number;
}

export function TradesWidget({ exchange, symbol }: { exchange: string; symbol: string }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const maxTrades = 50;

  useEffect(() => {
    setTrades([]);
    const channel = `trades:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe(channel, (data) => {
      const t = data as unknown as Trade;
      if (!t.price) return;
      setTrades((prev) => [...prev.slice(-(maxTrades - 1)), t]);
    });
    return unsub;
  }, [exchange, symbol]);

  // Calculate max amount for bubble sizing
  const maxAmount = Math.max(...trades.map((t) => t.amount || 0), 0.001);

  const baseName = symbol.split('/')[0] ?? symbol;

  return (
    <div className="bg-[#0c0c14] rounded border border-[#1a1a2a] p-2 h-full overflow-hidden flex flex-col">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5 px-1 shrink-0">
        Trades — {baseName}
      </div>

      <div className="flex-1 overflow-y-auto space-y-px">
        {trades.length === 0 && (
          <div className="text-gray-600 text-center py-6 text-xs">Waiting...</div>
        )}
        {[...trades].reverse().map((t, i) => {
          const isBuy = t.side === 'buy';
          // Bubble size: min 6px, max 28px based on relative amount
          const relSize = Math.sqrt(t.amount / maxAmount);
          const bubbleSize = Math.max(6, Math.min(28, relSize * 28));
          const time = new Date(t.timestamp).toLocaleTimeString('en-GB', {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
          });

          return (
            <div key={i} className="flex items-center gap-1.5 px-1 h-5">
              {/* Bubble */}
              <div className="w-8 flex justify-center shrink-0">
                <div
                  className={`rounded-full ${isBuy ? 'bg-green-500/70' : 'bg-red-500/70'}`}
                  style={{ width: bubbleSize, height: bubbleSize }}
                />
              </div>
              {/* Price */}
              <span className={`text-[11px] font-mono w-20 ${isBuy ? 'text-green-400' : 'text-red-400'}`}>
                {t.price.toFixed(t.price > 1000 ? 1 : t.price > 1 ? 2 : 4)}
              </span>
              {/* Amount */}
              <span className="text-[10px] font-mono text-gray-500 w-16 text-right">
                {t.amount.toFixed(4)}
              </span>
              {/* Time */}
              <span className="text-[10px] text-gray-600 ml-auto">{time}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
