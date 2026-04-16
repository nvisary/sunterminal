import { useEffect } from 'react';
import { wsClient } from '../lib/ws-client';
import type { ExposureState } from '../stores/risk.store';
import { useRiskStore } from '../stores/risk.store';

export function ExposureWidget() {
  const exposure = useRiskStore((s) => s.exposure);
  const setExposure = useRiskStore((s) => s.setExposure);

  useEffect(() => {
    return wsClient.subscribe<ExposureState>('risk:exposure', (data) => {
      setExposure(data);
    });
  }, [setExposure]);

  const exp = exposure;

  return (
    <div className="bg-[#111118] rounded border border-[#1e1e2e] p-3">
      <div className="text-xs text-gray-400 mb-2 font-semibold uppercase tracking-wider">Exposure</div>

      {exp ? (
        <div className="space-y-2">
          <div className="flex justify-between">
            <span className="text-gray-500">Net</span>
            <span className={`font-mono ${exp.netExposure >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              ${exp.netExposure.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Gross</span>
            <span className="text-white font-mono">${exp.grossExposure.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Ratio</span>
            <span className={`font-mono ${exp.exposureRatio > 3 ? 'text-red-400' : 'text-gray-300'}`}>
              {exp.exposureRatio.toFixed(2)}x
            </span>
          </div>
        </div>
      ) : (
        <div className="text-gray-600 text-center py-4">No data</div>
      )}
    </div>
  );
}
