import { CircuitBreaker, defaultBreakerOptions, type BreakerOptions, type BreakerState } from './breaker.ts';
import { Bulkhead, type BulkheadOptions } from './bulkhead.ts';
import { RetryBudget, type BudgetOptions } from './budget.ts';
import { defaultClassifier, retryAfterMs } from './classify.ts';
import {
  IndeterminateError, RetryBudgetExhaustedError,
  systemClock, type Classifier, type Clock,
} from './types.ts';

export interface RetryOptions {
  /** Total attempts including the first. 1 disables retrying. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injectable for deterministic tests. */
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
  /**
   * Settles an unknown outcome. Called when the operation failed in a way that
   * does not prove it did not happen (a timeout, a dropped connection).
   *
   * Return the real result if the vendor did perform the operation, or
   * `undefined` if it provably did not.
   */
  confirm?: () => Promise<T | undefined>;
  /** Attempts of the *confirmation* lookup, which is a read and so is safe to repeat. */
  confirmAttempts?: number;
}

/** What a confirmation lookup was able to establish about a non-replayable call. */
type ConfirmOutcome<T> =
  | { kind: 'performed'; value: T }
  | { kind: 'not-performed' }
  | { kind: 'unknown' };

/**
 * Full-jitter exponential backoff.
 *
 * The jitter is not decoration: without it, every caller that failed at the
 * same instant retries at the same instant, and the vendor gets its outage
 * back in synchronised waves.
 */
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

  /**
   * Run an operation that is safe to repeat — a bureau pull, a GST lookup,
   * any read. Failures are retried within the budget.
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    // One call earns one deposit. Depositing per attempt would let retries top
    // the budget up as they spend it, funding the amplification it exists to stop.
    this.budget.deposit();
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      try {
        return await this.attempt(operation);
      } catch (error) {
        lastError = error;
        const verdict = this.classifier.onError(error);
        // A business answer is the caller's problem, not something to repeat.
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

  /**
   * Run an operation that must happen at most once — a disbursal, a mandate
   * registration, anything that moves money.
   *
   * It is never retried. If it fails in a way that leaves the outcome unknown,
   * `confirm` is asked what actually happened; if that cannot settle it, an
   * IndeterminateError is raised so a human or a reconciliation sweep decides.
   */
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
        // The vendor did perform it; the caller gets the real result.
        case 'performed': return outcome.value;
        // The vendor states it did not, so the original failure stands.
        case 'not-performed': throw error;
        // Nobody can say. Explicitly not a failure — see IndeterminateError.
        case 'unknown': throw new IndeterminateError(this.name, error);
      }
    }
  }

  /**
   * Asks the confirmation lookup what actually happened.
   *
   * The lookup is a read, so it may be repeated. Its three answers are returned
   * as data rather than signalled by throwing: distinguishing "the vendor says
   * no" from "the lookup itself broke" by inspecting what came back out of a
   * catch block is how the two get confused.
   */
  private async confirmOutcome<T>(
    confirm: () => Promise<T | undefined>,
    attempts: number,
  ): Promise<ConfirmOutcome<T>> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const confirmed = await confirm();
        // `undefined` is the vendor stating the operation did not happen.
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

  /** Never spend a retry on a circuit that has just opened. */
  private retryableCircuitState(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code !== 'CIRCUIT_OPEN';
  }
}

export function guard(options: GuardOptions): Guard {
  return new Guard(options);
}
