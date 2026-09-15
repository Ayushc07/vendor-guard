import test from 'node:test';
import assert from 'node:assert/strict';
import { guard } from '../src/guard.ts';
import { Bulkhead } from '../src/bulkhead.ts';
import { RetryBudget } from '../src/budget.ts';
import { BulkheadFullError, CircuitOpenError } from '../src/types.ts';
import { ManualClock, httpError } from './helpers.ts';

test('an open circuit fails fast instead of calling the vendor', async () => {
  const clock = new ManualClock();
  const g = guard({
    name: 'gst', clock,
    retry: { maxAttempts: 1, random: () => 0 },
    breaker: { minimumThroughput: 4, failureRateThreshold: 0.5, openStateMs: 1_000 },
  });
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(g.execute(async () => { throw httpError(500); }));
  }
  assert.equal(g.state(), 'open');

  let called = false;
  await assert.rejects(g.execute(async () => { called = true; return 'x'; }), CircuitOpenError);
  assert.equal(called, false, 'no request should reach a vendor known to be down');
});

test('the circuit recovers once the vendor does', async () => {
  const clock = new ManualClock();
  const g = guard({
    name: 'gst', clock,
    retry: { maxAttempts: 1, random: () => 0 },
    breaker: { minimumThroughput: 4, failureRateThreshold: 0.5, openStateMs: 1_000, halfOpenProbes: 1 },
  });
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(g.execute(async () => { throw httpError(500); }));
  }
  clock.advance(1_000);
  assert.equal(await g.execute(async () => 'recovered'), 'recovered');
  assert.equal(g.state(), 'closed');
});

test('bulkhead caps concurrency and rejects a full queue', async () => {
  const bh = new Bulkhead('vendor', { maxConcurrent: 2, maxQueue: 1 });
  await bh.acquire();
  await bh.acquire();
  assert.deepEqual(bh.stats(), { inFlight: 2, queued: 0 });

  const queued = bh.acquire();            // waits
  await assert.rejects(bh.acquire(), BulkheadFullError);

  bh.release();
  await queued;
  assert.equal(bh.stats().inFlight, 2);
});

test('retry budget grants, spends and refuses', () => {
  const budget = new RetryBudget({ ratio: 0.5, minTokens: 1 });
  assert.equal(budget.withdraw(), true);
  assert.equal(budget.withdraw(), false, 'nothing left to spend');
  budget.deposit();
  budget.deposit();
  assert.equal(budget.withdraw(), true, 'traffic refills the allowance');
});
