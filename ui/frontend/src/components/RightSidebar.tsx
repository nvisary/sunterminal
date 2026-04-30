import { useEffect, useState } from 'react';
import { useLayoutStore, WIDGET_REGISTRY } from '../stores/layout.store';
import { useSyncStore, SYNC_GROUPS, EXCHANGES } from '../stores/sync.store';
import { useSettingsStore } from '../stores/settings.store';
import { useSimStore } from '../stores/sim.store';
import { API_BASE } from '../lib/ws-client';

const API = `${API_BASE}/api`;

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

function SimSettings() {
  const mode = useSettingsStore((s) => s.mode);
  const setMode = useSettingsStore((s) => s.setMode);
  const initialEquityStored = useSettingsStore((s) => s.simInitialEquity);
  const takerFeeStored = useSettingsStore((s) => s.simTakerFeePct);
  const makerFeeStored = useSettingsStore((s) => s.simMakerFeePct);
  const setSimConfig = useSettingsStore((s) => s.setSimConfig);
  const account = useSimStore((s) => s.account);
  const setAccount = useSimStore((s) => s.setAccount);
  const [initialEquity, setInitialEquity] = useState(String(initialEquityStored));
  const [takerFee, setTakerFee] = useState(String(takerFeeStored));
  const [makerFee, setMakerFee] = useState(String(makerFeeStored));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/sim/account`).then((r) => r.json()).then((data) => {
      if (data) setAccount(data);
    }).catch(() => undefined);
    fetch(`${API}/sim/config`).then((r) => r.json()).then((cfg) => {
      if (!cfg) return;
      if (cfg.initialEquity != null) { setInitialEquity(String(cfg.initialEquity)); setSimConfig({ simInitialEquity: cfg.initialEquity }); }
      if (cfg.takerFeePct != null) { setTakerFee(String(cfg.takerFeePct)); setSimConfig({ simTakerFeePct: cfg.takerFeePct }); }
      if (cfg.makerFeePct != null) { setMakerFee(String(cfg.makerFeePct)); setSimConfig({ simMakerFeePct: cfg.makerFeePct }); }
    }).catch(() => undefined);
  }, [setAccount, setSimConfig]);

  const saveConfig = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const body = {
        initialEquity: Number(initialEquity),
        takerFeePct: Number(takerFee),
        makerFeePct: Number(makerFee),
      };
      await fetch(`${API}/sim/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setSimConfig({
        simInitialEquity: body.initialEquity,
        simTakerFeePct: body.takerFeePct,
        simMakerFeePct: body.makerFeePct,
      });
      setMsg('Saved (applies on next reset)');
    } finally {
      setBusy(false);
    }
  };

  const resetAccount = async () => {
    if (!confirm(`Reset sim account to $${initialEquity}? Open positions will be wiped.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await fetch(`${API}/sim/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialEquity: Number(initialEquity) }),
      });
      setTimeout(() => {
        fetch(`${API}/sim/account`).then((r) => r.json()).then((data) => {
          if (data) setAccount(data);
          setMsg('Account reset');
        }).catch(() => undefined);
      }, 400);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-[9px] text-gray-500 uppercase mb-1">Mode</div>
        <div className="flex gap-1">
          <button
            onClick={() => setMode('live')}
            className={`flex-1 py-1.5 rounded text-[10px] font-bold border ${
              mode === 'live'
                ? 'bg-green-900/40 border-green-600 text-green-300'
                : 'bg-[#0a0a14] border-[#2a2a3a] text-gray-500 hover:text-gray-300'
            }`}
          >LIVE</button>
          <button
            onClick={() => setMode('sim')}
            className={`flex-1 py-1.5 rounded text-[10px] font-bold border ${
              mode === 'sim'
                ? 'bg-yellow-900/40 border-yellow-600 text-yellow-300'
                : 'bg-[#0a0a14] border-[#2a2a3a] text-gray-500 hover:text-gray-300'
            }`}
          >SIM</button>
        </div>
      </div>

      {account && (
        <div className="bg-[#0a0a14] rounded border border-[#1a1a2a] p-2 text-[10px] text-gray-300">
          <div className="flex justify-between"><span>Equity</span><span className="font-mono">${(account.equity ?? account.cashUSDT).toFixed(2)}</span></div>
          <div className="flex justify-between"><span>Cash</span><span className="font-mono">${account.cashUSDT.toFixed(2)}</span></div>
          <div className="flex justify-between"><span>Realized PnL</span>
            <span className={`font-mono ${account.realizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {account.realizedPnl >= 0 ? '+' : ''}{account.realizedPnl.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between"><span>Open</span><span className="font-mono">{account.openPositions ?? 0}</span></div>
        </div>
      )}

      <div>
        <div className="text-[9px] text-gray-500 uppercase mb-1">Initial equity (USD)</div>
        <input
          type="number"
          value={initialEquity}
          onChange={(e) => setInitialEquity(e.target.value)}
          className="w-full bg-[#0a0a14] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:border-[#4a4a6a]"
        />
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <div className="text-[9px] text-gray-500 uppercase mb-1">Taker fee %</div>
          <input
            type="number"
            step="0.01"
            value={takerFee}
            onChange={(e) => setTakerFee(e.target.value)}
            className="w-full bg-[#0a0a14] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:border-[#4a4a6a]"
          />
        </div>
        <div className="flex-1">
          <div className="text-[9px] text-gray-500 uppercase mb-1">Maker fee %</div>
          <input
            type="number"
            step="0.01"
            value={makerFee}
            onChange={(e) => setMakerFee(e.target.value)}
            className="w-full bg-[#0a0a14] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:border-[#4a4a6a]"
          />
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={saveConfig}
          disabled={busy}
          className="flex-1 py-1.5 rounded text-[10px] font-bold bg-[#1e1e3e] border border-[#3a3a5a] text-gray-200 hover:bg-[#252550] disabled:opacity-50"
        >Save</button>
        <button
          onClick={resetAccount}
          disabled={busy}
          className="flex-1 py-1.5 rounded text-[10px] font-bold bg-yellow-900/40 border border-yellow-700 text-yellow-200 hover:bg-yellow-900/60 disabled:opacity-50"
        >Reset Account</button>
      </div>

      {msg && <div className="text-[10px] text-center text-gray-500">{msg}</div>}

      <div className="text-[9px] text-gray-600 leading-relaxed mt-1">
        SIM mode runs market-data through a paper-trading engine. Positions, fees, funding and drawdown are simulated; nothing is sent to the exchange.
      </div>
    </div>
  );
}

export function RightSidebar() {
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const [tab, setTab] = useState<'pane' | 'sync' | 'sim'>('sim');

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
              onClick={() => setTab('sim')}
              className={`px-2 py-0.5 rounded text-[10px] ${
                tab === 'sim' ? 'bg-[#1e1e3e] text-white border border-[#3a3a5a]' : 'text-gray-500 hover:text-gray-300'
              }`}
            >Sim</button>
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
            >Sync</button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {tab === 'sim' && <SimSettings />}
            {tab === 'pane' && <PaneSettings />}
            {tab === 'sync' && <SyncGroupsSettings />}
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
