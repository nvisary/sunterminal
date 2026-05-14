# SunTerminal

Crypto trading assistant -- модульная система для real-time маркет-данных, risk management, хеджирования и исполнения.

## Quick Start

```bash
./start.sh          # запускает всё (Redis + 6 сервисов)
# UI: http://localhost:3000
# Gateway: http://localhost:3001
```

## Architecture

6 процессов, общаются через Redis Streams:

```
Exchanges (Bybit, Binance, OKX)
    │  CCXT Pro WS + REST
    ▼
market-data/          → md:trades:*, md:orderbook:*, md:funding:*
    │
risk-engine/          → risk:signals:drawdown, levels, volatility, exposure
    │
hedge-engine/         → hedge:state, hedge:actions, hedge:recommendations
    │
trade-execution/      → trade:orders, trade:journal, trade:equity
    │
ui/api-gateway/       ← Redis → WS + HTTP proxy (port 3001)
    │
ui/frontend/          ← React app (port 3000, Vite dev server)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js + tsx. **НЕ Bun** (ccxt несовместим — `instanceof` баг) |
| Language | TypeScript 5, ESM (`"type": "module"`) |
| Exchange | ccxt / ccxt pro (unified API, WS + REST) |
| Event bus | Redis Streams (consumer groups) |
| Cache | Redis keys + TTL, stale-while-revalidate |
| Logging | pino (structured JSON) |
| Frontend | React 19 + Vite + Tailwind CSS + Zustand |
| Charts | lightweight-charts (TradingView) |
| DnD layout | react-grid-layout v2 |
| Desktop | Tauri v2 (optional, `npm run tauri:build`) |
| Package mgr | npm |

## Module Details

### market-data/
CCXT Pro WebSocket streams + REST cache. Прогревает кеш маркетов при старте.
- `subscribe(exchange, symbol)` — динамическая подписка через `cmd:rest-request`
- Валидация символа перед подпиской (`exchange.markets[symbol]`)
- BadSymbol — break retry (не спамит бесконечно)
- REST command pattern: Python/другие модули шлют команды через Redis

### risk-engine/
6 суб-модулей: Drawdown Monitor, Level Detector, Volatility Scanner, Exposure Tracker, Alert System, Correlation (P1 stub).
- Consumer group `risk-engine` читает md:* streams
- AccountPoller опрашивает balance/positions через REST commands (требует API ключи)
- Пороги настраиваются через .env (DD_WARNING_PCT, DD_DANGER_PCT и т.д.)

### hedge-engine/
Два режима: Advisor (рекомендации) / Controller (автоматика).
- Auto-Hedge: мониторит exposure, открывает/закрывает хедж
- Emergency Exit: **всегда активен**, триггерится на DD_CRITICAL/DD_MAX_PEAK, retry 3x, LOCKED state
- Ордера через market-data REST command pattern

### trade-execution/
Position Sizer (% risk от equity, auto-stop по ATR) + Pre-Trade Guard (7 проверок) + Market/Limit ордера + Trade Journal.
- Дефолты для $50-200: 1% risk, 5x leverage, max 3 позиции, max $100

### ui/api-gateway/
Node.js HTTP + WebSocket сервер (port 3001).
- RedisSubscriber: non-blocking XREAD polling (не BLOCK!)
- При первом poll: resolves `$` → реальный ID через XREVRANGE
- WsProxy: при подписке на новый символ → автоматический `subscribe` в market-data
- REST endpoints: `/api/trade/*`, `/api/hedge/*`, `/api/markets/:exchange/search`, `/api/candles/:exchange/:symbol`, `/api/config/*`
- CORS: `Access-Control-Allow-Origin: *`

### ui/frontend/
React 19 + Vite + Tailwind.

**Ключевые фичи:**
- **DnD layout** (react-grid-layout v2): drag за заголовок, resize за угол
- **Panes**: несколько рабочих пространств, переключение табами, каждый со своим набором виджетов
- **Sync groups**: 6 цветных групп (Blue/Red/Green/Yellow/Purple/Cyan), виджеты одной группы синхронизируют символ
- **Виджеты**: OrderBook (scalper DOM), CandleChart, Sparkline, Trades (bubbles), TradeForm, Drawdown, Exposure, Alerts, Hedge

**OrderBook (DOM):**
- Режимы: Dynamic (как Tiger Trade, следует за ценой) / Static (split, scroll для навигации)
- Tick aggregation через меню (шестерёнка), шаги зависят от цены
- Trade prints: кружки на уровнях, fade через 3s
- Inline symbol search в заголовке

**Stores (Zustand):**
- `panels.store` — symbol panels (BTC, ETH, SOL...)
- `layout.store` — panes с widgets + grid layout
- `sync.store` — color sync groups
- `market.store` — orderbook/ticker data
- `risk.store` — drawdown, exposure, alerts
- `hedge.store` — hedge state

**WebSocket client:**
- Generic `wsClient.subscribe<T>(channel, handler)` — typed callbacks
- Auto-reconnect (2s)
- `API_BASE` detection: Tauri → `localhost:3001`, dev → Vite proxy

## Redis Key Schema

### Streams
Все стримы пишутся через `XADD … MAXLEN ~ N` (approximate trimming). Никакой стрим не растёт неограниченно. Лимиты заданы в `<module>/src/bus/channels.ts`:

| Key | Writer | MAXLEN ~ | Content |
|-----|--------|---------:|---------|
| `md:trades:{ex}:{sym}` | market-data | 10 000 | Trade updates |
| `md:orderbook:{ex}:{sym}` | market-data | 5 000 | Orderbook depth |
| `md:ticker:{ex}:{sym}` | market-data | 5 000 | Last price ticks |
| `md:funding:{ex}:{sym}` | market-data | 1 000 | Funding rate |
| `md:status` | market-data | 100 | Exchange status / funding-extreme signals |
| `cmd:rest-request` | any → market-data | 1 000 | REST command queue |
| `cmd:risk:subscribe` / `:unsubscribe` | gateway → risk-engine | 100 | Dynamic symbol lifecycle |
| `cmd:trade:open` / `:close` / `:close-all` / `:calculate-size` | gateway → trade-exec | 100 | Trade commands |
| `cmd:hedge:emergency` / `:unlock` | gateway → hedge-engine | 10 | Hedge commands |
| `cmd:sim:trade:open` | gateway → sim | 100 | Sim trade commands |
| `risk:signals:drawdown` | risk-engine | 5 000 | Drawdown alerts |
| `risk:signals:levels` | risk-engine | 5 000 | S/R levels |
| `risk:signals:volatility` | risk-engine | 5 000 | ATR, regimes |
| `risk:signals:exposure` | risk-engine | 5 000 | Exposure alerts |
| `risk:signals:correlation` | risk-engine | 1 000 | Correlation (placeholder) |
| `risk:alerts` | risk-engine | 10 000 | All alerts |
| `hedge:state` | hedge-engine | 5 000 | Hedge state for UI |
| `hedge:actions` | hedge-engine | 10 000 | Action log |
| `hedge:recommendations` | hedge-engine | 5 000 | Advisor output |
| `trade:orders` | trade-execution | 10 000 | Order status |
| `trade:journal` | trade-execution | 10 000 | Trade records |
| `trade:equity:{accountId}` | trade-execution | 50 000 | Equity curve (live) |
| `trade:router` | trade-execution | 1 000 | Smart-router events |
| `sim:orders` | trade-execution sim | 5 000 | Paper orders |
| `sim:journal` | trade-execution sim | 10 000 | Paper trade records |
| `sim:equity-curve:{accountId}` | trade-execution sim | 50 000 | Sim equity curve |
| `sim:events` | trade-execution sim | 2 000 | Order/position/account deltas |
| `ml:rest-response:{reqId}` | market-data | n/a (deleted after read) | Single-use reply stream |

Operators may call `GET /api/admin/streams` (api-gateway) to fetch live `XLEN` for every known stream plus auto-discovered per-symbol/per-account streams. Utilization (`length / MAXLEN`) flags streams approaching their cap.

### Snapshots (Redis GET/SET)
- `snapshot:ob:{ex}:{sym}` — latest orderbook
- `snapshot:tick:{ex}:{sym}` — latest price
- `snapshot:funding:{ex}:{sym}` — latest funding
- `risk:snapshot:exposure` — exposure data
- `risk:snapshot:volatility:{ex}:{sym}` — volatility data
- `risk:snapshot:levels:{ex}:{sym}` / `risk:snapshot:zones:{ex}:{sym}` — S/R levels & zones
- `risk:snapshot:microstructure:{ex}:{sym}` — OFI / CVD / VPIN
- `risk:snapshot:footprint:{ex}:{sym}` — footprint candles (1m × N)
- `risk:snapshot:heatmap:{ex}:{sym}` — rolling orderbook history (windowMs)
- `risk:snapshot:active-alerts` — currently-firing alerts
- `risk:state:peak-equity` / `risk:state:daily-start-equity` — drawdown anchors
- `hedge:snapshot:state` — hedge state
- `rest:markets:{ex}` — cached markets (for UI search)

### Consumer Groups
risk-engine, hedge-engine, trade-exec, ui-gateway, python-ml, journal

## Conventions

- **Git commits**: НЕ добавлять `Co-Authored-By` в коммиты
- Each module: standalone npm package, own package.json, own .env
- Entry point: `index.ts` with `import "dotenv/config"`
- Facade pattern: one main class (MarketDataService, RiskEngine, HedgeEngine, TradeExecutionService)
- Stream loops: `while (!signal.aborted)` + AbortController
- Logger: `const logger = pino({ name: "module-name" })` per file
- Graceful shutdown: SIGINT/SIGTERM → service.stop()
- Config: .env → typed config object in config/
- **Zero `as any`** — use generic subscribe, proper types
- tsconfig: ESNext, module Preserve, strict, types ["node"]

## Known Issues / Notes

- **Binance blocked in RU** — set `BINANCE_ENABLED=false` in market-data/.env
- **API keys required** for fetchBalance/fetchPositions — without them risk-engine logs AuthenticationError (non-fatal)
- **Symbol names differ by exchange** — e.g. PEPE on Bybit is `1000PEPE/USDT:USDT`. Market search API handles this.
- **Tauri desktop** — works but needs `./start.sh` running first. Build: `cd ui/frontend && npm run tauri:build`
