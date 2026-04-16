# SunTerminal

Crypto trading assistant -- модульная система для real-time маркет-данных, risk management, хеджирования и исполнения.

## Architecture

5 модулей, каждый -- отдельный Node.js процесс, общаются через Redis Streams:

1. **market-data/** -- CCXT Pro WS + REST -> Redis Streams (trades, orderbook, funding)
2. **risk-engine/** -- подписывается на md:*, анализирует, публикует risk:signals:*
3. **hedge-engine/** -- реагирует на risk signals, auto-hedge + emergency exit, публикует hedge:*
4. **trade-execution/** -- position sizing, order execution (market/limit), pre-trade guards, trade journal
5. **ui/** -- API Gateway (Node.js WS+HTTP) + React frontend (Vite+Tailwind+Zustand)

## Tech Stack

- **Runtime**: Node.js + tsx (TypeScript runner). НЕ Bun (ccxt несовместим)
- **Language**: TypeScript 5, ESM ("type": "module")
- **Exchange lib**: ccxt / ccxt pro (unified API для WS + REST)
- **Event bus**: Redis Streams (inter-process, consumer groups)
- **Cache**: Redis keys + TTL
- **Logging**: pino (structured JSON)
- **Package manager**: npm

## Running

```bash
# 1. Redis
docker compose up -d

# 2. Market Data
cd market-data && npm install && npm start

# 3. Risk Engine
cd risk-engine && npm install && npm start

# 4. Hedge Engine
cd hedge-engine && npm install && npm start

# 5. Trade Execution
cd trade-execution && npm install && npm start

# 6. UI (API Gateway + Frontend)
cd ui/api-gateway && npm install && npm start
cd ui/frontend && npm install && npm run dev
```

## Redis Key Schema

### Streams (from market-data)
- `md:trades:{exchange}:{symbol}` -- trade updates
- `md:orderbook:{exchange}:{symbol}` -- orderbook depth
- `md:funding:{exchange}:{symbol}` -- funding rate
- `md:status` -- exchange status events
- `cmd:rest-request` -- REST command queue (Python bridge)

### Streams (from risk-engine)
- `risk:signals:drawdown` -- drawdown alerts
- `risk:signals:levels` -- S/R levels & liquidity zones
- `risk:signals:volatility` -- ATR, regimes
- `risk:signals:exposure` -- exposure alerts
- `risk:alerts` -- all alerts for UI/Telegram

### Streams (from hedge-engine)
- `hedge:state` -- hedge state for UI (mode, active hedges, status)
- `hedge:actions` -- action log (opens, closes, emergency exits)
- `hedge:recommendations` -- advisor mode recommendations

### Snapshots
- `snapshot:ob:{exchange}:{symbol}` -- latest orderbook
- `snapshot:tick:{exchange}:{symbol}` -- latest price
- `snapshot:funding:{exchange}:{symbol}` -- latest funding

### Consumer Groups
risk-engine, hedge-engine, trade-exec, ui-gateway, python-ml, journal

## Conventions

- Each module is a standalone npm package with its own package.json
- Entry point: `index.ts` with dotenv/config import
- Facade pattern: one main class per module (MarketDataService, RiskEngine)
- Stream loops: `while (!signal.aborted)` with AbortController
- Logger per file: `const logger = pino({ name: "module-name" })`
- Graceful shutdown via SIGINT/SIGTERM -> service.stop()
- Config from .env via dotenv, typed config object in config/
