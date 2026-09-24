import { CircuitBreaker, defaultBreakerOptions, type BreakerOptions, type BreakerState } from './breaker.ts';
import { Bulkhead, type BulkheadOptions } from './bulkhead.ts';
import { RetryBudget, type BudgetOptions } from './budget.ts';
import { defaultClassifier, retryAfterMs } from './classify.ts';
import {
  IndeterminateError, RetryBudgetExhaustedError,
  systemClock, type Classifier, type Clock,
} from './types.ts';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random: () => number;
}

export const defaultRetryOptions: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  random: Math.random,
};

export interface GuardOptions {
  name: string;
  breaker?: Partial<BreakerOptions>;
  retry?: Partial<RetryOptions>;
  budget?: Partial<BudgetOptions>;
  bulkhead?: Partial<BulkheadOptions>;
  classifier?: Classifier;
  clock?: Clock;
}

export interface OnceOptions<T> {
  confirm?: () => Promise<T | undefined>;
  confirmAttempts?: number;
}

type ConfirmOutcome<T> =
  | { kind: 'performed'; value: T }
  | { kind: 'not-performed' }
  | { kind: 'unknown' };

export function backoffDelay(attempt: number, options: RetryOptions): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(options.random() * ceiling);
}

export class Guard {
  readonly name: string;
  private readonly breaker: CircuitBreaker;
  private readonly bulkhead: Bulkhead;
  private readonly budget: RetryBudget;
  private readonly retry: RetryOptions;
  private readonly classifier: Classifier;
  private readonly clock: Clock;

  constructor(options: GuardOptions) {
    this.name = options.name;
    this.clock = options.clock ?? systemClock;
    this.classifier = options.classifier ?? defaultClassifier;
    this.retry = { ...defaultRetryOptions, ...options.retry };
    this.breaker = new CircuitBreaker(options.name, { ...defaultBreakerOptions, ...options.breaker }, this.clock);
    this.bulkhead = new Bulkhead(options.name, options.bulkhead);
    this.budget = new RetryBudget(options.budget, this.clock);
  }

  state(): BreakerState {
    return this.breaker.currentState();
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    this.budget.deposit();
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      try {
        return await this.attempt(operation);
      } catch (error) {
        lastError = error;
        const verdict = this.classifier.onError(error);
        if (verdict !== 'failure') throw error;
        if (attempt === this.retry.maxAttempts) throw error;
        if (!this.retryableCircuitState(error)) throw error;
        if (!this.budget.withdraw()) throw new RetryBudgetExhaustedError(this.name, error);
        const hinted = retryAfterMs(error, this.clock.now());
        await this.clock.sleep(hinted ?? backoffDelay(attempt, this.retry));
      }
    }
    throw lastError;
  }

  async executeOnce<T>(operation: () => Promise<T>, options: OnceOptions<T> = {}): Promise<T> {
    this.budget.deposit();
    try {
      return await this.attempt(operation);
    } catch (error) {
      const verdict = this.classifier.onError(error);
      if (verdict !== 'failure') throw error;
      if (!options.confirm) throw new IndeterminateError(this.name, error);

      const outcome = await this.confirmOutcome(options.confirm, options.confirmAttempts ?? 3);
      switch (outcome.kind) {
        case 'performed': return outcome.value;
        case 'not-performed': throw error;
        case 'unknown': throw new IndeterminateError(this.name, error);
      }
    }
  }

  private async confirmOutcome<T>(
    confirm: () => Promise<T | undefined>,
    attempts: number,
  ): Promise<ConfirmOutcome<T>> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const confirmed = await confirm();
        return confirmed === undefined ? { kind: 'not-performed' } : { kind: 'performed', value: confirmed };
      } catch {
        if (attempt === attempts) return { kind: 'unknown' };
        await this.clock.sleep(backoffDelay(attempt, this.retry));
      }
    }
    return { kind: 'unknown' };
  }

  private async attempt<T>(operation: () => Promise<T>): Promise<T> {
    this.breaker.acquire();
    await this.bulkhead.acquire();
    const startedAt = this.clock.now();
    try {
      const result = await operation();
      this.breaker.recordSuccess(this.clock.now() - startedAt);
      return result;
    } catch (error) {
      const verdict = this.classifier.onError(error);
      if (verdict === 'failure') this.breaker.recordFailure(this.clock.now() - startedAt);
      else this.breaker.recordIgnored();
      throw error;
    } finally {
      this.bulkhead.release();
    }
  }

  private retryableCircuitState(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code !== 'CIRCUIT_OPEN';
  }
}

export function guard(options: GuardOptions): Guard {
  return new Guard(options);
}
