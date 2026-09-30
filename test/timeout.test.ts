import test from 'node:test';
import assert from 'node:assert/strict';
import { guard } from '../src/guard.ts';
import { CallTimeoutError, IndeterminateError, type Classifier } from '../src/types.ts';
import { ManualClock } from './helpers.ts';

const fixedRandom = () => 0;
const hang = () => new Promise<never>(() => {});

function abortable(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('a call that hangs is cut off at timeoutMs', async () => {
  const g = guard({ name: 'bureau', clock: new ManualClock(), timeoutMs: 20, retry: { maxAttempts: 1 } });
  const error = await g.execute(hang).catch((e: unknown) => e);
  assert.ok(error instanceof CallTimeoutError);
  assert.equal(error.timeoutMs, 20);
});

test('a timed-out call gives its bulkhead slot back', async () => {
  const g = guard({
    name: 'bureau', clock: new ManualClock(), timeoutMs: 20,
    retry: { maxAttempts: 1 }, bulkhead: { maxConcurrent: 1, maxQueue: 0 },
  });
  await assert.rejects(g.execute(hang), CallTimeoutError);
  assert.equal(await g.execute(async () => 'next'), 'next', 'a hung vendor must not keep the slot');
});

test('the operation is told to stop, with the timeout as the reason', async () => {
  const g = guard({ name: 'bureau', clock: new ManualClock(), timeoutMs: 20, retry: { maxAttempts: 1 } });
  let seen: AbortSignal | undefined;
  await assert.rejects(g.execute((signal) => { seen = signal; return abortable(signal); }), CallTimeoutError);
  assert.equal(seen?.aborted, true);
  assert.ok(seen?.reason instanceof CallTimeoutError);
});

test('a call that settles in time is neither aborted nor delayed', async () => {
  const g = guard({ name: 'bureau', clock: new ManualClock(), timeoutMs: 1_000 });
  let seen: AbortSignal | undefined;
  const result = await g.execute(async (signal) => { seen = signal; return 'ok'; });
  assert.equal(result, 'ok');
  assert.equal(seen?.aborted, false);
});

test('a replayable call that timed out is retried', async () => {
  const g = guard({
    name: 'bureau', clock: new ManualClock(), timeoutMs: 20,
    retry: { maxAttempts: 3, random: fixedRandom },
  });
  let calls = 0;
  const result = await g.execute(async (signal) => {
    calls += 1;
    return calls === 1 ? abortable(signal) : 'report';
  });
  assert.equal(result, 'report');
  assert.equal(calls, 2);
});

test('a timeout counts against the breaker whatever the classifier says', async () => {
  const lenient: Classifier = { onError: () => 'ignore' };
  const g = guard({
    name: 'bureau', clock: new ManualClock(), timeoutMs: 20, classifier: lenient,
    retry: { maxAttempts: 1 },
    breaker: { minimumThroughput: 2, failureRateThreshold: 0.5 },
  });
  await assert.rejects(g.execute(hang), CallTimeoutError);
  await assert.rejects(g.execute(hang), CallTimeoutError);
  assert.equal(g.state(), 'open', 'the guard produced this error; the classifier cannot excuse it');
});

test('a non-replayable call that timed out is confirmed, not retried', async () => {
  const g = guard({ name: 'disbursal', clock: new ManualClock(), timeoutMs: 20, retry: { maxAttempts: 5 } });
  let calls = 0;
  const result = await g.executeOnce(
    (signal) => { calls += 1; return abortable(signal); },
    { confirm: async () => ({ reference: 'DISB-7', status: 'SETTLED' }) },
  );
  assert.deepEqual(result, { reference: 'DISB-7', status: 'SETTLED' });
  assert.equal(calls, 1);
});

test('a non-replayable timeout with no way to confirm is indeterminate', async () => {
  const g = guard({ name: 'disbursal', clock: new ManualClock(), timeoutMs: 20 });
  const error = await g.executeOnce(hang).catch((e: unknown) => e);
  assert.ok(error instanceof IndeterminateError);
  assert.ok(error.cause instanceof CallTimeoutError, 'the vendor may still have acted on it');
});

test('timeoutMs must be a positive finite number', () => {
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => guard({ name: 'bureau', timeoutMs }), RangeError);
  }
});
