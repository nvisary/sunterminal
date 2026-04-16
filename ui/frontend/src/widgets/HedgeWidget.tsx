import { useEffect } from 'react';
import { wsClient } from '../lib/ws-client';
import type { HedgeState } from '../stores/hedge.store';
import { useHedgeStore } from '../stores/hedge.store';

export function HedgeWidget() {
  const hedgeState = useHedgeStore((s) => s.state);
  const setState = useHedgeStore((s) => s.setState);

  useEffect(() => {
    return wsClient.subscribe<HedgeState>('hedge:state', (data) => {
      setState(data);
    });
  }, [setState]);

  const statusColor: Record<string, string> = {
    idle: 'text-gray-400',
    active: 'text-green-400',
    emergency: 'text-red-500 animate-pulse',
    locked: 'text-red-600',
  };

  return (
    <div className="bg-[#111118] rounded border border-[#1e1e2e] p-3">
      <div className="text-xs text-gray-400 mb-2 font-semibold uppercase tracking-wider">Hedge Engine</div>

      {hedgeState ? (
        <div className="space-y-2">
          <div className="flex justify-between">
            <span className="text-gray-500">Mode</span>
            <span className="text-gray-200 font-mono">{hedgeState.mode}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Status</span>
            <span className={`font-mono font-bold ${statusColor[hedgeState.status] ?? 'text-gray-400'}`}>
              {hedgeState.status.toUpperCase()}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Auto-Hedge</span>
            <span className={hedgeState.strategies.autoHedge.enabled ? 'text-green-400' : 'text-gray-600'}>
              {hedgeState.strategies.autoHedge.enabled ? 'ON' : 'OFF'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Hedge Size</span>
            <span className="text-gray-200 font-mono">${hedgeState.strategies.autoHedge.totalHedgeSize.toFixed(2)}</span>
          </div>
        </div>
      ) : (
        <div className="text-gray-600 text-center py-4">No data</div>
      )}
    </div>
  );
}
