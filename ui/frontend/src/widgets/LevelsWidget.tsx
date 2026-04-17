import { useEffect, useMemo, useState } from 'react';
import { wsClient, API_BASE } from '../lib/ws-client';
import { useMarketStore } from '../stores/market.store';

type LevelType = 'support' | 'resistance';
type LevelSource = 'orderbook' | 'swing' | 'both';

interface PriceLevel {
  price: number;
  type: LevelType;
  source: LevelSource;
  strength: number;
  timeframe?: string;
  volume?: number;
  touches: number;
  lastTouchTime: number;
  isSuspectedSpoof: boolean;
  exchange: string;
  symbol: string;
}

function formatPrice(p: number): string {
  if (p > 1000) return p.toFixed(1);
  if (p > 1) return p.toFixed(2);
  return p.toFixed(5);
}

function sourceBadge(src: LevelSource): string {
  if (src === 'both') return '⊕';
  if (src === 'orderbook') return 'OB';
  return 'SW';
}

export function LevelsWidget({ exchange, symbol }: { exchange: string; symbol: string }) {
  const [levels, setLevels] = useState<PriceLevel[]>([]);

  // Take current price from existing market store (orderbook mid)
  const key = `${exchange}:${symbol}`;
  const orderbook = useMarketStore((s) => s.orderbooks.get(key));
  const lastPrice = useMemo(() => {
    if (!orderbook) return 0;
    const bestBid = orderbook.bids?.[0]?.[0] ?? 0;
    const bestAsk = orderbook.asks?.[0]?.[0] ?? 0;
    if (bestBid && bestAsk) return (bestBid + bestAsk) / 2;
    return bestBid || bestAsk || 0;
  }, [orderbook]);

  useEffect(() => {
    setLevels([]);
    fetch(`${API_BASE}/api/snapshot/levels/${exchange}/${encodeURIComponent(symbol)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (Array.isArray(d)) setLevels(d as PriceLevel[]); })
      .catch(() => {});

    const channel = `levels:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe<PriceLevel[]>(channel, (d) => {
      if (Array.isArray(d)) setLevels(d);
    });
    return unsub;
  }, [exchange, symbol]);

  const baseName = symbol.split('/')[0] ?? symbol;

  const sorted = useMemo(() => {
    if (levels.length === 0) return [] as PriceLevel[];
    // Sort by price descending — resistance above price, support below
    return [...levels].sort((a, b) => b.price - a.price);
  }, [levels]);

  const maxStrength = useMemo(
    () => sorted.reduce((m, l) => (l.strength > m ? l.strength : m), 0) || 1,
    [sorted]
  );

  return (
    <div className="bg-[#0c0c14] rounded border border-[#1a1a2a] h-full overflow-hidden flex flex-col">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[#1a1a2a] shrink-0 text-[10px]">
        <span className="text-gray-400 uppercase tracking-wider">Key Levels — {baseName}</span>
        {lastPrice > 0 && (
          <span className="ml-auto text-cyan-300 font-mono">{formatPrice(lastPrice)}</span>
        )}
      </div>

      {sorted.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-xs">Waiting for levels...</div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {sorted.map((lvl, i) => {
            const isRes = lvl.type === 'resistance';
            const strengthPct = (lvl.strength / maxStrength) * 100;
            const dist = lastPrice > 0 ? ((lvl.price - lastPrice) / lastPrice) * 100 : 0;
            const colorTxt = isRes ? 'text-red-400' : 'text-emerald-400';
            const colorBar = isRes ? 'bg-red-500/60' : 'bg-emerald-500/60';
            const prevPrice = sorted[i - 1]?.price;
            const crossedPrice = prevPrice != null && lastPrice > 0 && prevPrice >= lastPrice && lvl.price < lastPrice;

            return (
              <div key={i}>
                {crossedPrice && (
                  <div className="h-px bg-cyan-400/40 relative">
                    <span className="absolute right-1 -top-[7px] text-[9px] font-mono text-cyan-400 bg-[#0c0c14] px-1">
                      {formatPrice(lastPrice)}
                    </span>
                  </div>
                )}
                <div
                  className={`flex items-center gap-2 px-2 h-[22px] text-[10px] font-mono border-b border-[#11111c] relative ${lvl.isSuspectedSpoof ? 'opacity-50' : ''}`}
                  title={`${lvl.type} @ ${formatPrice(lvl.price)}\nstrength ${lvl.strength.toFixed(1)}, touches ${lvl.touches}${lvl.timeframe ? `, tf ${lvl.timeframe}` : ''}${lvl.isSuspectedSpoof ? '\n⚠ suspected spoof' : ''}`}
                >
                  {/* Strength bar (background) */}
                  <div className="absolute inset-y-0 left-0 opacity-20 pointer-events-none">
                    <div className={`h-full ${colorBar}`} style={{ width: `${strengthPct * 2}px` }} />
                  </div>

                  <span className={`w-3 text-center shrink-0 ${colorTxt}`}>
                    {isRes ? '▲' : '▼'}
                  </span>
                  <span className={`w-16 shrink-0 ${colorTxt}`}>{formatPrice(lvl.price)}</span>
                  <span className="w-12 shrink-0 text-right text-gray-400">
                    {dist >= 0 ? '+' : ''}{dist.toFixed(2)}%
                  </span>
                  <span className="w-8 shrink-0 text-center text-gray-600 text-[9px]">
                    {sourceBadge(lvl.source)}
                  </span>
                  {lvl.timeframe && (
                    <span className="w-8 shrink-0 text-gray-500 text-[9px]">{lvl.timeframe}</span>
                  )}
                  <span className="ml-auto text-gray-600 text-[9px]">×{lvl.touches}</span>
                  {lvl.isSuspectedSpoof && (
                    <span className="text-[9px] text-yellow-500" title="Suspected spoof">⚠</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
