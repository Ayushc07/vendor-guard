/**
 * The two call shapes in a lending journey, and why they are not the same.
 *
 *   node --experimental-strip-types examples/lending.ts
 */
import { guard, IndeterminateError } from '../src/index.ts';

// ---------------------------------------------------------------------------
// A credit bureau: a read. Safe to repeat, so retries are the right tool.
// ---------------------------------------------------------------------------
const bureau = guard({
  name: 'cibil',
  breaker: { failureRateThreshold: 0.5, minimumThroughput: 20, openStateMs: 30_000, slowCallMs: 3_000 },
  retry: { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2_000 },
  bulkhead: { maxConcurrent: 10, maxQueue: 50 },
});

async function fetchBureauReport(pan: string) {
  return bureau.execute(async () => {
    const response = await fetch(`https://bureau.example/v1/report/${pan}`);
    if (!response.ok) throw Object.assign(new Error('bureau error'), { status: response.status });
    return response.json();
  });
}

// ---------------------------------------------------------------------------
// A disbursal: money moves. It must happen at most once, so it is never
// retried. A timeout here means "unknown", and the only correct next step is
// to ask the rail what actually happened.
// ---------------------------------------------------------------------------
const rail = guard({
  name: 'payment-rail',
  retry: { maxAttempts: 1 },
  bulkhead: { maxConcurrent: 5, maxQueue: 20 },
});

async function disburse(applicationId: string, amountPaise: number) {
  const idempotencyKey = `disb-${applicationId}`;

  return rail.executeOnce(
    async () => {
      const response = await fetch('https://rail.example/v1/payouts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ applicationId, amountPaise }),
      });
      if (!response.ok) throw Object.assign(new Error('payout failed'), { status: response.status });
      return response.json() as Promise<{ reference: string; status: string }>;
    },
    {
      // Reads, so repeating this one is fine.
      confirmAttempts: 5,
      confirm: async () => {
        const response = await fetch(`https://rail.example/v1/payouts/${idempotencyKey}`);
        if (response.status === 404) return undefined; // provably never happened
        if (!response.ok) throw Object.assign(new Error('enquiry failed'), { status: response.status });
        return response.json() as Promise<{ reference: string; status: string }>;
      },
    },
  );
}

// ---------------------------------------------------------------------------
async function main() {
  try {
    await fetchBureauReport('ABCDE1234F');
  } catch {
    // A bureau outage parks the application; it does not fail the journey.
    console.log('bureau unavailable — application parked for retry');
  }

  try {
    const payout = await disburse('APP-4471', 250_000_00);
    console.log('disbursed', payout.reference);
  } catch (error) {
    if (error instanceof IndeterminateError) {
      // Never retried, never marked failed. A human or the nightly
      // reconciliation sweep decides what happened.
      console.error('DISBURSAL_PENDING_CONFIRMATION — escalated to ops');
    } else {
      console.error('disbursal rejected', error);
    }
  }
}

if (import.meta.filename === process.argv[1]) void main();
