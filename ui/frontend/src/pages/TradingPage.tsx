import { useState, useCallback, useRef, useEffect } from 'react';
import { GridLayout, verticalCompactor } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import { OrderBookWidget } from '../widgets/OrderBookWidget';
import { PriceChartWidget } from '../widgets/PriceChartWidget';
import { TradesWidget } from '../widgets/TradesWidget';
import { TradeFormWidget } from '../widgets/TradeFormWidget';
import { DrawdownWidget } from '../widgets/DrawdownWidget';
import { ExposureWidget } from '../widgets/ExposureWidget';
import { AlertsWidget } from '../widgets/AlertsWidget';
import { HedgeWidget } from '../widgets/HedgeWidget';
import { usePanelsStore } from '../stores/panels.store';
import { useLayoutStore, WIDGET_REGISTRY } from '../stores/layout.store';
import type { WidgetConfig, Layout } from '../stores/layout.store';

function WidgetWrapper({ widget, onRemove, children }: {
  widget: WidgetConfig;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="h-full flex flex-col bg-[#0c0c14] rounded border border-[#1a1a2a] overflow-hidden">
      {/* Drag handle */}
      <div className="drag-handle flex items-center gap-1 px-2 py-0.5 bg-[#0a0a10] border-b border-[#1a1a2a] cursor-move shrink-0">
        <span className="text-[10px] text-gray-500 flex-1 truncate">{widget.title}</span>
        <button
          onClick={onRemove}
          className="text-[10px] text-gray-700 hover:text-red-400 px-1"
          title="Close widget"
        >x</button>
      </div>
      <div className="flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}

function renderWidget(widget: WidgetConfig, panels: ReturnType<typeof usePanelsStore.getState>['panels'], activePanel: number, updatePanel: ReturnType<typeof usePanelsStore.getState>['updatePanel']) {
  const active = panels[activePanel] ?? panels[0];
  const panelIdx = (widget.props?.panelIndex as number) ?? activePanel;
  const panel = panels[panelIdx] ?? active;

  if (!panel) return <div className="text-gray-600 text-xs p-2">No data</div>;

  switch (widget.type) {
    case 'orderbook':
      return (
        <OrderBookWidget
          exchange={panel.exchange}
          symbol={panel.symbol}
          isActive={panelIdx === activePanel}
          onChangeSymbol={(sym) => updatePanel(panelIdx, { symbol: sym })}
          onChangeExchange={(ex) => updatePanel(panelIdx, { exchange: ex })}
        />
      );
    case 'chart':
      return <PriceChartWidget exchange={panel.exchange} symbol={panel.symbol} />;
    case 'trades':
      return <TradesWidget exchange={active?.exchange ?? ''} symbol={active?.symbol ?? ''} />;
    case 'tradeForm':
      return <TradeFormWidget exchange={active?.exchange ?? ''} symbol={active?.symbol ?? ''} />;
    case 'drawdown':
      return <DrawdownWidget />;
    case 'exposure':
      return <ExposureWidget />;
    case 'alerts':
      return <AlertsWidget />;
    case 'hedge':
      return <HedgeWidget />;
    default:
      return <div className="text-gray-600 text-xs p-2">Unknown widget: {widget.type}</div>;
  }
}

export function TradingPage({ onOpenLogs }: { onOpenLogs?: () => void }) {
  const { panels, activePanel, setActivePanel, addPanel, removePanel: removePanelStore } = usePanelsStore();
  const updatePanel = usePanelsStore((s) => s.updatePanel);
  const { widgets, layout, setLayout, addWidget, removeWidget, resetLayout } = useLayoutStore();
  const [showAddMenu, setShowAddMenu] = useState(false);

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
    setLayout(newLayout);
  }, [setLayout]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-2 py-1 bg-[#0d0d14] border-b border-[#1e1e2e] shrink-0">
        <span className="text-sm font-bold text-white shrink-0">SunTerminal</span>
        <span className="text-xs text-gray-600 shrink-0">|</span>

        {/* Panel tabs */}
        <div className="flex gap-1 shrink-0">
          {panels.map((p, i) => (
            <button
              key={i}
              onClick={() => setActivePanel(i)}
              className={`px-2 py-0.5 rounded text-xs transition-colors ${
                i === activePanel
                  ? 'bg-[#1e1e3e] text-white border border-[#3a3a5a]'
                  : 'text-gray-500 hover:text-gray-300 border border-transparent'
              }`}
            >
              {p.symbol.split('/')[0]}
              {panels.length > 1 && (
                <span onClick={(e) => { e.stopPropagation(); removePanelStore(i); }}
                  className="ml-1 text-gray-600 hover:text-red-400 cursor-pointer"
                >x</span>
              )}
            </button>
          ))}
          <button
            onClick={() => addPanel('SOL/USDT:USDT', active.exchange)}
            className="px-2 py-0.5 rounded text-xs text-gray-600 hover:text-green-400 border border-dashed border-gray-700 hover:border-green-700"
          >+</button>
        </div>

        <span className="text-xs text-gray-600 shrink-0">|</span>

        {/* Add widget menu */}
        <div className="relative">
          <button
            onClick={() => setShowAddMenu(!showAddMenu)}
            className="px-2 py-0.5 rounded text-xs text-gray-500 hover:text-green-400 border border-dashed border-gray-700 hover:border-green-700"
          >+ Widget</button>
          {showAddMenu && (
            <div
              className="absolute top-full left-0 mt-1 w-44 bg-[#12121e] border border-[#2a2a3a] rounded shadow-lg z-50"
              onMouseLeave={() => setShowAddMenu(false)}
            >
              {Object.entries(WIDGET_REGISTRY).map(([type, reg]) => (
                <button
                  key={type}
                  onClick={() => { addWidget(type); setShowAddMenu(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-[#1e1e3e] hover:text-white"
                >
                  {reg.title}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={resetLayout}
          className="px-2 py-0.5 rounded text-[10px] text-gray-600 hover:text-gray-400 border border-[#2a2a3a]"
          title="Reset to default layout"
        >Reset</button>

        <div className="flex-1" />
        {onOpenLogs && (
          <button onClick={onOpenLogs}
            className="px-2 py-0.5 rounded text-xs text-gray-500 hover:text-gray-200 border border-[#2a2a3a] hover:border-[#4a4a6a] shrink-0"
          >Logs</button>
        )}
        <span className="text-xs text-gray-600 shrink-0">Ctrl+L: logs</span>
      </div>

      {/* DnD Grid */}
      <div ref={containerRef} className="flex-1 overflow-auto">
        <GridLayout
          layout={layout as Layout}
          width={containerWidth}
          gridConfig={{ cols: 12, rowHeight: 40, margin: [4, 4], containerPadding: [4, 4], maxRows: Infinity }}
          dragConfig={{ enabled: true, handle: '.drag-handle', bounded: false, threshold: 3 }}
          onLayoutChange={onLayoutChange}
          compactor={verticalCompactor}
        >
          {widgets.map((widget) => (
            <div key={widget.id}>
              <WidgetWrapper widget={widget} onRemove={() => removeWidget(widget.id)}>
                {renderWidget(widget, panels, activePanel, updatePanel)}
              </WidgetWrapper>
            </div>
          ))}
        </GridLayout>
      </div>
    </div>
  );
}
