import { useEffect } from 'react';
import { wsClient } from '../lib/ws-client';
import type { DrawdownState } from '../stores/risk.store';
import { useRiskStore } from '../stores/risk.store';
import { useSettingsStore } from '../stores/settings.store';
import { useSimStore, type SimDrawdown } from '../stores/sim.store';

export function DrawdownWidget() {
  const mode = useSettingsStore((s) => s.mode);
  const liveDD = useRiskStore((s) => s.drawdown);
  const setLiveDD = useRiskStore((s) => s.setDrawdown);
  const simDD = useSimStore((s) => s.drawdown);
  const setSimDD = useSimStore((s) => s.setDrawdown);

  useEffect(() => {
    if (mode === 'live') {
      return wsClient.subscribe<DrawdownState>('risk:drawdown', (data) => setLiveDD(data));
    }
    return wsClient.subscribe<SimDrawdown>('sim:drawdown', (data) => setSimDD(data));
  }, [mode, setLiveDD, setSimDD]);

  const dd = mode === 'live' ? liveDD : simDD;
  const levelColor = {
    NORMAL: 'text-green-400',
    WARNING: 'text-amber-400',
    DANGER: 'text-red-400',
    CRITICAL: 'text-red-500 animate-pulse',
    MAX_PEAK: 'text-red-600 animate-pulse',
  }[dd?.currentLevel ?? 'NORMAL'] ?? 'text-gray-400';

  const titleSuffix = mode === 'sim' ? <span className="text-yellow-400 ml-1">· SIM</span> : null;

  return (
    <div className="bg-[#111118] rounded border border-[#1e1e2e] p-3">
      <div className="text-xs text-gray-400 mb-2 font-semibold uppercase tracking-wider">
        Drawdown{titleSuffix}
      </div>

      {dd ? (
        <div className="space-y-2">
          <div className="flex justify-between">
            <span className="text-gray-500">Equity</span>
            <span className="text-white font-mono">${dd.equity.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Peak</span>
            <span className="text-gray-300 font-mono">${dd.peakEquity.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Daily DD</span>
            <span className="text-red-400 font-mono">-{dd.dailyDrawdownPct.toFixed(1)}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Peak DD</span>
            <span className="text-red-400 font-mono">-{dd.peakDrawdownPct.toFixed(1)}%</span>
          </div>
          <div className={`text-center text-sm font-bold mt-2 ${levelColor}`}>
            {dd.currentLevel}
            {dd.isTradeBlocked && <span className="ml-2 text-xs">BLOCKED</span>}
          </div>
        </div>
      ) : (
        <div className="text-gray-600 text-center py-4">No data</div>
      )}
    </div>
  );
}
