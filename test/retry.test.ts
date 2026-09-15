import test from 'node:test';
import assert from 'node:assert/strict';
import { guard, backoffDelay, defaultRetryOptions } from '../src/guard.ts';
import { RetryBudgetExhaustedError } from '../src/types.ts';
import { ManualClock, httpError, networkError } from './helpers.ts';

const fixedRandom = () => 1; // full jitter at its ceiling, so delays are predictable

test('retries a transient 503 and succeeds', async () => {
  const clock = new ManualClock();
  const g = guard({ name: 'bureau', clock, retry: { maxAttempts: 3, random: fixedRandom } });
  let calls = 0;
  const result = await g.execute(async () => {
    calls += 1;
    if (calls < 3) throw httpError(503);
    return 'report';
  });
  assert.equal(result, 'report');
  assert.equal(calls, 3);
  assert.deepEqual(clock.slept, [100, 200]);
});

test('never retries a business 4xx', async () => {
  const clock = new ManualClock();
  const g = guard({ name: 'bureau', clock, retry: { maxAttempts: 5, random: fixedRandom } });
  let calls = 0;
  await assert.rejects(
    g.execute(async () => { calls += 1; throw httpError(404); }),
    /HTTP 404/,
  );
  assert.equal(calls, 1, 'a "no record found" is an answer, not a fault');
  assert.deepEqual(clock.slept, []);
});

test('retries transport errors', async () => {
  const clock = new ManualClock();
  const g = guard({ name: 'bureau', clock, retry: { maxAttempts: 2, random: fixedRandom } });
  let calls = 0;
  await assert.rejects(g.execute(async () => { calls += 1; throw networkError('ECONNRESET'); }));
  assert.equal(calls, 2);
});

test('honours Retry-After over computed backoff', async () => {
  const clock = new ManualClock();
  const g = guard({ name: 'bureau', clock, retry: { maxAttempts: 2, random: fixedRandom } });
  await assert.rejects(g.execute(async () => { throw httpError(429, { headers: { 'retry-after': '5' } }); }));
  assert.deepEqual(clock.slept, [5_000]);
});

test('stops at maxAttempts', async () => {
  const clock = new ManualClock();
  const g = guard({ name: 'bureau', clock, retry: { maxAttempts: 4, random: fixedRandom } });
  let calls = 0;
  await assert.rejects(g.execute(async () => { calls += 1; throw httpError(500); }));
  assert.equal(calls, 4);
});

test('retry budget refuses to amplify a sustained outage', async () => {
  const clock = new ManualClock();
  const g = guard({
    name: 'bureau', clock,
    retry: { maxAttempts: 2, random: fixedRandom },
    budget: { ratio: 0.1, minTokens: 2 },
    breaker: { minimumThroughput: 10_000 }, // keep the breaker out of this test
  });
  let exhausted = 0;
  for (let i = 0; i < 12; i += 1) {
    try {
      await g.execute(async () => { throw httpError(500); });
    } catch (error) {
      if (error instanceof RetryBudgetExhaustedError) exhausted += 1;
    }
  }
  assert.ok(exhausted > 0, 'budget must eventually refuse retries during a sustained outage');
});

test('full-jitter backoff never exceeds its ceiling and is capped', () => {
  const options = { ...defaultRetryOptions, baseDelayMs: 100, maxDelayMs: 1_000, random: () => 0.999 };
  assert.ok(backoffDelay(1, options) < 100);
  assert.ok(backoffDelay(2, options) < 200);
  assert.ok(backoffDelay(10, options) < 1_000, 'must respect maxDelayMs');
  assert.equal(backoffDelay(3, { ...options, random: () => 0 }), 0, 'full jitter can pick zero');
});
