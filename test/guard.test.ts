import test from 'node:test';
import assert from 'node:assert/strict';
import { guard } from '../src/guard.ts';
import { Bulkhead } from '../src/bulkhead.ts';
import { RetryBudget } from '../src/budget.ts';
import { BulkheadFullError, BulkheadTimeoutError, CircuitOpenError } from '../src/types.ts';
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

test('a queued caller gives up instead of waiting forever', async () => {
  const bh = new Bulkhead('vendor', { maxConcurrent: 1, maxQueue: 5, queueTimeoutMs: 20 });
  await bh.acquire();                       // the only slot, never released
  await assert.rejects(bh.acquire(), BulkheadTimeoutError);
  assert.deepEqual(bh.stats(), { inFlight: 1, queued: 0 }, 'a caller that gave up must leave the queue');
});

test('a queued caller can be cancelled by its own signal', async () => {
  const bh = new Bulkhead('vendor', { maxConcurrent: 1, maxQueue: 5, queueTimeoutMs: 60_000 });
  await bh.acquire();
  const controller = new AbortController();
  const queued = bh.acquire(controller.signal);
  controller.abort(new Error('caller went away'));
  await assert.rejects(queued, BulkheadTimeoutError);
  assert.equal(bh.stats().queued, 0);
});

test('a slot freed after a waiter gave up still reaches a live waiter', async () => {
  const bh = new Bulkhead('vendor', { maxConcurrent: 1, maxQueue: 5, queueTimeoutMs: 20 });
  await bh.acquire();
  const abandoned = bh.acquire();                    // times out at 20ms
  await assert.rejects(abandoned, BulkheadTimeoutError);

  const live = bh.acquire();                         // joins an empty queue
  bh.release();
  await live;                                        // must not hang behind a corpse
  assert.deepEqual(bh.stats(), { inFlight: 1, queued: 0 });
});

test('the budget ceiling scales with observed throughput', () => {
  const clock = new ManualClock();
  const budget = new RetryBudget({ ratio: 0.25, minTokens: 2, windowMs: 1_000 }, clock);
  assert.equal(budget.ceiling(), 2, 'a quiet service falls back to the floor');

  for (let i = 0; i < 40; i += 1) budget.deposit();
  assert.equal(budget.ceiling(), 10, '40 calls at 25% justifies 10 retries');
  assert.equal(budget.available(), 10, 'the balance cannot exceed what traffic justifies');

  clock.advance(1_001);
  budget.deposit();
  assert.equal(budget.ceiling(), 2, 'traffic ageing out of the window shrinks the cap');
  assert.equal(budget.available(), 2);
});
