import test from 'node:test';
import assert from 'node:assert/strict';
import { guard } from '../src/guard.ts';
import { defaultClassifier } from '../src/classify.ts';
import { UnsuccessfulResponseError, type Classifier } from '../src/types.ts';
import { ManualClock } from './helpers.ts';

const fixedRandom = () => 0;

const bodyStatus: Classifier = {
  onError: defaultClassifier.onError,
  onSuccess(value) {
    const status = (value as { status?: unknown } | null)?.status;
    if (status === 'FAILED') return 'failure';
    if (status === 'REJECTED') return 'ignore';
    return 'success';
  },
};

test('a 200 whose body reports failure is retried, not returned', async () => {
  const clock = new ManualClock();
  const g = guard({
    name: 'rail', clock, classifier: bodyStatus,
    retry: { maxAttempts: 3, random: fixedRandom },
  });
  let calls = 0;
  const result = await g.execute(async () => {
    calls += 1;
    return calls < 3 ? { status: 'FAILED' } : { status: 'OK' };
  });
  assert.deepEqual(result, { status: 'OK' });
  assert.equal(calls, 3, 'a failure reported in the body must be retried like any other');
});

test('a 200 whose body reports failure opens the circuit', async () => {
  const clock = new ManualClock();
  const g = guard({
    name: 'rail', clock, classifier: bodyStatus,
    retry: { maxAttempts: 1, random: fixedRandom },
    breaker: { minimumThroughput: 4, failureRateThreshold: 0.5 },
  });
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(g.execute(async () => ({ status: 'FAILED' })), UnsuccessfulResponseError);
  }
  assert.equal(g.state(), 'open', 'a vendor failing in the body is still a vendor that is down');
});

test('the rejected value is carried on the error for the caller to inspect', async () => {
  const clock = new ManualClock();
  const g = guard({ name: 'rail', clock, classifier: bodyStatus, retry: { maxAttempts: 1 } });
  await assert.rejects(
    g.execute(async () => ({ status: 'FAILED', reason: 'insufficient balance' })),
    (error: unknown) => {
      assert.ok(error instanceof UnsuccessfulResponseError);
      assert.deepEqual(error.value, { status: 'FAILED', reason: 'insufficient balance' });
      return true;
    },
  );
});

test('an ignored body is returned to the caller and hidden from the breaker', async () => {
  const clock = new ManualClock();
  const g = guard({
    name: 'rail', clock, classifier: bodyStatus,
    retry: { maxAttempts: 1 },
    breaker: { minimumThroughput: 4, failureRateThreshold: 0.5 },
  });
  for (let i = 0; i < 10; i += 1) {
    assert.deepEqual(await g.execute(async () => ({ status: 'REJECTED' })), { status: 'REJECTED' });
  }
  assert.equal(g.state(), 'closed', 'a business rejection is an answer, not a fault');
});

test('a classifier without onSuccess leaves the success path untouched', async () => {
  const clock = new ManualClock();
  const g = guard({ name: 'rail', clock, retry: { maxAttempts: 1 } });
  assert.deepEqual(await g.execute(async () => ({ status: 'FAILED' })), { status: 'FAILED' });
  assert.equal(g.state(), 'closed');
});

test('executeOnce surfaces a body failure directly, never as indeterminate', async () => {
  const clock = new ManualClock();
  const g = guard({ name: 'disbursal', clock, classifier: bodyStatus, retry: { maxAttempts: 1 } });
  let confirmCalls = 0;
  let attempts = 0;
  await assert.rejects(
    g.executeOnce(
      async () => { attempts += 1; return { status: 'FAILED' }; },
      { confirm: async () => { confirmCalls += 1; return { status: 'OK' }; } },
    ),
    UnsuccessfulResponseError,
  );
  assert.equal(attempts, 1, 'a non-replayable call is still never repeated');
  assert.equal(confirmCalls, 0, 'the vendor answered; there is nothing left to confirm');
});
