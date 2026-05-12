import type { Trade } from "./trade-analyzer.ts";

/**
 * Volume-Synchronized Probability of Informed Trading (VPIN).
 * Measures order flow toxicity by calculating buy/sell imbalance
 * over constant volume buckets.
 */
export class VPINCalculator {
  private bucketVolume: number; // Size of one bucket in USD or Base (matching trade amount)
  private bucketCount: number; // Window size in buckets

  private currentBucketBuy: number = 0;
  private currentBucketSell: number = 0;
  private buckets: Array<{ buy: number; sell: number }> = [];

  constructor(bucketVolume: number, bucketCount: number = 50) {
    this.bucketVolume = bucketVolume;
    this.bucketCount = bucketCount;
  }

  /**
   * Processes a new trade. Returns updated VPIN value (0 to 1).
   */
  update(trade: Trade): number {
    let remainingAmount = trade.amount;

    while (remainingAmount > 0) {
      const currentFilled = this.currentBucketBuy + this.currentBucketSell;
      const spaceInBucket = this.bucketVolume - currentFilled;
      const fillAmount = Math.min(remainingAmount, spaceInBucket);

      if (trade.side === "buy") {
        this.currentBucketBuy += fillAmount;
      } else {
        this.currentBucketSell += fillAmount;
      }

      remainingAmount -= fillAmount;

      // If bucket is full, finalize it
      if (this.currentBucketBuy + this.currentBucketSell >= this.bucketVolume - 1e-8) {
        this.buckets.push({ buy: this.currentBucketBuy, sell: this.currentBucketSell });

        // Cleanup window
        if (this.buckets.length > this.bucketCount) {
          this.buckets.shift();
        }

        this.currentBucketBuy = 0;
        this.currentBucketSell = 0;
      }
    }

    return this.calculateVPIN();
  }

  private calculateVPIN(): number {
    if (this.buckets.length === 0) return 0;

    let totalImbalance = 0;
    for (const b of this.buckets) {
      totalImbalance += Math.abs(b.buy - b.sell);
    }

    // VPIN = (1 / (n * V)) * sum(|V_buy - V_sell|)
    return totalImbalance / (this.buckets.length * this.bucketVolume);
  }
}
