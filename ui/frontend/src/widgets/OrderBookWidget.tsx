import { useEffect } from 'react';
import { wsClient } from '../lib/ws-client';
import { useMarketStore } from '../stores/market.store';

export function OrderBookWidget({ exchange, symbol }: { exchange: string; symbol: string }) {
  const key = `${exchange}:${symbol}`;
  const orderbook = useMarketStore((s) => s.orderbooks.get(key));
  const setOrderbook = useMarketStore((s) => s.setOrderbook);

  useEffect(() => {
    const channel = `orderbook:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe(channel, (data) => {
      setOrderbook(key, data as any);
    });
    return unsub;
  }, [exchange, symbol, key, setOrderbook]);

  const bids = orderbook?.bids?.slice(0, 15) ?? [];
  const asks = orderbook?.asks?.slice(0, 15) ?? [];
  const maxVol = Math.max(
    ...bids.map((b) => b[1] ?? 0),
    ...asks.map((a) => a[1] ?? 0),
    1
  );

  return (
    <div className="bg-[#111118] rounded border border-[#1e1e2e] p-3 h-full">
      <div className="text-xs text-gray-400 mb-2 font-semibold uppercase tracking-wider">
        Order Book — {exchange} {symbol}
      </div>

      <div className="grid grid-cols-2 gap-1 text-[11px]">
        <div className="text-center text-gray-500 mb-1">Bids</div>
        <div className="text-center text-gray-500 mb-1">Asks</div>

        <div className="space-y-px">
          {bids.map(([price, vol], i) => (
            <div key={i} className="flex justify-between relative px-1 py-px">
              <div
                className="absolute inset-y-0 right-0 bg-green-900/30"
                style={{ width: `${((vol ?? 0) / maxVol) * 100}%` }}
              />
              <span className="relative text-green-400">{price?.toFixed(1)}</span>
              <span className="relative text-gray-400">{vol?.toFixed(4)}</span>
            </div>
          ))}
        </div>

        <div className="space-y-px">
          {asks.map(([price, vol], i) => (
            <div key={i} className="flex justify-between relative px-1 py-px">
              <div
                className="absolute inset-y-0 left-0 bg-red-900/30"
                style={{ width: `${((vol ?? 0) / maxVol) * 100}%` }}
              />
              <span className="relative text-gray-400">{vol?.toFixed(4)}</span>
              <span className="relative text-red-400">{price?.toFixed(1)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
