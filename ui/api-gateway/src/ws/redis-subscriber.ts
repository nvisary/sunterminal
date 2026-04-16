import Redis from "ioredis";
import pino from "pino";

const logger = pino({ name: "redis-subscriber" });

type MessageHandler = (channel: string, data: Record<string, unknown>) => void;

/**
 * Subscribes to Redis Streams/snapshots and dispatches messages to handlers.
 * Uses non-blocking XREAD polling (no BLOCK) so a single Redis connection
 * can serve multiple streams concurrently.
 */
export class RedisSubscriber {
  private redis: Redis;
  private handlers = new Map<string, Set<MessageHandler>>();
  private pollers = new Map<string, ReturnType<typeof setInterval>>();
  private lastIds = new Map<string, string>();

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
    logger.info("Redis subscriber connected");
  }

  async disconnect(): Promise<void> {
    for (const timer of this.pollers.values()) clearInterval(timer);
    this.pollers.clear();
    this.redis.disconnect();
  }

  subscribe(channel: string, handler: MessageHandler): void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      this.startPolling(channel);
    }
    this.handlers.get(channel)!.add(handler);
  }

  unsubscribe(channel: string, handler: MessageHandler): void {
    const handlers = this.handlers.get(channel);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(channel);
        this.stopPolling(channel);
      }
    }
  }

  getSubscriberCount(channel: string): number {
    return this.handlers.get(channel)?.size ?? 0;
  }

  // ─── Private ──────────────────────────────────────────────────

  private startPolling(channel: string): void {
    const redisKey = this.channelToRedisKey(channel);
    if (!redisKey) return;

    const isSnapshot = this.isSnapshotKey(redisKey);

    if (isSnapshot) {
      // Snapshot: GET key every second
      const timer = setInterval(() => this.pollSnapshot(channel, redisKey), 1000);
      this.pollers.set(channel, timer);
    } else {
      // Stream: non-blocking XREAD every 100ms
      this.lastIds.set(channel, "$");
      const timer = setInterval(() => this.pollStream(channel, redisKey), 100);
      this.pollers.set(channel, timer);
    }

    logger.debug({ channel, redisKey, isSnapshot }, "Polling started");
  }

  private stopPolling(channel: string): void {
    const timer = this.pollers.get(channel);
    if (timer) {
      clearInterval(timer);
      this.pollers.delete(channel);
    }
    this.lastIds.delete(channel);
  }

  private async pollSnapshot(channel: string, redisKey: string): Promise<void> {
    try {
      // Snapshots can be plain keys (GET) or hash fields (HGETALL)
      const raw = await this.redis.get(redisKey);
      if (raw) {
        this.dispatch(channel, JSON.parse(raw));
      }
    } catch {
      // ignore
    }
  }

  private async pollStream(channel: string, redisKey: string): Promise<void> {
    try {
      let lastId = this.lastIds.get(channel);

      // "$" doesn't work with non-blocking XREAD — resolve to actual last ID once
      if (!lastId || lastId === "$") {
        const latest = await this.redis.xrevrange(redisKey, "+", "-", "COUNT", 1);
        lastId = latest.length > 0 ? (latest[0] as [string, string[]])[0] : "0-0";
        this.lastIds.set(channel, lastId!);
        logger.debug({ channel, redisKey, resolvedId: lastId }, "Resolved stream position");
        return; // Skip this cycle, next poll uses real ID
      }

      const result = await this.redis.xread("COUNT", 100, "STREAMS", redisKey, lastId);
      if (!result) return;

      for (const [, entries] of result as Array<[string, Array<[string, string[]]>]>) {
        for (const [id, fields] of entries) {
          this.lastIds.set(channel, id);
          const dataIdx = fields.indexOf("data");
          if (dataIdx !== -1 && fields[dataIdx + 1]) {
            this.dispatch(channel, JSON.parse(fields[dataIdx + 1]!));
          }
        }
      }
    } catch {
      // ignore
    }
  }

  private dispatch(channel: string, data: Record<string, unknown>): void {
    const handlers = this.handlers.get(channel);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(channel, data);
      } catch {
        // ignore
      }
    }
  }

  private isSnapshotKey(key: string): boolean {
    return (
      key.startsWith("snapshot:") ||
      key.startsWith("risk:snapshot:") ||
      key.startsWith("hedge:snapshot:") ||
      key === "trade:open" ||
      key === "trade:stats"
    );
  }

  private channelToRedisKey(channel: string): string | null {
    const map: Record<string, string> = {
      "risk:drawdown": "risk:signals:drawdown",
      "risk:levels": "risk:signals:levels",
      "risk:volatility": "risk:signals:volatility",
      "risk:exposure": "risk:snapshot:exposure",
      "risk:alerts": "risk:alerts",
      "hedge:state": "hedge:snapshot:state",
      "hedge:recommendations": "hedge:recommendations",
      "trade:orders": "trade:orders",
      "trade:positions": "trade:open",
      "trade:stats": "trade:stats",
    };

    if (map[channel]) return map[channel]!;

    // Dynamic: orderbook:{exchange}:{symbol} -> md:orderbook:{exchange}:{symbol}
    if (channel.startsWith("orderbook:")) return `md:${channel}`;
    if (channel.startsWith("trades:")) return `md:${channel}`;
    if (channel.startsWith("ticker:")) return `md:${channel}`;

    logger.warn({ channel }, "Unknown channel mapping");
    return null;
  }
}
