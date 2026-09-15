import { systemClock, type Clock } from './types.ts';

export interface BudgetOptions {
  /** Retries permitted per call — 0.1 means "at most 10% extra load". */
  ratio: number;
  /** Floor, so a low-volume vendor can still retry at all. */
  minTokens: number;
  /** Window over which traffic is observed in order to size the cap. */
  windowMs: number;
}

export const defaultBudgetOptions: BudgetOptions = { ratio: 0.1, minTokens: 10, windowMs: 10_000 };

/**
 * A retry budget.
 *
 * Backoff alone does not stop a retry storm: during a partial outage every
 * caller retries, and the extra load is exactly what turns it into a total
 * one. Capping retries as a fraction of real traffic is the part most
 * implementations leave out.
 *
 * Tokens accrue at `ratio` per call, and the balance is capped at the number
 * of retries the traffic actually seen over `windowMs` can justify. A cap that
 * ignored throughput would let a quiet hour bank an allowance that the next
 * burst spends all at once — which is the amplification this exists to stop.
 */
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

  /** Records one real call, and the retry allowance that call earns. */
  deposit(): void {
    const now = this.clock.now();
    this.calls.push(now);
    this.prune(now);
    this.tokens = Math.min(this.ceiling(), this.tokens + this.options.ratio);
  }

  /** Returns false when retrying would exceed the permitted share of traffic. */
  withdraw(): boolean {
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  available(): number {
    return this.tokens;
  }

  /**
   * The most retries the traffic currently in the window can justify — never
   * below `minTokens`, so a quiet vendor is not left unable to retry at all.
   */
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
