/**
 * Network-agnostic backoff wrapper for Spotify Web API requests (R010, owned by S05).
 *
 * `retryWithBackoff` re-invokes `fn` on HTTP 429 (rate limit) and 5xx (server) responses
 * with exponential backoff, honouring the `Retry-After` header when Spotify sends one.
 * It is pure with respect to the network — `fn` performs the request, and `sleep` is
 * injectable so tests drive it with a fake clock instead of real timers.
 *
 * Termination guarantees: retries are capped at `maxRetries`, so repeated 429/5xx return
 * the last error response rather than looping forever, and delays are bounded by a cap.
 */

export interface RetryOptions {
  /** Maximum number of *retries* after the first attempt (so up to maxRetries+1 calls). */
  maxRetries?: number;
  /** Base delay for the exponential schedule (baseDelayMs * 2^attempt). */
  baseDelayMs?: number;
  /** Upper bound for a 429 delay in ms. */
  capMs?: number;
  /** Injected delay; default sleeps real time. Tests pass a fake that records delays. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS: Required<RetryOptions> = {
  maxRetries: 5,
  baseDelayMs: 1000,
  capMs: 60000,
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
};

/** 5xx backoff is capped tighter than the 429 cap. */
const SERVER_ERROR_CAP_MS = 30000;

/**
 * Parse Spotify's `Retry-After` header (integer seconds) into milliseconds.
 * Returns null when the header is absent or not a clean non-negative integer.
 */
export function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed) * 1000;
}

/**
 * Invoke `fn`, retrying on 429/5xx with backoff until it succeeds, returns a
 * non-retryable response, or exhausts `maxRetries` (then the last response is returned).
 */
export async function retryWithBackoff(
  fn: () => Promise<Response>,
  opts: RetryOptions = {},
): Promise<Response> {
  const { maxRetries, baseDelayMs, capMs, sleep } = { ...DEFAULTS, ...opts };

  let res = await fn();
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (res.status === 429) {
      const retryAfter = parseRetryAfter(res);
      const delay =
        retryAfter ?? Math.min(baseDelayMs * 2 ** attempt, capMs);
      await sleep(delay);
      res = await fn();
      continue;
    }
    if (res.status >= 500) {
      const delay = Math.min(baseDelayMs * 2 ** attempt, SERVER_ERROR_CAP_MS);
      await sleep(delay);
      res = await fn();
      continue;
    }
    return res;
  }
  return res;
}
