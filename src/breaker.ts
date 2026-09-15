import { CircuitOpenError, type Clock } from './types.ts';

export interface BreakerOptions {
  /** Fraction of failures in the window that opens the circuit. */
  failureRateThreshold: number;
  /** Fraction of slow calls that opens it, independent of errors. */
  slowCallRateThreshold: number;
  /** A call slower than this counts as slow. */
  slowCallMs: number;
  /** Below this many recorded calls, rates are not trusted and the circuit stays closed. */
  minimumThroughput: number;
  /** Width of the rolling window. */
  windowMs: number;
  /** How long the circuit stays open before admitting probes. */
  openStateMs: number;
  /** Consecutive successful probes required to close again. */
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

/**
 * A rolling-window circuit breaker.
 *
 * Opening on a *rate* rather than a consecutive-failure count is what keeps
 * it from tripping on three unlucky calls at 3am; `minimumThroughput` is the
 * guard that stops a rate computed from two samples doing the same thing.
 */
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

  /** Throws CircuitOpenError if this call must not be attempted. */
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

  /** A business outcome. Reported to the caller, invisible to the breaker. */
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
    // A vendor that answers in 30s instead of erroring is still an outage.
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
