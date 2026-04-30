import type { RedisBus } from "../bus/redis-bus.ts";
import type { SimAccountState } from "../types/sim.types.ts";
import { SimSnapshotKeys } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "sim-account" });

/**
 * Persistent paper-trading account state.
 * Persists every mutation to Redis so restarts and UI reads always see fresh data.
 */
export class SimAccount {
  private bus: RedisBus;
  private state: SimAccountState;

  constructor(bus: RedisBus, state: SimAccountState) {
    this.bus = bus;
    this.state = state;
  }

  static makeInitial(accountId: string, initialEquity: number): SimAccountState {
    const now = Date.now();
    return {
      accountId,
      initialEquity,
      cashUSDT: initialEquity,
      realizedPnl: 0,
      peakEquity: initialEquity,
      dailyStartEquity: initialEquity,
      dailyStartedAt: now,
      createdAt: now,
      resetAt: now,
    };
  }

  /** Load from Redis or initialize a fresh account. */
  static async load(bus: RedisBus, accountId: string, initialEquity: number): Promise<SimAccount> {
    const raw = await bus.getSnapshot<SimAccountState>(SimSnapshotKeys.account(accountId));
    if (raw && raw.accountId === accountId) {
      logger.info({ accountId, cash: raw.cashUSDT, realized: raw.realizedPnl }, "Sim account loaded");
      return new SimAccount(bus, raw);
    }
    const fresh = SimAccount.makeInitial(accountId, initialEquity);
    const acc = new SimAccount(bus, fresh);
    await acc.persist();
    logger.info({ accountId, initialEquity }, "Sim account initialized");
    return acc;
  }

  /** Reset to fresh state. New initial equity if provided, otherwise keep previous. */
  async reset(initialEquity?: number): Promise<void> {
    const equity = initialEquity ?? this.state.initialEquity;
    this.state = SimAccount.makeInitial(this.state.accountId, equity);
    await this.persist();
    logger.info({ accountId: this.state.accountId, initialEquity: equity }, "Sim account reset");
  }

  /** Read-only snapshot. */
  get snapshot(): SimAccountState {
    return { ...this.state };
  }

  get accountId(): string {
    return this.state.accountId;
  }

  get cash(): number {
    return this.state.cashUSDT;
  }

  get peakEquity(): number {
    return this.state.peakEquity;
  }

  get dailyStartEquity(): number {
    return this.state.dailyStartEquity;
  }

  /** Apply realized PnL (positive or negative) to cash and totals. */
  async applyRealizedPnl(pnlUSD: number): Promise<void> {
    this.state.cashUSDT += pnlUSD;
    this.state.realizedPnl += pnlUSD;
    await this.persist();
  }

  /** Charge a fee against cash. */
  async chargeFee(feeUSD: number): Promise<void> {
    this.state.cashUSDT -= feeUSD;
    await this.persist();
  }

  /** Charge funding (positive = paid, negative = received). */
  async chargeFunding(fundingUSD: number): Promise<void> {
    this.state.cashUSDT -= fundingUSD;
    await this.persist();
  }

  /** Update peak equity if mark-to-market equity is higher. Reset daily roll-over. */
  async updatePeakAndDaily(currentEquity: number): Promise<void> {
    let dirty = false;
    if (currentEquity > this.state.peakEquity) {
      this.state.peakEquity = currentEquity;
      dirty = true;
    }
    // Roll daily window every 24h
    if (Date.now() - this.state.dailyStartedAt >= 24 * 60 * 60 * 1000) {
      this.state.dailyStartEquity = currentEquity;
      this.state.dailyStartedAt = Date.now();
      dirty = true;
    }
    if (dirty) await this.persist();
  }

  async persist(): Promise<void> {
    await this.bus.setSnapshot(SimSnapshotKeys.account(this.state.accountId), this.state);
  }
}
