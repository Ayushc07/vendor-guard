import type { Classifier, Verdict } from './types.ts';

/** Anything shaped like an HTTP error with a status code. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as Record<string, unknown>;
  const raw = e['status'] ?? e['statusCode'] ?? (e['response'] as Record<string, unknown> | undefined)?.['status'];
  return typeof raw === 'number' ? raw : undefined;
}

const TRANSIENT_NETWORK = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'EPIPE', 'ENOTFOUND', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'ABORT_ERR',
]);

/**
 * The default reading of a vendor response.
 *
 * 5xx, 408, 425, 429 and transport errors are the vendor's fault: they count.
 * Every other 4xx is the vendor telling us something true about our request,
 * so it is reported to the caller but ignored by the breaker and never retried.
 */
export const defaultClassifier: Classifier = {
  onError(error: unknown): Verdict {
    const status = statusOf(error);
    if (status !== undefined) {
      if (status >= 500) return 'failure';
      if (status === 408 || status === 425 || status === 429) return 'failure';
      if (status >= 400) return 'ignore';
      return 'success';
    }
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && TRANSIENT_NETWORK.has(code)) return 'failure';
    // An unrecognised throw is a fault until proven otherwise.
    return 'failure';
  },
};

/** Reads a `Retry-After` hint (seconds, or an HTTP date) if the vendor sent one. */
export function retryAfterMs(error: unknown, now: number): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as Record<string, unknown>;
  const headers = (e['headers'] ?? (e['response'] as Record<string, unknown> | undefined)?.['headers']) as
    | Record<string, unknown>
    | undefined;
  const raw = e['retryAfter'] ?? headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number') return Math.max(0, raw * 1000);
  if (typeof raw === 'string') {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  return undefined;
}
