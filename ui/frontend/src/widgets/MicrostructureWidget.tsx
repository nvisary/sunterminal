import { useEffect, useRef, useState } from "react";
import { wsClient, API_BASE } from "../lib/ws-client";
import { useMicrostructureStore } from "../stores/microstructure.store";
import type { MicrostructureData } from "../stores/microstructure.store";

interface MicrostructureWidgetProps {
  exchange: string;
  symbol: string;
}

export function MicrostructureWidget({
  exchange,
  symbol,
}: MicrostructureWidgetProps) {
  const key = `${exchange}:${symbol}`;
  const data = useMicrostructureStore((s) => s.data.get(key));
  const setData = useMicrostructureStore((s) => s.setData);

  // History for sparklines
  const [cvdHistory, setCvdHistory] = useState<number[]>([]);
  const [ofiHistory, setOfiHistory] = useState<number[]>([]);

  useEffect(() => {
    // Initial snapshot
    fetch(
      `${API_BASE}/api/snapshot/microstructure/${exchange}/${encodeURIComponent(symbol)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (res) setData(key, res);
      })
      .catch(() => {});

    // Subscription
    const channel = `microstructure:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe<MicrostructureData>(channel, (res) => {
      setData(key, res);
      setCvdHistory((prev) => [...prev.slice(-24), res.cvd]);
      setOfiHistory((prev) => [...prev.slice(-24), res.ofi]);
    });
    return unsub;
  }, [exchange, symbol, key, setData]);

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-xs italic">
        Loading microstructure...
      </div>
    );
  }

  // Scaling helpers
  const maxCvd = Math.max(...cvdHistory.map(Math.abs), 1);
  const maxOfi = Math.max(...ofiHistory.map(Math.abs), 1);

  const imbalancePct = (data.bookImbalance * 50 + 50).toFixed(1);
  const vpinColor =
    data.vpin > 0.7
      ? "bg-red-500"
      : data.vpin > 0.4
        ? "bg-yellow-500"
        : "bg-emerald-500";
  const vpinTextColor =
    data.vpin > 0.7
      ? "text-red-400"
      : data.vpin > 0.4
        ? "text-yellow-400"
        : "text-emerald-400";

  return (
    <div className="p-3 flex flex-col gap-4 overflow-auto h-full bg-[#0a0a0f] text-zinc-300 select-none font-mono scrollbar-thin">
      {/* 1. Imbalance: Bid vs Ask Pressure */}
      <section>
        <div className="flex justify-between text-[10px] uppercase text-zinc-500 mb-1.5 font-bold tracking-wider">
          <span>Book Pressure</span>
          <span
            className={
              data.bookImbalance > 0 ? "text-emerald-400" : "text-red-400"
            }
          >
            {data.bookImbalance > 0 ? "BID" : "ASK"}{" "}
            {(Math.abs(data.bookImbalance) * 100).toFixed(1)}%
          </span>
        </div>
        <div className="relative h-3 w-full bg-zinc-900 rounded-sm overflow-hidden flex border border-zinc-800/50 shadow-inner">
          <div
            className="h-full bg-emerald-500/80 transition-all duration-500 ease-out"
            style={{ width: `${imbalancePct}%` }}
          />
          <div
            className="h-full bg-red-500/80 transition-all duration-500 ease-out"
            style={{ width: `${100 - parseFloat(imbalancePct)}%` }}
          />
          <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/20 z-10" />
        </div>
      </section>

      {/* 2. Primary Metrics: OFI & CVD */}
      <div className="grid grid-cols-2 gap-3">
        {/* OFI Card */}
        <div className="bg-zinc-900/40 p-2.5 rounded border border-zinc-800/60 hover:bg-zinc-900/60 transition-colors group">
          <div className="flex justify-between items-start mb-1">
            <div className="text-[9px] uppercase text-zinc-500 font-bold tracking-tighter">
              Order Flow (OFI)
            </div>
            {/* Bright sparkline with scaling */}
            <div className="h-5 w-12 flex items-end gap-0.5 overflow-hidden">
              {ofiHistory.map((v, i) => (
                <div
                  key={i}
                  className={`w-1 min-h-[1px] rounded-t-sm ${v >= 0 ? "bg-emerald-500" : "bg-red-500"}`}
                  style={{
                    height: `${Math.max((Math.abs(v) / maxOfi) * 100, 10)}%`,
                    opacity: 0.8,
                  }}
                />
              ))}
            </div>
          </div>
          <div
            className={`text-xl font-black ${data.ofi > 0 ? "text-emerald-400" : data.ofi < 0 ? "text-red-400" : "text-zinc-500"}`}
          >
            {data.ofi > 0 ? "▲" : data.ofi < 0 ? "▼" : ""}
            {Math.abs(data.ofi).toFixed(0)}
          </div>
        </div>

        {/* CVD Card */}
        <div className="bg-zinc-900/40 p-2.5 rounded border border-zinc-800/60 hover:bg-zinc-900/60 transition-colors group">
          <div className="flex justify-between items-start mb-1">
            <div className="text-[9px] uppercase text-zinc-500 font-bold tracking-tighter">
              Delta (CVD)
            </div>
            {/* Bright sparkline with scaling */}
            <div className="h-5 w-12 flex items-end gap-0.5 overflow-hidden">
              {cvdHistory.map((v, i) => (
                <div
                  key={i}
                  className={`w-1 min-h-[1px] rounded-t-sm ${v >= 0 ? "bg-emerald-500" : "bg-red-500"}`}
                  style={{
                    height: `${Math.max((Math.abs(v) / maxCvd) * 100, 10)}%`,
                    opacity: 0.8,
                  }}
                />
              ))}
            </div>
          </div>
          <div
            className={`text-xl font-black ${data.cvd > 0 ? "text-emerald-400" : data.cvd < 0 ? "text-red-400" : "text-zinc-500"}`}
          >
            {data.cvd > 1000
              ? `${(data.cvd / 1000).toFixed(1)}k`
              : data.cvd.toFixed(1)}
          </div>
        </div>
      </div>

      {/* 3. VPIN: Flow Toxicity Gauge */}
      <section className="bg-zinc-900/40 p-2.5 rounded border border-zinc-800/60 shadow-sm relative overflow-hidden">
        <div className="flex justify-between items-center mb-2">
          <div className="text-[9px] uppercase text-zinc-500 font-bold tracking-wider">
            Flow Toxicity (VPIN)
          </div>
          <div className={`text-xs font-black ${vpinTextColor}`}>
            {(data.vpin * 100).toFixed(1)}%
          </div>
        </div>
        <div className="h-2 w-full bg-zinc-950 rounded-full overflow-hidden border border-zinc-800/30">
          <div
            className={`h-full transition-all duration-1000 ease-in-out ${vpinColor} shadow-[0_0_8px_rgba(0,0,0,0.4)]`}
            style={{ width: `${Math.max(data.vpin * 100, 2)}%` }}
          />
        </div>
        <div className="flex justify-between mt-1 text-[7px] text-zinc-600 font-bold tracking-widest uppercase">
          <span>SAFE</span>
          <span>WARNING</span>
          <span>TOXIC</span>
        </div>
      </section>

      {/* 4. Liquidity Voids / Gaps */}
      <section className="flex-1 flex flex-col min-h-0">
        <div className="text-[10px] uppercase text-zinc-500 mb-2 font-bold border-b border-zinc-800/50 pb-1 flex justify-between items-center">
          <span>Liquidity Gaps (Voids)</span>
          <span className="text-[8px] bg-zinc-800 px-1 rounded text-zinc-400">
            {data.liquidityVoids.length} FOUND
          </span>
        </div>
        <div className="flex flex-col gap-1 overflow-y-auto pr-1 custom-scrollbar">
          {data.liquidityVoids.length === 0 ? (
            <div className="text-[10px] text-zinc-600 italic py-4 text-center bg-zinc-900/10 rounded border border-dashed border-zinc-800/30">
              No significant gaps in current range
            </div>
          ) : (
            data.liquidityVoids.map((v, i) => (
              <div
                key={i}
                className="flex justify-between items-center bg-zinc-900/50 hover:bg-zinc-800/40 p-2 rounded-sm border border-zinc-800/20 transition-all cursor-default group"
              >
                <div className="flex gap-2 items-center">
                  <span
                    className={`w-1 h-5 rounded-full ${
                      v.side === "bid"
                        ? "bg-red-500/80 shadow-[0_0_5px_rgba(239,68,68,0.3)]"
                        : v.side === "ask"
                          ? "bg-emerald-500/80 shadow-[0_0_5px_rgba(16,185,129,0.3)]"
                          : "bg-blue-500/80 shadow-[0_0_5px_rgba(59,130,246,0.3)]"
                    }`}
                  />
                  <div className="flex flex-col">
                    <span className="text-zinc-200 text-[10px] font-bold tracking-tight">
                      ${v.priceFrom.toLocaleString()}{" "}
                      <span className="text-zinc-600 font-normal">→</span> $
                      {v.priceTo.toLocaleString()}
                    </span>
                    <span className="text-[8px] text-zinc-500 uppercase">
                      {v.side} void
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end">
                  <span
                    className={`text-[11px] font-black ${v.gapSizePct > 0.1 ? "text-orange-400" : "text-zinc-400"}`}
                  >
                    {v.gapSizePct.toFixed(2)}%
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* 5. Mini Tape Stats Footer */}
      <section className="mt-auto pt-3 border-t border-zinc-800/80 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[9px]">
        <div className="flex justify-between items-center">
          <span className="text-zinc-500 uppercase tracking-tighter">
            Buy Volume
          </span>
          <span className="text-emerald-500 font-bold bg-emerald-500/5 px-1 rounded">
            {data.buyVolume > 1000
              ? `${(data.buyVolume / 1000).toFixed(1)}k`
              : data.buyVolume.toFixed(1)}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-zinc-500 uppercase tracking-tighter">
            Buy Count
          </span>
          <span className="text-zinc-300 font-medium">{data.buyCount}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-zinc-500 uppercase tracking-tighter">
            Sell Volume
          </span>
          <span className="text-red-500 font-bold bg-red-500/5 px-1 rounded">
            {data.sellVolume > 1000
              ? `${(data.sellVolume / 1000).toFixed(1)}k`
              : data.sellVolume.toFixed(1)}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-zinc-500 uppercase tracking-tighter">
            Sell Count
          </span>
          <span className="text-zinc-300 font-medium">{data.sellCount}</span>
        </div>
        <div className="col-span-2 flex justify-between mt-2 border-t border-zinc-800/30 pt-2 px-1">
          <span className="text-zinc-600 text-[8px] font-bold tracking-widest uppercase">
            Avg Trade Size
          </span>
          <span className="text-zinc-200 font-black tracking-tight">
            {data.avgTradeSize.toFixed(2)}{" "}
            <span className="text-zinc-600 font-normal">UNIT</span>
          </span>
        </div>
      </section>
    </div>
  );
}
