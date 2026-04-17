import { useEffect, useState } from 'react';
import { wsClient, API_BASE } from '../lib/ws-client';

type VolatilityRegime = 'LOW_VOL' | 'NORMAL' | 'HIGH_VOL' | 'EXTREME_VOL';

interface VolatilityData {
  exchange: string;
  symbol: string;
  atr: number;
  atrPercent: number;
  historicalVol: number;
  realtimeVol: number;
  regime: VolatilityRegime;
  percentile: number;
  timestamp: number;
}

const REGIME_LABEL: Record<VolatilityRegime, string> = {
  LOW_VOL: 'LOW',
  NORMAL: 'NORMAL',
  HIGH_VOL: 'HIGH',
  EXTREME_VOL: 'EXTREME',
};

const REGIME_CLASS: Record<VolatilityRegime, string> = {
  LOW_VOL: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  NORMAL: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
  HIGH_VOL: 'text-orange-400 bg-orange-500/10 border-orange-500/30',
  EXTREME_VOL: 'text-red-400 bg-red-500/10 border-red-500/30',
};

function fmtPct(v: number, digits = 2): string {
  return v.toFixed(digits) + '%';
}

export function VolatilityWidget({ exchange, symbol }: { exchange: string; symbol: string }) {
  const [data, setData] = useState<VolatilityData | null>(null);

  useEffect(() => {
    setData(null);
    fetch(`${API_BASE}/api/snapshot/volatility/${exchange}/${encodeURIComponent(symbol)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.regime) setData(d as VolatilityData); })
      .catch(() => {});

    const channel = `volatility:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe<VolatilityData>(channel, (d) => {
      if (d?.regime) setData(d);
    });
    return unsub;
  }, [exchange, symbol]);

  const baseName = symbol.split('/')[0] ?? symbol;
  const pct = data?.percentile ?? 0;

  return (
    <div className="bg-[#0c0c14] rounded border border-[#1a1a2a] h-full overflow-hidden flex flex-col">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[#1a1a2a] shrink-0 text-[10px]">
        <span className="text-gray-400 uppercase tracking-wider">Volatility — {baseName}</span>
        {data && (
          <span className={`ml-auto px-1.5 py-[1px] rounded border text-[9px] font-mono tracking-wider ${REGIME_CLASS[data.regime]}`}>
            {REGIME_LABEL[data.regime]}
          </span>
        )}
      </div>

      {!data ? (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-xs">Waiting...</div>
      ) : (
        <div className="flex-1 min-h-0 p-2 flex flex-col gap-2">
          {/* ATR % big */}
          <div className="text-center">
            <div className="font-mono text-2xl text-gray-100">{fmtPct(data.atrPercent)}</div>
            <div className="text-[9px] uppercase tracking-wider text-gray-500 mt-0.5">ATR %</div>
          </div>

          {/* Percentile bar */}
          <div>
            <div className="flex justify-between text-[9px] uppercase tracking-wider text-gray-500 mb-1">
              <span>30-day percentile</span>
              <span className="font-mono text-gray-300">{pct.toFixed(0)}%</span>
            </div>
            <div className="h-1.5 bg-[#11111c] rounded overflow-hidden relative">
              <div
                className={`h-full ${
                  pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-orange-400' : pct > 40 ? 'bg-cyan-400' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
              />
            </div>
          </div>

          {/* Secondary stats */}
          <div className="grid grid-cols-3 gap-1 text-[10px] font-mono mt-auto">
            <div className="bg-[#11111c] rounded px-2 py-1">
              <div className="text-gray-500 text-[9px] uppercase tracking-wider">ATR</div>
              <div className="text-gray-300">{data.atr.toFixed(data.atr > 10 ? 1 : 4)}</div>
            </div>
            <div className="bg-[#11111c] rounded px-2 py-1">
              <div className="text-gray-500 text-[9px] uppercase tracking-wider">Hist Vol</div>
              <div className="text-gray-300">{fmtPct(data.historicalVol, 1)}</div>
            </div>
            <div className="bg-[#11111c] rounded px-2 py-1">
              <div className="text-gray-500 text-[9px] uppercase tracking-wider">RT Vol</div>
              <div className="text-gray-300">{fmtPct(data.realtimeVol, 1)}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
