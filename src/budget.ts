import { systemClock, type Clock } from './types.ts';

export interface BudgetOptions {
  ratio: number;
  minTokens: number;
  windowMs: number;
}

export const defaultBudgetOptions: BudgetOptions = { ratio: 0.1, minTokens: 10, windowMs: 10_000 };

export class RetryBudget {
  private tokens: number;
  private calls: number[] = [];
  private readonly options: BudgetOptions;
  private readonly clock: Clock;

  constructor(options: Partial<BudgetOptions> = {}, clock: Clock = systemClock) {
    this.options = { ...defaultBudgetOptions, ...options };
    this.clock = clock;
    this.tokens = this.options.minTokens;
  }

  deposit(): void {
    const now = this.clock.now();
    this.calls.push(now);
    this.prune(now);
    this.tokens = Math.min(this.ceiling(), this.tokens + this.options.ratio);
  }

  withdraw(): boolean {
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  available(): number {
    return this.tokens;
  }

  ceiling(): number {
    this.prune(this.clock.now());
    return Math.max(this.options.minTokens, this.options.ratio * this.calls.length);
  }

  private prune(now: number): void {
    const cutoff = now - this.options.windowMs;
    let i = 0;
    while (i < this.calls.length && this.calls[i]! < cutoff) i += 1;
    if (i > 0) this.calls = this.calls.slice(i);
  }
}
