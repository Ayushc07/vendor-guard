/**
 * How a call's outcome should be interpreted by the resilience layer.
 *
 * The distinction that matters most is `ignore`. A vendor replying
 * "no record found for this PAN" is a *business answer*, not a fault.
 * Counting it as a failure is the classic way to take a healthy vendor
 * offline for everyone the moment a batch of genuinely invalid
 * applicants arrives.
 */
export type Verdict = 'success' | 'failure' | 'ignore';

/** Classifies a thrown value, or a returned value, into a verdict. */
export interface Classifier {
  onError(error: unknown): Verdict;
  onSuccess?(value: unknown): Verdict;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';
  readonly retryAfterMs: number;
  constructor(name: string, retryAfterMs: number) {
    super(`circuit "${name}" is open; retry in ${retryAfterMs}ms`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class BulkheadFullError extends Error {
  readonly code = 'BULKHEAD_FULL';
  constructor(name: string) {
    super(`bulkhead "${name}" is saturated`);
    this.name = 'BulkheadFullError';
  }
}

export class RetryBudgetExhaustedError extends Error {
  readonly code = 'RETRY_BUDGET_EXHAUSTED';
  constructor(name: string, cause: unknown) {
    super(`retry budget for "${name}" is exhausted`, { cause });
    this.name = 'RetryBudgetExhaustedError';
  }
}

/**
 * Thrown when a non-replayable call failed in a way that leaves its
 * real outcome unknown, and the confirmation lookup could not settle it.
 *
 * This is deliberately its own type. A timeout on a disbursal is not a
 * failure — it is an *unknown*, and code that treats the two the same
 * is how money moves twice.
 */
export class IndeterminateError extends Error {
  readonly code = 'INDETERMINATE';
  constructor(name: string, cause: unknown) {
    super(`outcome of "${name}" is unknown and could not be confirmed`, { cause });
    this.name = 'IndeterminateError';
  }
}
