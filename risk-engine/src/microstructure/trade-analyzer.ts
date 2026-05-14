/**
 * Trade-based microstructural analysis.
 * Tracks Cumulative Volume Delta (CVD) and Buy/Sell pressure.
 */

export interface Trade {
  id: string;
  side: "buy" | "sell";
  amount: number;
  price: number;
  timestamp: number;
}

export interface TradeMetrics {
  cvd: number;
  buyVolume: number;
  sellVolume: number;
  buyCount: number;
  sellCount: number;
  avgTradeSize: number;
}

export class TradeAnalyzer {
  private cvd: number = 0;
  private buyVolume: number = 0;
  private sellVolume: number = 0;
  private buyCount: number = 0;
  private sellCount: number = 0;

  private trades: Trade[] = [];
  private windowMs: number;

  constructor(windowMs: number = 60000) {
    this.windowMs = windowMs;
  }

  update(trade: Trade): TradeMetrics {
    this.trades.push(trade);

    if (trade.side === "buy") {
      this.buyVolume += trade.amount;
      this.buyCount++;
    } else {
      this.sellVolume += trade.amount;
      this.sellCount++;
    }

    this.cleanup();

    // CVD is now correctly windowed (Buy Vol - Sell Vol within the window)
    const currentCvd = this.buyVolume - this.sellVolume;
    const totalTrades = this.buyCount + this.sellCount;
    const avgTradeSize =
      totalTrades > 0 ? (this.buyVolume + this.sellVolume) / totalTrades : 0;

    return {
      cvd: currentCvd,
      buyVolume: this.buyVolume,
      sellVolume: this.sellVolume,
      buyCount: this.buyCount,
      sellCount: this.sellCount,
      avgTradeSize,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    const threshold = now - this.windowMs;

    while (this.trades.length > 0 && this.trades[0]!.timestamp < threshold) {
      const old = this.trades.shift()!;
      if (old.side === "buy") {
        this.buyVolume -= old.amount;
        this.buyCount--;
      } else {
        this.sellVolume -= old.amount;
        this.sellCount--;
      }
    }
  }

  getMetrics(): TradeMetrics {
    const totalTrades = this.buyCount + this.sellCount;
    return {
      cvd: this.buyVolume - this.sellVolume,
      buyVolume: this.buyVolume,
      sellVolume: this.sellVolume,
      buyCount: this.buyCount,
      sellCount: this.sellCount,
      avgTradeSize:
        totalTrades > 0 ? (this.buyVolume + this.sellVolume) / totalTrades : 0,
    };
  }
}
