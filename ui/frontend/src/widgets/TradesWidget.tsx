import { useEffect, useState } from 'react';
import { wsClient } from '../lib/ws-client';

interface Trade {
  price: number;
  amount: number;
  side: string;
  timestamp: number;
}

export function TradesWidget({ exchange, symbol }: { exchange: string; symbol: string }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const maxTrades = 40;

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

  return (
    <div className="bg-[#111118] rounded border border-[#1e1e2e] p-3 h-full overflow-hidden">
      <div className="text-xs text-gray-400 mb-2 font-semibold uppercase tracking-wider">
        Trades — {symbol.split('/')[0]}
      </div>

      <div className="grid grid-cols-3 text-[10px] text-gray-600 mb-1 px-1">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Time</span>
      </div>

      <div className="space-y-px overflow-y-auto max-h-[calc(100%-2rem)]">
        {trades.length === 0 && (
          <div className="text-gray-600 text-center py-4 text-xs">Waiting for trades...</div>
        )}
        {[...trades].reverse().map((t, i) => {
          const time = new Date(t.timestamp).toLocaleTimeString('en-GB', {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
          });
          const isBuy = t.side === 'buy';
          return (
            <div key={i} className="grid grid-cols-3 text-[11px] px-1 py-px">
              <span className={isBuy ? 'text-green-400' : 'text-red-400'}>
                {t.price.toFixed(2)}
              </span>
              <span className="text-right text-gray-400">{t.amount.toFixed(4)}</span>
              <span className="text-right text-gray-600">{time}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
