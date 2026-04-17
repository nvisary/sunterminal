import { useEffect, useState } from 'react';
import { wsClient, API_BASE } from '../lib/ws-client';

interface FundingData {
  exchange: string;
  symbol: string;
  rate: number;
  predictedRate: number | null;
  nextFundingTime: number;
  interval: 1 | 4 | 8;
  annualizedRate: number;
  timestamp: number;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function toPct(rate: number): string {
  return (rate * 100).toFixed(4) + '%';
}

function rateClass(rate: number): string {
  if (Math.abs(rate) > 0.001) return rate > 0 ? 'text-red-400' : 'text-green-400';
  if (Math.abs(rate) > 0.0003) return rate > 0 ? 'text-orange-400' : 'text-emerald-400';
  return 'text-gray-300';
}

export function FundingWidget({ exchange, symbol }: { exchange: string; symbol: string }) {
  const [data, setData] = useState<FundingData | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setData(null);
    fetch(`${API_BASE}/api/snapshot/funding/${exchange}/${encodeURIComponent(symbol)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.rate != null) setData(d as FundingData); })
      .catch(() => {});

    const channel = `funding:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe<FundingData>(channel, (d) => {
      if (d?.rate != null) setData(d);
    });
    return unsub;
  }, [exchange, symbol]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const baseName = symbol.split('/')[0] ?? symbol;

  return (
    <div className="bg-[#0c0c14] rounded border border-[#1a1a2a] h-full overflow-hidden flex flex-col">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[#1a1a2a] shrink-0 text-[10px]">
        <span className="text-gray-400 uppercase tracking-wider">Funding — {baseName}</span>
        {data && <span className="text-gray-600 ml-auto">{data.interval}h cycle</span>}
      </div>

      {!data ? (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-xs">Waiting...</div>
      ) : (
        <div className="flex-1 min-h-0 p-2 flex flex-col justify-center gap-2">
          {/* Current rate big */}
          <div className="text-center">
            <div className={`font-mono text-2xl ${rateClass(data.rate)}`}>
              {data.rate >= 0 ? '+' : ''}{toPct(data.rate)}
            </div>
            <div className="text-[9px] uppercase tracking-wider text-gray-500 mt-0.5">Current Rate</div>
          </div>

          {/* Countdown */}
          <div className="text-center">
            <div className="font-mono text-sm text-cyan-300">
              {formatCountdown(data.nextFundingTime - now)}
            </div>
            <div className="text-[9px] uppercase tracking-wider text-gray-500 mt-0.5">Next Payment</div>
          </div>

          {/* Secondary stats */}
          <div className="grid grid-cols-2 gap-1 text-[10px] font-mono mt-1">
            <div className="bg-[#11111c] rounded px-2 py-1">
              <div className="text-gray-500 text-[9px] uppercase tracking-wider">Predicted</div>
              <div className={data.predictedRate != null ? rateClass(data.predictedRate) : 'text-gray-600'}>
                {data.predictedRate != null
                  ? `${data.predictedRate >= 0 ? '+' : ''}${toPct(data.predictedRate)}`
                  : '—'}
              </div>
            </div>
            <div className="bg-[#11111c] rounded px-2 py-1">
              <div className="text-gray-500 text-[9px] uppercase tracking-wider">Annualized</div>
              <div className={rateClass(data.annualizedRate)}>
                {data.annualizedRate >= 0 ? '+' : ''}{(data.annualizedRate * 100).toFixed(1)}%
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
