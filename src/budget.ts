
export interface BudgetOptions {
  /** Retries permitted per successful call — 0.1 means "at most 10% extra load". */
  ratio: number;
  /** Floor so a quiet service can still retry at all. */
  minTokens: number;
}

export const defaultBudgetOptions: BudgetOptions = { ratio: 0.1, minTokens: 10 };

/**
 * A retry budget.
 *
 * Backoff alone does not stop a retry storm: during a partial outage every
 * caller retries, and the extra load is exactly what turns it into a total
 * one. Capping retries as a fraction of real traffic is the part most
 * implementations leave out.
 */
export class RetryBudget {
  private tokens: number;
  private readonly options: BudgetOptions;

  constructor(options: BudgetOptions = defaultBudgetOptions) {
    this.options = options;
    this.tokens = options.minTokens;
  }

  /** Every attempted call earns a little retry allowance. */
  deposit(): void {
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

  private ceiling(): number {
    return Math.max(this.options.minTokens, this.options.minTokens * 2);
  }
}
