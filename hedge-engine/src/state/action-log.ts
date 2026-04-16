import type { HedgeAction } from "../types/hedge.types.ts";

/**
 * In-memory action log, keeps last N actions.
 */
export class ActionLog {
  private actions: HedgeAction[] = [];
  private maxSize: number;

  constructor(maxSize: number = 500) {
    this.maxSize = maxSize;
  }

  add(action: HedgeAction): void {
    this.actions.push(action);
    if (this.actions.length > this.maxSize) {
      this.actions = this.actions.slice(-this.maxSize);
    }
  }

  getAll(limit?: number): HedgeAction[] {
    if (limit) {
      return this.actions.slice(-limit);
    }
    return [...this.actions];
  }

  getLast(): HedgeAction | undefined {
    return this.actions[this.actions.length - 1];
  }

  getByStrategy(strategy: string, limit?: number): HedgeAction[] {
    const filtered = this.actions.filter((a) => a.strategy === strategy);
    return limit ? filtered.slice(-limit) : filtered;
  }
}
