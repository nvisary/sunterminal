import { useEffect } from 'react';
import { wsClient } from '../lib/ws-client';
import type { Alert } from '../stores/risk.store';
import { useRiskStore } from '../stores/risk.store';

export function AlertsWidget() {
  const alerts = useRiskStore((s) => s.alerts);
  const addAlert = useRiskStore((s) => s.addAlert);

  useEffect(() => {
    return wsClient.subscribe<Alert>('risk:alerts', (data) => {
      addAlert(data);
    });
  }, [addAlert]);

  const levelColor: Record<string, string> = {
    info: 'border-blue-800 bg-blue-900/20',
    warning: 'border-amber-800 bg-amber-900/20',
    danger: 'border-red-800 bg-red-900/20',
    critical: 'border-red-600 bg-red-900/40 animate-pulse',
  };

  return (
    <div className="bg-[#111118] rounded border border-[#1e1e2e] p-3 h-full overflow-hidden">
      <div className="text-xs text-gray-400 mb-2 font-semibold uppercase tracking-wider">
        Alerts ({alerts.length})
      </div>

      <div className="space-y-1 overflow-y-auto max-h-48">
        {alerts.length === 0 && (
          <div className="text-gray-600 text-center py-4 text-xs">No alerts</div>
        )}
        {[...alerts].reverse().slice(0, 20).map((alert, i) => (
          <div
            key={alert.id ?? i}
            className={`rounded border px-2 py-1 text-xs ${levelColor[alert.level] ?? 'border-gray-700'}`}
          >
            <span className="text-gray-400">{alert.source}:</span>{' '}
            <span className="text-gray-200">{alert.type}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
