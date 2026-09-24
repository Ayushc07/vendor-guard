import { BulkheadFullError, BulkheadTimeoutError } from './types.ts';

export interface BulkheadOptions {
  maxConcurrent: number;
  maxQueue: number;
  queueTimeoutMs: number;
}

export const defaultBulkheadOptions: BulkheadOptions = {
  maxConcurrent: 20,
  maxQueue: 50,
  queueTimeoutMs: 10_000,
};

interface Waiter {
  admit(): void;
  cancel(detail: string, cause?: unknown): void;
}

export class Bulkhead {
  private inFlight = 0;
  private queue: Waiter[] = [];

  private readonly name: string;
  private readonly options: BulkheadOptions;

  constructor(name: string, options: Partial<BulkheadOptions> = {}) {
    this.name = name;
    this.options = { ...defaultBulkheadOptions, ...options };
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (this.inFlight < this.options.maxConcurrent) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.options.maxQueue) {
      return Promise.reject(new BulkheadFullError(this.name));
    }
    if (signal?.aborted) {
      return Promise.reject(new BulkheadTimeoutError(this.name, 'wait abandoned by caller', signal.reason));
    }

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const leave = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
        const at = this.queue.indexOf(waiter);
        if (at >= 0) this.queue.splice(at, 1);
      };

      const waiter: Waiter = {
        admit: () => { leave(); resolve(); },
        cancel: (detail, cause) => { leave(); reject(new BulkheadTimeoutError(this.name, detail, cause)); },
      };

      const onAbort = (): void => waiter.cancel('wait abandoned by caller', signal?.reason);

      timer = setTimeout(
        () => waiter.cancel(`no slot within ${this.options.queueTimeoutMs}ms`),
        this.options.queueTimeoutMs,
      );
      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) { next.admit(); return; }
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  stats(): { inFlight: number; queued: number } {
    return { inFlight: this.inFlight, queued: this.queue.length };
  }
}
