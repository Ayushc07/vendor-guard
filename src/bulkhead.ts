import { BulkheadFullError } from './types.ts';

export interface BulkheadOptions {
  maxConcurrent: number;
  maxQueue: number;
}

export const defaultBulkheadOptions: BulkheadOptions = { maxConcurrent: 20, maxQueue: 50 };

/**
 * Bounded concurrency per vendor.
 *
 * A slow vendor is more dangerous than a down one: down fails fast, slow holds
 * your workers. This keeps one vendor's latency inside its own pool instead of
 * letting it consume every connection the service has.
 */
export class Bulkhead {
  private inFlight = 0;
  private queue: Array<() => void> = [];

  private readonly name: string;
  private readonly options: BulkheadOptions;

  constructor(name: string, options: BulkheadOptions = defaultBulkheadOptions) {
    this.name = name;
    this.options = options;
  }

  async acquire(): Promise<void> {
    if (this.inFlight < this.options.maxConcurrent) {
      this.inFlight += 1;
      return;
    }
    if (this.queue.length >= this.options.maxQueue) throw new BulkheadFullError(this.name);
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.inFlight += 1;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  stats(): { inFlight: number; queued: number } {
    return { inFlight: this.inFlight, queued: this.queue.length };
  }
}
