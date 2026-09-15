import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, defaultBreakerOptions } from '../src/breaker.ts';
import { ManualClock } from './helpers.ts';

const opts = { ...defaultBreakerOptions, minimumThroughput: 10, windowMs: 1_000, openStateMs: 500, halfOpenProbes: 2 };

test('stays closed below minimum throughput even at 100% failure', () => {
  const clock = new ManualClock();
  const cb = new CircuitBreaker('vendor', opts, clock);
  for (let i = 0; i < 9; i += 1) cb.recordFailure(10);
  assert.equal(cb.currentState(), 'closed');
});

test('opens once the failure rate crosses the threshold with enough volume', () => {
  const clock = new ManualClock();
  const cb = new CircuitBreaker('vendor', opts, clock);
  for (let i = 0; i < 5; i += 1) cb.recordSuccess(10);
  for (let i = 0; i < 5; i += 1) cb.recordFailure(10);
  assert.equal(cb.currentState(), 'open');
  assert.throws(() => cb.acquire(), /is open/);
});

test('business outcomes never open the circuit', () => {
  const clock = new ManualClock();
  const cb = new CircuitBreaker('vendor', opts, clock);
  for (let i = 0; i < 50; i += 1) cb.recordIgnored();
  assert.equal(cb.currentState(), 'closed');
});

test('slow calls open the circuit even with no errors', () => {
  const clock = new ManualClock();
  const cb = new CircuitBreaker('vendor', { ...opts, slowCallMs: 100 }, clock);
  for (let i = 0; i < 10; i += 1) cb.recordSuccess(250);
  assert.equal(cb.currentState(), 'open');
});

test('old samples fall out of the rolling window', () => {
  const clock = new ManualClock();
  const cb = new CircuitBreaker('vendor', opts, clock);
  for (let i = 0; i < 9; i += 1) cb.recordFailure(10);
  clock.advance(2_000);
  cb.recordFailure(10);
  assert.equal(cb.currentState(), 'closed', 'stale failures should not count');
});

test('open -> half-open after the cooldown, and closes after enough probes', () => {
  const clock = new ManualClock();
  const cb = new CircuitBreaker('vendor', opts, clock);
  for (let i = 0; i < 10; i += 1) cb.recordFailure(10);
  assert.equal(cb.currentState(), 'open');

  clock.advance(500);
  assert.equal(cb.currentState(), 'half-open');

  cb.acquire(); cb.recordSuccess(10);
  cb.acquire(); cb.recordSuccess(10);
  assert.equal(cb.currentState(), 'closed');
});

test('a failed probe reopens the circuit immediately', () => {
  const clock = new ManualClock();
  const cb = new CircuitBreaker('vendor', opts, clock);
  for (let i = 0; i < 10; i += 1) cb.recordFailure(10);
  clock.advance(500);
  assert.equal(cb.currentState(), 'half-open');
  cb.acquire(); cb.recordFailure(10);
  assert.equal(cb.currentState(), 'open');
});

test('half-open admits only the configured number of probes', () => {
  const clock = new ManualClock();
  const cb = new CircuitBreaker('vendor', opts, clock);
  for (let i = 0; i < 10; i += 1) cb.recordFailure(10);
  clock.advance(500);
  cb.acquire();
  cb.acquire();
  assert.throws(() => cb.acquire(), /is open/);
});
