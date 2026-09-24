export type Verdict = 'success' | 'failure' | 'ignore';

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

export class BulkheadTimeoutError extends Error {
  readonly code = 'BULKHEAD_TIMEOUT';
  constructor(name: string, detail: string, cause?: unknown) {
    super(`bulkhead "${name}": ${detail}`, { cause });
    this.name = 'BulkheadTimeoutError';
  }
}

export class RetryBudgetExhaustedError extends Error {
  readonly code = 'RETRY_BUDGET_EXHAUSTED';
  constructor(name: string, cause: unknown) {
    super(`retry budget for "${name}" is exhausted`, { cause });
    this.name = 'RetryBudgetExhaustedError';
  }
}

export class IndeterminateError extends Error {
  readonly code = 'INDETERMINATE';
  constructor(name: string, cause: unknown) {
    super(`outcome of "${name}" is unknown and could not be confirmed`, { cause });
    this.name = 'IndeterminateError';
  }
}
