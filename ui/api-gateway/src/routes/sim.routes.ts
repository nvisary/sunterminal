import type { ServerResponse } from "node:http";
import Redis from "ioredis";
import pino from "pino";

const logger = pino({ name: "sim-routes" });

interface SimConfig {
  accountId?: string;
  initialEquity?: number;
  takerFeePct?: number;
  makerFeePct?: number;
}

const DEFAULT_ACCOUNT_ID = process.env.SIM_ACCOUNT_ID ?? "default";
const DEFAULT_INITIAL_EQUITY = Number(process.env.SIM_INITIAL_EQUITY) || 1000;

/**
 * REST routes for paper trading. Mirrors the live trade routes but writes to
 * the sim-specific command streams and reads from `sim:*` snapshots.
 */
export function createSimRoutes(redis: Redis) {
  return async (path: string, method: string, body: Record<string, unknown>, res: ServerResponse): Promise<boolean> => {
    // POST /api/sim/trade/open
    if (path === "/api/sim/trade/open" && method === "POST") {
      const accountId = (body.accountId as string) || DEFAULT_ACCOUNT_ID;
      await redis.xadd(
        "cmd:sim:trade:open",
        "MAXLEN", "~", "100", "*",
        "data", JSON.stringify({ ...body, accountId }),
      );
      json(res, 200, { ok: true });
      return true;
    }

    // POST /api/sim/trade/close/:id
    const closeMatch = path.match(/^\/api\/sim\/trade\/close\/(.+)$/);
    if (closeMatch && method === "POST") {
      const tradeId = closeMatch[1]!;
      await redis.xadd(
        "cmd:sim:trade:close",
        "MAXLEN", "~", "100", "*",
        "data", JSON.stringify({ tradeId }),
      );
      json(res, 200, { ok: true });
      return true;
    }

    // POST /api/sim/trade/close-all
    if (path === "/api/sim/trade/close-all" && method === "POST") {
      await redis.xadd(
        "cmd:sim:trade:close-all",
        "MAXLEN", "~", "100", "*",
        "data", JSON.stringify(body),
      );
      json(res, 200, { ok: true });
      return true;
    }

    // POST /api/sim/reset  body: { initialEquity?: number }
    if (path === "/api/sim/reset" && method === "POST") {
      await redis.xadd(
        "cmd:sim:reset",
        "MAXLEN", "~", "10", "*",
        "data", JSON.stringify(body),
      );
      json(res, 200, { ok: true });
      return true;
    }

    // GET /api/sim/account
    if (path === "/api/sim/account" && method === "GET") {
      const accountId = DEFAULT_ACCOUNT_ID;
      const accountRaw = await redis.get(`sim:account:${accountId}`);
      const exposureRaw = await redis.get(`sim:snapshot:exposure:${accountId}`);
      const account = accountRaw ? JSON.parse(accountRaw) : null;
      const exposure = exposureRaw ? JSON.parse(exposureRaw) : null;
      if (!account) {
        json(res, 200, null);
        return true;
      }
      json(res, 200, {
        ...account,
        equity: exposure?.equity ?? account.cashUSDT,
        unrealizedPnl: exposure?.unrealizedPnl ?? 0,
        openPositions: exposure?.openPositions ?? 0,
      });
      return true;
    }

    // GET /api/sim/positions
    if (path === "/api/sim/positions" && method === "GET") {
      const accountId = DEFAULT_ACCOUNT_ID;
      const all = await redis.hgetall(`sim:positions:${accountId}`);
      const positions = Object.values(all).map((s) => {
        try { return JSON.parse(s); } catch { return null; }
      }).filter(Boolean);
      json(res, 200, positions);
      return true;
    }

    // GET /api/sim/journal?limit=200
    if (path === "/api/sim/journal" && method === "GET") {
      const result = await redis.xrevrange("sim:journal", "+", "-", "COUNT", 500);
      const records = result.map(([, fields]) => {
        const idx = fields.indexOf("data");
        if (idx === -1) return null;
        try { return JSON.parse(fields[idx + 1]!); } catch { return null; }
      }).filter(Boolean);
      json(res, 200, records);
      return true;
    }

    // GET /api/sim/equity-curve?limit=500
    if (path === "/api/sim/equity-curve" && method === "GET") {
      const accountId = DEFAULT_ACCOUNT_ID;
      const result = await redis.xrevrange(`sim:equity-curve:${accountId}`, "+", "-", "COUNT", 500);
      const points = result.map(([, fields]) => {
        const idx = fields.indexOf("data");
        if (idx === -1) return null;
        try { return JSON.parse(fields[idx + 1]!); } catch { return null; }
      }).filter(Boolean).reverse();
      json(res, 200, points);
      return true;
    }

    // GET /api/sim/stats
    if (path === "/api/sim/stats" && method === "GET") {
      const accountId = DEFAULT_ACCOUNT_ID;
      const stats = await redis.hget(`sim:stats:${accountId}`, "all");
      json(res, 200, stats ? JSON.parse(stats) : null);
      return true;
    }

    // GET /api/sim/config
    if (path === "/api/sim/config" && method === "GET") {
      const cfg = await redis.get("sim:config");
      const parsed: SimConfig = cfg ? JSON.parse(cfg) : {};
      json(res, 200, {
        accountId: parsed.accountId ?? DEFAULT_ACCOUNT_ID,
        initialEquity: parsed.initialEquity ?? DEFAULT_INITIAL_EQUITY,
        takerFeePct: parsed.takerFeePct ?? 0.05,
        makerFeePct: parsed.makerFeePct ?? 0.02,
      });
      return true;
    }

    // PUT /api/sim/config
    if (path === "/api/sim/config" && method === "PUT") {
      await redis.xadd(
        "cmd:sim:config",
        "MAXLEN", "~", "10", "*",
        "data", JSON.stringify(body),
      );
      // Also write straight to snapshot so a GET after PUT sees the new value
      await redis.set("sim:config", JSON.stringify(body));
      json(res, 200, { ok: true });
      return true;
    }

    return false;
  };
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

void logger; // reserved for future per-request logging
