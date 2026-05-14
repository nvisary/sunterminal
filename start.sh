#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PIDS=()
MODULE_DIRS=(market-data risk-engine hedge-engine trade-execution ui/api-gateway ui/frontend)

log() {
  echo "[$(date +%H:%M:%S)] $1"
}

# pkill-by-path: matches any node/npm/tsx process whose argv contains the given
# module path. Reliable across nested process trees (npm → sh → tsx → node)
# where signalling the parent doesn't propagate to the actual worker.
kill_module_tree() {
  local dir="$1"
  pkill -TERM -f "$ROOT/$dir/" 2>/dev/null || true
}

cleanup() {
  echo ""
  echo "Stopping all services..."
  for dir in "${MODULE_DIRS[@]}"; do
    kill_module_tree "$dir"
  done
  # Belt: also signal whatever direct children we captured.
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  # Give workers a moment, then SIGKILL anything still alive.
  sleep 1
  for dir in "${MODULE_DIRS[@]}"; do
    pkill -KILL -f "$ROOT/$dir/" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "All services stopped."
}
trap cleanup EXIT INT TERM

# Pre-start cleanup: a previous Ctrl+C may have left orphaned node workers
# whose parents died without propagating SIGTERM. Two running copies of the
# same module both consume from the same Redis consumer group, so messages
# get split between them — non-deterministic behaviour.
log "Cleaning up any orphaned module processes..."
for dir in "${MODULE_DIRS[@]}"; do
  kill_module_tree "$dir"
done
sleep 1
for dir in "${MODULE_DIRS[@]}"; do
  pkill -KILL -f "$ROOT/$dir/" 2>/dev/null || true
done

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
