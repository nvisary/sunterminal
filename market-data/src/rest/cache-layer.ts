import type { RedisBus } from "../bus/redis-bus.ts";
import type { CacheOptions } from "../types/market-data.types.ts";
import pino from "pino";

const logger = pino({ name: "cache-layer" });

export class CacheLayer {
  private bus: RedisBus;
  private inflight = new Map<string, Promise<unknown>>();

  constructor(bus: RedisBus) {
    this.bus = bus;
  }

  /**
   * Get cached value or fetch via fetcher, with TTL, stale-while-revalidate, and request dedup.
   */
  async getOrFetch<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: CacheOptions
  ): Promise<T> {
    const { ttl, staleWhileRevalidate = true, forceRefresh = false } = options;

    // Force refresh — skip cache
    if (forceRefresh) {
      return this.fetchAndCache(key, fetcher, ttl);
    }

    // Try cache
    const cached = await this.bus.cacheGet(key);
    if (cached !== null) {
      return JSON.parse(cached) as T;
    }

    // Check TTL — if key exists but expired, and stale-while-revalidate is on,
    // return stale data and refresh in background.
    // Since Redis auto-deletes expired keys, "cached !== null" above already covers valid cache.
    // For stale-while-revalidate, we use a separate stale key.
    const staleKey = `${key}:stale`;
    if (staleWhileRevalidate) {
      const stale = await this.bus.cacheGet(staleKey);
      if (stale !== null) {
        // Return stale, refresh in background
        this.refreshInBackground(key, staleKey, fetcher, ttl);
        return JSON.parse(stale) as T;
      }
    }

    // Cache miss — fetch with dedup
    return this.fetchAndCache(key, fetcher, ttl);
  }

  private async fetchAndCache<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttl: number
  ): Promise<T> {
    // Request dedup: if a fetch for this key is already inflight, wait for it
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = (async () => {
      try {
        const result = await fetcher();
        const serialized = JSON.stringify(result);

        // Set main cache with TTL
        await this.bus.cacheSet(key, serialized, ttl);

        // Set stale copy with extended TTL (5x) for stale-while-revalidate
        await this.bus.cacheSet(`${key}:stale`, serialized, ttl * 5);

        return result;
      } catch (err) {
        logger.error({ key, err }, "Cache fetch failed");
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  private refreshInBackground<T>(
    key: string,
    staleKey: string,
    fetcher: () => Promise<T>,
    ttl: number
  ): void {
    // Don't start another refresh if one is already running
    if (this.inflight.has(key)) return;

    const promise = (async () => {
      try {
        const result = await fetcher();
        const serialized = JSON.stringify(result);
        await this.bus.cacheSet(key, serialized, ttl);
        await this.bus.cacheSet(staleKey, serialized, ttl * 5);
      } catch (err) {
        logger.warn({ key, err }, "Background refresh failed, stale data preserved");
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
  }

  /** Invalidate a cache key (and its stale copy) */
  async invalidate(key: string): Promise<void> {
    await this.bus.cacheDel(key);
    await this.bus.cacheDel(`${key}:stale`);
  }
}
