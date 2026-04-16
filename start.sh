#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PIDS=()

cleanup() {
  echo ""
  echo "Stopping all services..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "All services stopped."
}
trap cleanup EXIT INT TERM

log() {
  echo "[$(date +%H:%M:%S)] $1"
}

# ─── Redis ─────────────────────────────────────────────────────────

log "Starting Redis..."
docker compose -f "$ROOT/docker-compose.yml" up -d --wait 2>/dev/null
log "Redis OK"

# ─── Install deps if needed ───────────────────────────────────────

for dir in market-data risk-engine hedge-engine trade-execution ui/api-gateway ui/frontend; do
  if [ ! -d "$ROOT/$dir/node_modules" ]; then
    log "Installing $dir..."
    (cd "$ROOT/$dir" && npm install --silent)
  fi
done

# ─── Market Data (must start first) ───────────────────────────────

log "Starting market-data..."
(cd "$ROOT/market-data" && npx tsx index.ts) &
PIDS+=($!)
sleep 5

# ─── Risk Engine ──────────────────────────────────────────────────

log "Starting risk-engine..."
(cd "$ROOT/risk-engine" && npx tsx index.ts) &
PIDS+=($!)
sleep 2

# ─── Hedge Engine ─────────────────────────────────────────────────

log "Starting hedge-engine..."
(cd "$ROOT/hedge-engine" && npx tsx index.ts) &
PIDS+=($!)
sleep 1

# ─── Trade Execution ──────────────────────────────────────────────

log "Starting trade-execution..."
(cd "$ROOT/trade-execution" && npx tsx index.ts) &
PIDS+=($!)
sleep 1

# ─── API Gateway ──────────────────────────────────────────────────

log "Starting api-gateway on :3001..."
(cd "$ROOT/ui/api-gateway" && npx tsx src/server.ts) &
PIDS+=($!)
sleep 1

# ─── Frontend ─────────────────────────────────────────────────────

log "Starting frontend on :3000..."
(cd "$ROOT/ui/frontend" && npx vite --host 2>/dev/null) &
PIDS+=($!)
sleep 2

# ─── Ready ────────────────────────────────────────────────────────

echo ""
echo "========================================="
echo "  SunTerminal is running"
echo "========================================="
echo ""
echo "  UI:          http://localhost:3000"
echo "  API Gateway: http://localhost:3001"
echo "  Redis:       localhost:6379"
echo ""
echo "  Press Ctrl+C to stop all services"
echo "========================================="
echo ""

wait
