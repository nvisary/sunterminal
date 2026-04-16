import type { HedgePosition } from "../types/hedge.types.ts";
import pino from "pino";

const logger = pino({ name: "order-tracker" });

/**
 * Tracks active hedge positions in memory.
 * Updated when hedges are opened/closed.
 */
export class OrderTracker {
  private hedges = new Map<string, HedgePosition>();

  addHedge(hedge: HedgePosition): void {
    this.hedges.set(hedge.id, hedge);
    logger.info({ id: hedge.id, exchange: hedge.exchange, symbol: hedge.symbol, side: hedge.side, size: hedge.size }, "Hedge tracked");
  }

  removeHedge(id: string): void {
    this.hedges.delete(id);
    logger.info({ id }, "Hedge removed");
  }

  getHedge(id: string): HedgePosition | undefined {
    return this.hedges.get(id);
  }

  getActiveHedges(): HedgePosition[] {
    return [...this.hedges.values()];
  }

  getTotalHedgeSize(): number {
    let total = 0;
    for (const h of this.hedges.values()) {
      total += h.size;
    }
    return total;
  }

  getHedgesByExchange(exchange: string): HedgePosition[] {
    return this.getActiveHedges().filter((h) => h.exchange === exchange);
  }

  getHedgesBySymbol(symbol: string): HedgePosition[] {
    return this.getActiveHedges().filter((h) => h.symbol === symbol);
  }

  clear(): void {
    this.hedges.clear();
  }

  updatePrice(exchange: string, symbol: string, price: number): void {
    for (const hedge of this.hedges.values()) {
      if (hedge.exchange === exchange && hedge.symbol === symbol) {
        hedge.currentPrice = price;
        const priceDiff = hedge.side === "long"
          ? price - hedge.entryPrice
          : hedge.entryPrice - price;
        hedge.unrealizedPnl = (priceDiff / hedge.entryPrice) * hedge.size;
      }
    }
  }
}
