import { CircuitOpenError, type Clock } from './types.ts';

export interface BreakerOptions {
  failureRateThreshold: number;
  slowCallRateThreshold: number;
  slowCallMs: number;
  minimumThroughput: number;
  windowMs: number;
  openStateMs: number;
  halfOpenProbes: number;
}

export const defaultBreakerOptions: BreakerOptions = {
  failureRateThreshold: 0.5,
  slowCallRateThreshold: 0.5,
  slowCallMs: 2_000,
  minimumThroughput: 20,
  windowMs: 30_000,
  openStateMs: 30_000,
  halfOpenProbes: 3,
};

export type BreakerState = 'closed' | 'open' | 'half-open';

interface Sample { at: number; failed: boolean; slow: boolean }

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private samples: Sample[] = [];
  private openedAt = 0;
  private probesInFlight = 0;
  private probeSuccesses = 0;

  private readonly name: string;
  private readonly options: BreakerOptions;
  private readonly clock: Clock;

  constructor(name: string, options: BreakerOptions = defaultBreakerOptions, clock: Clock) {
    this.name = name;
    this.options = options;
    this.clock = clock;
  }

  currentState(): BreakerState {
    this.maybeHalfOpen();
    return this.state;
  }

  acquire(): void {
    this.maybeHalfOpen();
    if (this.state === 'open') {
      const waited = this.clock.now() - this.openedAt;
      throw new CircuitOpenError(this.name, Math.max(0, this.options.openStateMs - waited));
    }
    if (this.state === 'half-open') {
      if (this.probesInFlight >= this.options.halfOpenProbes) {
        throw new CircuitOpenError(this.name, this.options.openStateMs);
      }
      this.probesInFlight += 1;
    }
  }

  recordSuccess(durationMs: number): void {
    if (this.state === 'half-open') {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      this.probeSuccesses += 1;
      if (this.probeSuccesses >= this.options.halfOpenProbes) this.close();
      return;
    }
    this.push({ at: this.clock.now(), failed: false, slow: durationMs >= this.options.slowCallMs });
    this.evaluate();
  }

  recordFailure(durationMs: number): void {
    if (this.state === 'half-open') {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      this.open();
      return;
    }
    this.push({ at: this.clock.now(), failed: true, slow: durationMs >= this.options.slowCallMs });
    this.evaluate();
  }

  recordIgnored(): void {
    if (this.state === 'half-open') this.probesInFlight = Math.max(0, this.probesInFlight - 1);
  }

  private push(sample: Sample): void {
    this.samples.push(sample);
    this.prune(sample.at);
  }

  private prune(now: number): void {
    const cutoff = now - this.options.windowMs;
    let i = 0;
    while (i < this.samples.length && this.samples[i]!.at < cutoff) i += 1;
    if (i > 0) this.samples = this.samples.slice(i);
  }

  private evaluate(): void {
    const total = this.samples.length;
    if (total < this.options.minimumThroughput) return;
    const failures = this.samples.reduce((n, s) => n + (s.failed ? 1 : 0), 0);
    const slow = this.samples.reduce((n, s) => n + (s.slow ? 1 : 0), 0);
    if (failures / total >= this.options.failureRateThreshold) return this.open();
    if (slow / total >= this.options.slowCallRateThreshold) this.open();
  }

  private maybeHalfOpen(): void {
    if (this.state !== 'open') return;
    if (this.clock.now() - this.openedAt < this.options.openStateMs) return;
    this.state = 'half-open';
    this.probesInFlight = 0;
    this.probeSuccesses = 0;
  }

  private open(): void {
    this.state = 'open';
    this.openedAt = this.clock.now();
    this.samples = [];
    this.probesInFlight = 0;
    this.probeSuccesses = 0;
  }

  private close(): void {
    this.state = 'closed';
    this.samples = [];
    this.probesInFlight = 0;
    this.probeSuccesses = 0;
  }
}
