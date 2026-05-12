import Redis from "ioredis";
import pino from "pino";

const logger = pino({ name: "redis-bus" });

export class RedisBus {
  private redis: Redis;
  private sub: Redis; // separate connection for blocking reads

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
    this.sub = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });

    for (const conn of [this.redis, this.sub]) {
      conn.on("error", (err) => logger.error({ err }, "Redis connection error"));
      conn.on("reconnecting", () => logger.warn("Redis reconnecting..."));
    }
  }

  async connect(): Promise<void> {
    await Promise.all([this.redis.connect(), this.sub.connect()]);
    logger.info("Redis bus connected");
  }

  // ─── Publish to stream ─────────────────────────────────────────

  async publish(
    streamKey: string,
    data: Record<string, unknown>,
    maxLen: number = 10_000
  ): Promise<string> {
    const fields: string[] = ["data", JSON.stringify(data)];
    const id = await this.redis.xadd(streamKey, "MAXLEN", "~", maxLen, "*", ...fields);
    return id!;
  }

  // ─── Snapshot (SET with optional TTL) ──────────────────────────

  async setSnapshot(key: string, data: unknown, ttl?: number): Promise<void> {
    const serialized = JSON.stringify(data);
    if (ttl) {
      await this.redis.set(key, serialized, "EX", ttl);
    } else {
      await this.redis.set(key, serialized);
    }
  }

  async getSnapshot<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  }

  // ─── Cache GET / SET ───────────────────────────────────────────

  async cacheGet(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async cacheSet(key: string, value: string, ttl: number): Promise<void> {
    await this.redis.set(key, value, "EX", ttl);
  }

  async cacheDel(key: string): Promise<void> {
    await this.redis.del(key);
  }

  // ─── Consumer group setup ──────────────────────────────────────

  async ensureConsumerGroup(streamKey: string, groupName: string): Promise<void> {
    try {
      await this.redis.xgroup("CREATE", streamKey, groupName, "0", "MKSTREAM");
    } catch (err: unknown) {
      // Group already exists — that's fine
      if (err instanceof Error && err.message.includes("BUSYGROUP")) return;
      throw err;
    }
  }

  // ─── Read from stream (for consumers) ──────────────────────────

  async readGroup(
    groupName: string,
    consumerName: string,
    streamKey: string,
    count: number = 10,
    blockMs: number = 5000
  ): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
    const result = await this.sub.xreadgroup(
      "GROUP",
      groupName,
      consumerName,
      "COUNT",
      count,
      "BLOCK",
      blockMs,
      "STREAMS",
      streamKey,
      ">"
    );

    if (!result) return [];

    const messages: Array<{ id: string; data: Record<string, unknown> }> = [];
    for (const stream of result as Array<[string, Array<[string, string[]]>]>) {
      const [, entries] = stream;
      for (const [id, fields] of entries) {
        const dataIdx = fields.indexOf("data");
        if (dataIdx !== -1 && fields[dataIdx + 1]) {
          messages.push({ id, data: JSON.parse(fields[dataIdx + 1]!) });
        }
      }
    }
    return messages;
  }

  /**
   * Read from multiple streams in one XREADGROUP call. The Redis server wakes
   * the BLOCK as soon as ANY of the streams gets new data, so latency is
   * bounded by Redis dispatch (microseconds) rather than by other in-flight
   * BLOCKs on the same connection.
   */
  async readGroupMulti(
    groupName: string,
    consumerName: string,
    streamKeys: readonly string[],
    count: number = 10,
    blockMs: number = 5000,
  ): Promise<Array<{ stream: string; id: string; data: Record<string, unknown> }>> {
    if (streamKeys.length === 0) return [];
    const args: (string | number)[] = [
      "GROUP", groupName, consumerName,
      "COUNT", count,
      "BLOCK", blockMs,
      "STREAMS",
      ...streamKeys,
      ...streamKeys.map(() => ">"),
    ];
    const result = await (this.sub.xreadgroup as (...a: unknown[]) => Promise<unknown>)(...args);
    if (!result) return [];

    const messages: Array<{ stream: string; id: string; data: Record<string, unknown> }> = [];
    for (const stream of result as Array<[string, Array<[string, string[]]>]>) {
      const [streamKey, entries] = stream;
      for (const [id, fields] of entries) {
        const dataIdx = fields.indexOf("data");
        if (dataIdx !== -1 && fields[dataIdx + 1]) {
          messages.push({ stream: streamKey, id, data: JSON.parse(fields[dataIdx + 1]!) });
        }
      }
    }
    return messages;
  }

  // ─── ACK ───────────────────────────────────────────────────────

  async ack(streamKey: string, groupName: string, ...ids: string[]): Promise<void> {
    if (ids.length > 0) {
      await this.redis.xack(streamKey, groupName, ...ids);
    }
  }

  // ─── Read latest N from stream (no group) ──────────────────────

  async readLatest(
    streamKey: string,
    count: number = 1
  ): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
    const result = await this.redis.xrevrange(streamKey, "+", "-", "COUNT", count);
    return result.map(([id, fields]) => {
      const dataIdx = fields.indexOf("data");
      const data = dataIdx !== -1 ? JSON.parse(fields[dataIdx + 1]!) : {};
      return { id, data };
    });
  }

  // ─── Cleanup ───────────────────────────────────────────────────

  async disconnect(): Promise<void> {
    this.redis.disconnect();
    this.sub.disconnect();
    logger.info("Redis bus disconnected");
  }

  /** Expose raw Redis for advanced operations */
  get client(): Redis {
    return this.redis;
  }
}
