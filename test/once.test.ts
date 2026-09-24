import test from 'node:test';
import assert from 'node:assert/strict';
import { guard } from '../src/guard.ts';
import { IndeterminateError } from '../src/types.ts';
import { ManualClock, httpError, networkError } from './helpers.ts';

const fixedRandom = () => 0;

test('a non-replayable call is never attempted twice', async () => {
  const clock = new ManualClock();
  const g = guard({ name: 'disbursal', clock, retry: { maxAttempts: 5, random: fixedRandom } });
  let calls = 0;
  await assert.rejects(
    g.executeOnce(async () => { calls += 1; throw networkError('ETIMEDOUT'); }),
    IndeterminateError,
  );
  assert.equal(calls, 1, 'money must never move twice because of a retry');
});

test('a timeout is resolved by asking the vendor what happened', async () => {
  const clock = new ManualClock();
  const g = guard({ name: 'disbursal', clock, retry: { random: fixedRandom } });
  const result = await g.executeOnce(
    async () => { throw networkError('ETIMEDOUT'); },
    { confirm: async () => ({ reference: 'DISB-1', status: 'SETTLED' }) },
  );
  assert.deepEqual(result, { reference: 'DISB-1', status: 'SETTLED' });
});

test('confirmation proving it did not happen surfaces the original failure', async () => {
  const clock = new ManualClock();
  const g = guard({ name: 'disbursal', clock, retry: { random: fixedRandom } });
  await assert.rejects(
    g.executeOnce(
      async () => { throw networkError('ETIMEDOUT'); },
      { confirm: async () => undefined },
    ),
    /ETIMEDOUT/,
  );
});

test('an unresolvable outcome is raised as indeterminate, not as failure', async () => {
  const clock = new ManualClock();
  const g = guard({ name: 'disbursal', clock, retry: { random: fixedRandom } });
  let confirmCalls = 0;
  await assert.rejects(
    g.executeOnce(
      async () => { throw networkError('ETIMEDOUT'); },
      { confirm: async () => { confirmCalls += 1; throw httpError(503); }, confirmAttempts: 3 },
    ),
    IndeterminateError,
  );
  assert.equal(confirmCalls, 3, 'the status lookup is a read, so it may be repeated');
});

test('a rejected business error passes straight through without confirmation', async () => {
  const clock = new ManualClock();
  const g = guard({ name: 'disbursal', clock });
  let confirmCalls = 0;
  await assert.rejects(
    g.executeOnce(
      async () => { throw httpError(422); },
      { confirm: async () => { confirmCalls += 1; return { ok: true }; } },
    ),
    /HTTP 422/,
  );
  assert.equal(confirmCalls, 0, '422 proves it did not happen; nothing to confirm');
});

test('a confirmation that rethrows the original failure is not read as proof', async () => {
  const clock = new ManualClock();
  const g = guard({ name: 'disbursal', clock, retry: { random: fixedRandom } });
  const failure = networkError('ETIMEDOUT');
  let confirmCalls = 0;
  await assert.rejects(
    g.executeOnce(
      async () => { throw failure; },
      { confirm: async () => { confirmCalls += 1; throw failure; }, confirmAttempts: 2 },
    ),
    IndeterminateError,
  );
  assert.equal(confirmCalls, 2, 'a failing lookup is retried, not mistaken for a denial');
});
