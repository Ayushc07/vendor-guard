import type { Clock } from '../src/types.ts';

export class ManualClock implements Clock {
  public slept: number[] = [];
  private t: number;
  constructor(t = 0) { this.t = t; }
  now(): number { return this.t; }
  advance(ms: number): void { this.t += ms; }
  async sleep(ms: number): Promise<void> { this.slept.push(ms); this.t += ms; }
}

export function httpError(status: number, extra: Record<string, unknown> = {}): Error & Record<string, unknown> {
  return Object.assign(new Error(`HTTP ${status}`), { status }, extra);
}

export function networkError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
