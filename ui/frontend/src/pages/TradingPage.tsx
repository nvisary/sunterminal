import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { GridLayout, verticalCompactor } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import { OrderBookWidget } from '../widgets/OrderBookWidget';
import { PriceChartWidget } from '../widgets/PriceChartWidget';
import { TradesWidget } from '../widgets/TradesWidget';
import { VolumeProfileWidget } from '../widgets/VolumeProfileWidget';
import { LiquidityHeatmapWidget } from '../widgets/LiquidityHeatmapWidget';
import { HelpPopover } from '../widgets/help/HelpPopover';
import { FundingWidget } from '../widgets/FundingWidget';
import { VolatilityWidget } from '../widgets/VolatilityWidget';
import { LevelsWidget } from '../widgets/LevelsWidget';
import { TradeFormWidget } from '../widgets/TradeFormWidget';
import { DrawdownWidget } from '../widgets/DrawdownWidget';
import { ExposureWidget } from '../widgets/ExposureWidget';
import { AlertsWidget } from '../widgets/AlertsWidget';
import { HedgeWidget } from '../widgets/HedgeWidget';
import { CandleChartWidget } from '../widgets/CandleChartWidget';
import { usePanelsStore } from '../stores/panels.store';
import { useLayoutStore, WIDGET_REGISTRY } from '../stores/layout.store';
import { useSyncStore, SYNC_GROUPS } from '../stores/sync.store';
import { RightSidebar } from '../components/RightSidebar';
import type { WidgetConfig, Layout } from '../stores/layout.store';

function SyncDot({ widgetId }: { widgetId: string }) {
  const groupId = useSyncStore((s) => s.assignments[widgetId] ?? null);
  const setGroup = useSyncStore((s) => s.setWidgetGroup);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const currentGroup = SYNC_GROUPS.find((g) => g.id === groupId);
  const dotColor = currentGroup?.color ?? '#333';

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pos) { setPos(null); return; }
    const btn = btnRef.current?.getBoundingClientRect();
    if (!btn) return;
    const menuW = 80, menuH = 200;
    let top = btn.bottom + 4;
    let left = btn.left;
    if (left + menuW > window.innerWidth) left = window.innerWidth - menuW - 4;
    if (left < 4) left = 4;
    if (top + menuH > window.innerHeight) top = btn.top - menuH - 4;
    setPos({ top, left });
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={handleOpen}
        className="w-3 h-3 rounded-full border border-gray-700 hover:border-gray-500 shrink-0"
        style={{ backgroundColor: dotColor }}
        title={currentGroup ? `Group: ${currentGroup.label}` : 'No sync group (click to assign)'}
      />
      {pos && createPortal(
        <div
          className="fixed bg-[#12121e] border border-[#2a2a3a] rounded shadow-lg p-1.5 flex flex-col gap-1"
          style={{ top: pos.top, left: pos.left, zIndex: 9999 }}
          onMouseLeave={() => setPos(null)}
        >
          <button
            onClick={() => { setGroup(widgetId, null); setPos(null); }}
            className="flex items-center gap-1.5 px-1.5 py-0.5 text-[10px] text-gray-400 hover:text-white rounded hover:bg-[#1e1e2e]"
          >
            <span className="w-2.5 h-2.5 rounded-full bg-gray-700 border border-gray-600" />
            None
          </button>
          {SYNC_GROUPS.map((g) => (
            <button
              key={g.id}
              onClick={() => { setGroup(widgetId, g.id); setPos(null); }}
              className={`flex items-center gap-1.5 px-1.5 py-0.5 text-[10px] rounded hover:bg-[#1e1e2e] ${
                groupId === g.id ? 'text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: g.color }} />
              {g.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

function WidgetWrapper({ widget, onRemove, children }: {
  widget: WidgetConfig;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  const groupId = useSyncStore((s) => s.assignments[widget.id] ?? null);
  const borderColor = SYNC_GROUPS.find((g) => g.id === groupId)?.color;

  return (
    <div className="h-full flex flex-col bg-[#0c0c14] rounded border"
      style={{ borderColor: borderColor ?? '#1a1a2a' }}
    >
      <div className="drag-handle flex items-center gap-1 px-2 py-0.5 bg-[#0a0a10] border-b border-[#1a1a2a] cursor-move shrink-0">
        <SyncDot widgetId={widget.id} />
        <span className="text-[10px] text-gray-500 flex-1 truncate">{widget.title}</span>
        <HelpPopover widgetType={widget.type} />
        <button onClick={onRemove} className="text-[10px] text-gray-700 hover:text-red-400 px-1" title="Close widget">x</button>
      </div>
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

// Widgets that respond to symbol sync
const SYMBOL_WIDGETS = new Set(['orderbook', 'chart', 'candleChart', 'trades', 'tradeForm', 'heatmap']);

function WidgetContent({ widget }: { widget: WidgetConfig }) {
  const panels = usePanelsStore((s) => s.panels);
  const activePanel = usePanelsStore((s) => s.activePanel);
  const updatePanel = usePanelsStore((s) => s.updatePanel);
  const getWidgetSymbol = useSyncStore((s) => s.getWidgetSymbol);
  const setGroupSymbol = useSyncStore((s) => s.setGroupSymbol);
  const groupId = useSyncStore((s) => s.assignments[widget.id] ?? null);

  const active = panels[activePanel] ?? panels[0];
  const panelIdx = (widget.props?.panelIndex as number) ?? activePanel;
  const panel = panels[panelIdx] ?? active;
  if (!panel) return <div className="text-gray-600 text-xs p-2">No data</div>;

  // If widget is in a sync group, use group's symbol; otherwise use panel's
  const resolved = SYMBOL_WIDGETS.has(widget.type)
    ? getWidgetSymbol(widget.id, panel.exchange, panel.symbol)
    : { exchange: panel.exchange, symbol: panel.symbol };

  const onChangeSymbol = (sym: string) => {
    if (groupId) {
      setGroupSymbol(groupId, resolved.exchange, sym);
    } else {
      updatePanel(panelIdx, { symbol: sym });
    }
  };

  const onChangeExchange = (ex: string) => {
    if (groupId) {
      setGroupSymbol(groupId, ex, resolved.symbol);
    } else {
      updatePanel(panelIdx, { exchange: ex });
    }
  };

  switch (widget.type) {
    case 'orderbook':
      return (
        <OrderBookWidget
          exchange={resolved.exchange} symbol={resolved.symbol}
          isActive={panelIdx === activePanel}
          onChangeSymbol={onChangeSymbol}
          onChangeExchange={onChangeExchange}
        />
      );
    case 'chart':
      return <PriceChartWidget exchange={resolved.exchange} symbol={resolved.symbol} />;
    case 'candleChart':
      return <CandleChartWidget defaultExchange={resolved.exchange} defaultSymbol={resolved.symbol} />;
    case 'trades':
      return <TradesWidget exchange={resolved.exchange} symbol={resolved.symbol} />;
    case 'volumeProfile':
      return <VolumeProfileWidget exchange={resolved.exchange} symbol={resolved.symbol} />;
    case 'heatmap':
      return <LiquidityHeatmapWidget exchange={resolved.exchange} symbol={resolved.symbol} />;
    case 'funding':
      return <FundingWidget exchange={resolved.exchange} symbol={resolved.symbol} />;
    case 'volatility':
      return <VolatilityWidget exchange={resolved.exchange} symbol={resolved.symbol} />;
    case 'levels':
      return <LevelsWidget exchange={resolved.exchange} symbol={resolved.symbol} />;
    case 'tradeForm':
      return <TradeFormWidget exchange={resolved.exchange} symbol={resolved.symbol} />;
    case 'drawdown':
      return <DrawdownWidget />;
    case 'exposure':
      return <ExposureWidget />;
    case 'alerts':
      return <AlertsWidget />;
    case 'hedge':
      return <HedgeWidget />;
    default:
      return <div className="text-gray-600 text-xs p-2">Unknown: {widget.type}</div>;
  }
}

export function TradingPage({ onOpenLogs }: { onOpenLogs?: () => void }) {
  const { panels, activePanel, setActivePanel, addPanel, removePanel: removePanelStore } = usePanelsStore();
  const store = useLayoutStore();
  const pane = store.activePane();
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [renamingPane, setRenamingPane] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const active = panels[activePanel] ?? panels[0]!;

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1200);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onLayoutChange = useCallback((newLayout: Layout) => {
    store.setLayout(newLayout);
  }, [store]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-1.5 px-2 py-1 bg-[#0d0d14] border-b border-[#1e1e2e] shrink-0 overflow-visible">
        <span className="text-sm font-bold text-white shrink-0">SunTerminal</span>
        <span className="text-gray-700 shrink-0">|</span>

        {/* Pane tabs */}
        <div className="flex gap-0.5 shrink-0">
          {store.panes.map((p) => (
            <div key={p.id} className="flex items-center">
              {renamingPane === p.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { store.renamePane(p.id, renameValue); setRenamingPane(null); }
                    if (e.key === 'Escape') setRenamingPane(null);
                  }}
                  onBlur={() => { store.renamePane(p.id, renameValue); setRenamingPane(null); }}
                  className="w-16 bg-[#0a0a14] border border-[#4a4a6a] rounded px-1 py-0.5 text-[10px] text-white outline-none"
                />
              ) : (
                <button
                  onClick={() => store.setActivePane(p.id)}
                  onDoubleClick={() => { setRenamingPane(p.id); setRenameValue(p.name); }}
                  className={`px-2 py-0.5 rounded-l text-[10px] transition-colors ${
                    p.id === store.activePaneId
                      ? 'bg-[#1e1e3e] text-white border border-[#3a3a5a]'
                      : 'text-gray-500 hover:text-gray-300 border border-transparent hover:border-[#2a2a3a]'
                  }`}
                  title="Double-click to rename"
                >
                  {p.name}
                </button>
              )}
              {store.panes.length > 1 && p.id === store.activePaneId && (
                <button
                  onClick={() => store.removePane(p.id)}
                  className="text-[9px] text-gray-700 hover:text-red-400 px-0.5 -ml-px"
                >x</button>
              )}
            </div>
          ))}
          <button
            onClick={() => store.addPane(`Pane ${store.panes.length + 1}`)}
            className="px-1.5 py-0.5 rounded text-[10px] text-gray-600 hover:text-green-400 border border-dashed border-gray-700 hover:border-green-700"
          >+</button>
        </div>

        <span className="text-gray-700 shrink-0">|</span>

        {/* Symbol panel tabs */}
        <div className="flex gap-0.5 shrink-0">
          {panels.map((p, i) => (
            <button key={i} onClick={() => setActivePanel(i)}
              className={`px-1.5 py-0.5 rounded text-[10px] ${
                i === activePanel ? 'bg-[#1a1a3a] text-gray-200 border border-[#3a3a5a]' : 'text-gray-600 hover:text-gray-400 border border-transparent'
              }`}
            >
              {p.symbol.split('/')[0]}
              {panels.length > 1 && (
                <span onClick={(e) => { e.stopPropagation(); removePanelStore(i); }}
                  className="ml-0.5 text-gray-700 hover:text-red-400">x</span>
              )}
            </button>
          ))}
          <button
            onClick={() => addPanel('SOL/USDT:USDT', active.exchange)}
            className="px-1 py-0.5 rounded text-[10px] text-gray-600 hover:text-green-400 border border-dashed border-gray-700 hover:border-green-700"
          >+sym</button>
        </div>

        <span className="text-gray-700 shrink-0">|</span>

        {/* Add widget */}
        <div className="relative shrink-0">
          <button onClick={() => setShowAddMenu(!showAddMenu)}
            className="px-1.5 py-0.5 rounded text-[10px] text-gray-500 hover:text-green-400 border border-dashed border-gray-700 hover:border-green-700"
          >+widget</button>
          {showAddMenu && (
            <div className="absolute top-full left-0 mt-1 w-40 bg-[#12121e] border border-[#2a2a3a] rounded shadow-lg z-50"
              onMouseLeave={() => setShowAddMenu(false)}>
              {Object.entries(WIDGET_REGISTRY).map(([type, reg]) => (
                <button key={type} onClick={() => { store.addWidget(type); setShowAddMenu(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-[#1e1e3e] hover:text-white"
                >{reg.title}</button>
              ))}
            </div>
          )}
        </div>

        <button onClick={store.resetLayout}
          className="px-1.5 py-0.5 rounded text-[9px] text-gray-600 hover:text-gray-400 border border-[#2a2a3a] shrink-0"
        >Reset</button>

        <div className="flex-1" />
        {onOpenLogs && (
          <button onClick={onOpenLogs}
            className="px-2 py-0.5 rounded text-[10px] text-gray-500 hover:text-gray-200 border border-[#2a2a3a] shrink-0"
          >Logs</button>
        )}
        <button onClick={store.toggleSidebar}
          className={`px-2 py-0.5 rounded text-[10px] border border-[#2a2a3a] shrink-0 ${
            store.sidebarOpen ? 'text-gray-200 bg-[#1e1e3e]' : 'text-gray-500 hover:text-gray-200'
          }`}
        >Settings</button>
      </div>

      {/* Content: Grid + Sidebar */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div ref={containerRef} className="flex-1 overflow-auto min-w-0">
          <GridLayout
            key={pane.id}
            layout={pane.layout as Layout}
            width={containerWidth}
            gridConfig={{ cols: 12, rowHeight: 40, margin: [4, 4], containerPadding: [4, 4], maxRows: Infinity }}
            dragConfig={{ enabled: true, handle: '.drag-handle', bounded: false, threshold: 3 }}
            onLayoutChange={onLayoutChange}
            compactor={verticalCompactor}
          >
            {pane.widgets.map((widget) => (
              <div key={widget.id}>
                <WidgetWrapper widget={widget} onRemove={() => store.removeWidget(widget.id)}>
                  <WidgetContent widget={widget} />
                </WidgetWrapper>
              </div>
            ))}
          </GridLayout>
        </div>
        <RightSidebar />
      </div>
    </div>
  );
}
