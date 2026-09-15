# vendor-guard

Resilience primitives for calling flaky third-party APIs — circuit breaking, retry with a budget, and bulkheads — built around one distinction most libraries leave to the caller:

**some calls you may replay, and some you may not.**

A credit-bureau pull is a read: if it times out, ask again. A disbursal is not: if it times out, you do not know whether the money moved, and asking again is how it moves twice. `vendor-guard` makes that a type-level decision rather than a comment in the code.

Zero runtime dependencies. TypeScript. Node 22+.

```ts
import { guard } from 'vendor-guard';

const bureau = guard({ name: 'cibil', retry: { maxAttempts: 3 } });
const report = await bureau.execute(() => fetchReport(pan));       // replayed on failure

const rail = guard({ name: 'payment-rail', retry: { maxAttempts: 1 } });
const payout = await rail.executeOnce(() => disburse(ref), {       // never replayed
  confirm: () => getPayoutStatus(ref),                             // asked, instead
});
```

---

## Why this exists

I maintain an integration layer across 15+ third-party financial providers. Nearly every resilience bug I have seen there came from one of four places, and this library is the four fixes written down.

### 1. A business answer is not a failure

The most common way to take a healthy vendor offline is to count `404 no record found for this PAN` as a fault. Send a batch of genuinely invalid applicants, and the breaker opens for everybody.

`vendor-guard` classifies every outcome as `success`, `failure`, or **`ignore`**. `5xx`, `408`, `425`, `429` and transport errors are the vendor's fault and count. Every other `4xx` is the vendor telling you something true about your request: it is returned to the caller, never retried, and invisible to the breaker.

```ts
await g.execute(async () => { throw httpError(404); });
// → throws immediately, one attempt, breaker untouched
```

### 2. Retries alone amplify an outage

Exponential backoff with full jitter is necessary but not sufficient. During a partial outage every caller retries, and the extra load is precisely what turns it into a total one.

So retries are drawn from a **budget** — a token bucket earning `ratio` per call (default 10%), whose balance is capped at the retries the traffic actually observed over the last window can justify. One call earns one deposit, so retries are funded by real traffic and never by other retries. When the budget is spent, the call fails with `RetryBudgetExhaustedError` instead of adding to the pile. This is the piece most retry implementations omit.

### 3. Slow is worse than down

Down fails fast. Slow holds your workers. The breaker therefore trips on **two** independent conditions — a failure rate *and* a slow-call rate over the same rolling window — and a **bulkhead** bounds concurrency per vendor so one slow provider cannot consume every connection the service has.

### 4. A timeout is not a failure — it is an unknown

This is the one that matters when money is involved.

`executeOnce` never retries. If the call fails in a way that does not prove it did not happen, it calls your `confirm` lookup — a read, so that one *may* be repeated — and:

| what `confirm` returns | result |
|---|---|
| the real value | returned to the caller; the operation did happen |
| `undefined` | the original error is thrown; it provably did not happen |
| keeps failing | **`IndeterminateError`** |

`IndeterminateError` is deliberately its own type. It is not a failure and must not be handled as one: the application sits in an explicit pending state, ops are alerted, and a reconciliation sweep settles it. Code that treats "unknown" and "failed" as the same thing is how money moves twice.

---

## Design notes

**The breaker opens on a rate, not a streak.** A consecutive-failure counter trips on three unlucky calls at 3am. A rate over a rolling window is honest — provided you also require a `minimumThroughput`, or a rate computed from two samples does exactly the same thing.

**Half-open admits a bounded number of probes.** One failed probe reopens the circuit immediately; a full set of successes closes it.

**The clock is injectable.** Every timing test in the suite runs against a `ManualClock`, so the whole suite finishes in ~115ms with no fake timers and no flakiness.

**The bulkhead queue is bounded in time, not just in length.** A waiter with no deadline is held exactly as long as the vendor is slow, which is the failure the bulkhead was added to prevent. Callers give up after `queueTimeoutMs` with a `BulkheadTimeoutError`, and `acquire` accepts an `AbortSignal` so a caller can withdraw earlier.

**Full jitter can pick zero.** `random() * ceiling`, not `ceiling/2 + random()*ceiling/2`. Decorrelating retries is the entire point; a jitter that guarantees a minimum delay is just a slower thundering herd.

---

## API

```ts
guard({
  name: 'cibil',
  breaker:  { failureRateThreshold: 0.5, slowCallRateThreshold: 0.5, slowCallMs: 2_000,
              minimumThroughput: 20, windowMs: 30_000, openStateMs: 30_000, halfOpenProbes: 3 },
  retry:    { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 2_000 },
  budget:   { ratio: 0.1, minTokens: 10, windowMs: 10_000 },
  bulkhead: { maxConcurrent: 20, maxQueue: 50, queueTimeoutMs: 10_000 },
  classifier,   // override how outcomes are read
  clock,        // override for tests
});
```

| method | use for |
|---|---|
| `execute(fn)` | idempotent operations — reads, lookups, status checks |
| `executeOnce(fn, { confirm })` | operations that must happen at most once |
| `state()` | `'closed'` \| `'open'` \| `'half-open'` |

Errors: `CircuitOpenError`, `BulkheadFullError`, `BulkheadTimeoutError`, `RetryBudgetExhaustedError`, `IndeterminateError`.

The building blocks — `CircuitBreaker`, `Bulkhead`, `RetryBudget` — are exported individually if you want to compose them yourself.

---

## Running it

```bash
npm test        # 30 tests, no build step — Node strips the types
npm run build   # tsc to dist/
node --experimental-strip-types examples/lending.ts
```

## What this is not

Not an HTTP client, and not a service mesh. It wraps a function you already have. If you run on a mesh that already does breaking and retries at the network layer, do it there instead — but note that a mesh cannot tell a disbursal from a bureau pull, which is the distinction this library exists for.

## Licence

MIT
