import { useState } from 'react';
import { useLayoutStore, WIDGET_REGISTRY } from '../stores/layout.store';
import { useSyncStore, SYNC_GROUPS, EXCHANGES } from '../stores/sync.store';
import { API_BASE } from '../lib/ws-client';

function PaneSettings() {
  const store = useLayoutStore();
  const pane = store.activePane();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-[9px] text-gray-500 uppercase mb-1">Pane Name</div>
        <input
          value={pane.name}
          onChange={(e) => store.renamePane(pane.id, e.target.value)}
          className="w-full bg-[#0a0a14] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:border-[#4a4a6a]"
        />
      </div>

      <div>
        <div className="text-[9px] text-gray-500 uppercase mb-1">Widgets ({pane.widgets.length})</div>
        <div className="flex flex-col gap-0.5">
          {pane.widgets.map((w) => (
            <div key={w.id} className="flex items-center gap-1 px-1.5 py-1 rounded bg-[#0a0a14] border border-[#1a1a2a] group">
              {editingId === w.id ? (
                <input
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { store.renameWidget(w.id, editValue); setEditingId(null); }
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onBlur={() => { store.renameWidget(w.id, editValue); setEditingId(null); }}
                  className="flex-1 bg-transparent border-b border-[#4a4a6a] text-xs text-white outline-none px-0.5"
                />
              ) : (
                <span
                  className="flex-1 text-xs text-gray-300 truncate cursor-pointer hover:text-white"
                  onClick={() => { setEditingId(w.id); setEditValue(w.title); }}
                  title="Click to rename"
                >
                  {w.title}
                </span>
              )}
              <span className="text-[9px] text-gray-600">{WIDGET_REGISTRY[w.type]?.title ?? w.type}</span>
              <button
                onClick={() => store.removeWidget(w.id)}
                className="text-[9px] text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100"
              >x</button>
            </div>
          ))}
          {pane.widgets.length === 0 && (
            <div className="text-[10px] text-gray-600 italic px-1">Empty pane</div>
          )}
        </div>
      </div>
    </div>
  );
}

function SymbolSearch({ exchange, value, onChange }: {
  exchange: string;
  value: string;
  onChange: (sym: string) => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[]>([]);

  const doSearch = async (q: string) => {
    setQuery(q);
    if (!q) { setResults([]); return; }
    try {
      const res = await fetch(`${API_BASE}/api/markets/${exchange}/search?q=${encodeURIComponent(q)}`);
      setResults(await res.json() as string[]);
    } catch { setResults([]); }
  };

  if (!searching) {
    return (
      <button
        onClick={() => setSearching(true)}
        className="w-full text-left bg-[#0a0a14] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-gray-200 hover:border-[#4a4a6a] truncate"
      >
        {value.split('/')[0] ?? value}
      </button>
    );
  }

  return (
    <div className="relative">
      <input
        autoFocus
        value={query}
        onChange={(e) => doSearch(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { setSearching(false); setQuery(''); setResults([]); } }}
        onBlur={() => setTimeout(() => { setSearching(false); setQuery(''); setResults([]); }, 150)}
        placeholder="Search symbol..."
        className="w-full bg-[#0a0a14] border border-[#4a4a6a] rounded px-2 py-1 text-xs text-white outline-none placeholder-gray-600"
      />
      {results.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 max-h-36 overflow-y-auto bg-[#12121e] border border-[#2a2a3a] rounded shadow-lg z-50">
          {results.map((sym) => (
            <button
              key={sym}
              onMouseDown={() => { onChange(sym); setSearching(false); setQuery(''); setResults([]); }}
              className="w-full text-left px-2 py-1 text-xs text-gray-300 hover:bg-[#1e1e3e] hover:text-white"
            >
              {sym}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SyncGroupsSettings() {
  const groupState = useSyncStore((s) => s.groupState);
  const setGroupSymbol = useSyncStore((s) => s.setGroupSymbol);

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[9px] text-gray-500 uppercase mb-0.5">Sync Groups</div>
      {SYNC_GROUPS.map((g) => {
        const state = groupState[g.id] ?? { exchange: 'bybit', symbol: 'BTC/USDT:USDT' };
        return (
          <div key={g.id} className="p-2 rounded bg-[#0a0a14] border border-[#1a1a2a]">
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: g.color }} />
              <span className="text-xs text-gray-300">{g.label}</span>
            </div>
            <div className="flex flex-col gap-1">
              <select
                value={state.exchange}
                onChange={(e) => setGroupSymbol(g.id, e.target.value, state.symbol)}
                className="w-full bg-[#0a0a14] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:border-[#4a4a6a]"
              >
                {EXCHANGES.map((ex) => <option key={ex} value={ex}>{ex}</option>)}
              </select>
              <SymbolSearch
                exchange={state.exchange}
                value={state.symbol}
                onChange={(sym) => setGroupSymbol(g.id, state.exchange, sym)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function RightSidebar() {
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const [tab, setTab] = useState<'pane' | 'sync'>('sync');

  return (
    <div
      className="shrink-0 bg-[#0c0c14] border-l border-[#1a1a2a] flex flex-col transition-[width] duration-200 overflow-hidden"
      style={{ width: sidebarOpen ? 260 : 32 }}
    >
      {sidebarOpen ? (
        <>
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#1a1a2a] shrink-0">
            <span className="text-[10px] text-gray-400 uppercase">Settings</span>
            <button onClick={toggleSidebar} className="text-gray-500 hover:text-white text-sm">›</button>
          </div>
          <div className="flex gap-0.5 px-2 py-1.5 border-b border-[#1a1a2a] shrink-0">
            <button
              onClick={() => setTab('pane')}
              className={`px-2 py-0.5 rounded text-[10px] ${
                tab === 'pane' ? 'bg-[#1e1e3e] text-white border border-[#3a3a5a]' : 'text-gray-500 hover:text-gray-300'
              }`}
            >Pane</button>
            <button
              onClick={() => setTab('sync')}
              className={`px-2 py-0.5 rounded text-[10px] ${
                tab === 'sync' ? 'bg-[#1e1e3e] text-white border border-[#3a3a5a]' : 'text-gray-500 hover:text-gray-300'
              }`}
            >Sync Groups</button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {tab === 'pane' ? <PaneSettings /> : <SyncGroupsSettings />}
          </div>
        </>
      ) : (
        <button
          onClick={toggleSidebar}
          className="flex-1 flex items-center justify-center text-gray-600 hover:text-gray-300"
          title="Open settings"
        >
          <span className="text-sm">‹</span>
        </button>
      )}
    </div>
  );
}
