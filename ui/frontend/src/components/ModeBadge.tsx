import { useSettingsStore } from '../stores/settings.store';

export function ModeBadge() {
  const mode = useSettingsStore((s) => s.mode);
  const setMode = useSettingsStore((s) => s.setMode);

  const isSim = mode === 'sim';

  return (
    <button
      onClick={() => setMode(isSim ? 'live' : 'sim')}
      title={isSim
        ? 'SIM mode — paper trading only. Click to switch to LIVE.'
        : 'LIVE mode — real exchange orders. Click to switch to SIM.'}
      className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors ${
        isSim
          ? 'bg-yellow-900/40 border-yellow-600 text-yellow-300 hover:bg-yellow-900/60'
          : 'bg-green-900/30 border-green-700 text-green-300 hover:bg-green-900/50'
      }`}
    >
      {isSim ? 'SIM' : 'LIVE'}
    </button>
  );
}
