import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryWithBackoff, parseRetryAfter } from '../src/spotify/retry.js';

/** Build a Response-like object with a status and optional Retry-After header. */
function response(status: number, retryAfter?: string): Response {
  const headers = retryAfter === undefined ? undefined : { 'Retry-After': retryAfter };
  return new Response(null, { status, headers });
}

/**
 * Script a sequence of statuses into an `fn` and a `sleep` that records each delay.
 * The fake sleep never touches real timers, so the test runs on a fake clock.
 */
function harness(statuses: Array<{ status: number; retryAfter?: string }>) {
  const delays: number[] = [];
  let i = 0;
  const fn = () => {
    const spec = statuses[Math.min(i, statuses.length - 1)];
    i++;
    return Promise.resolve(response(spec.status, spec.retryAfter));
  };
  const sleep = (ms: number) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { fn, sleep, delays, calls: () => i };
}

test('a 200 returns immediately with zero recorded delays', async () => {
  const { fn, sleep, delays } = harness([{ status: 200 }]);
  const res = await retryWithBackoff(fn, { sleep });
  assert.equal(res.status, 200);
  assert.deepEqual(delays, []);
});

test('a 429 with Retry-After: 2 delays 2000ms then returns the following 200', async () => {
  const { fn, sleep, delays } = harness([
    { status: 429, retryAfter: '2' },
    { status: 200 },
  ]);
  const res = await retryWithBackoff(fn, { sleep, baseDelayMs: 1000 });
  assert.equal(res.status, 200);
  assert.deepEqual(delays, [2000]);
});

test('repeated 429s back off exponentially and stop after maxRetries, returning a 429', async () => {
  const { fn, sleep, delays, calls } = harness([{ status: 429 }]); // always 429
  const res = await retryWithBackoff(fn, { sleep, maxRetries: 4, baseDelayMs: 1000, capMs: 60000 });
  assert.equal(res.status, 429);
  // 4 retries → 4 delays, exponential: 1000, 2000, 4000, 8000.
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  // Strictly increasing.
  for (let k = 1; k < delays.length; k++) {
    assert.ok(delays[k] > delays[k - 1], `delay ${delays[k]} should exceed ${delays[k - 1]}`);
  }
  // First attempt + 4 retries = 5 total calls; no infinite loop.
  assert.equal(calls(), 5);
});

test('a 500 then 200 records exactly one backoff delay', async () => {
  const { fn, sleep, delays } = harness([{ status: 500 }, { status: 200 }]);
  const res = await retryWithBackoff(fn, { sleep, baseDelayMs: 1000 });
  assert.equal(res.status, 200);
  assert.deepEqual(delays, [1000]);
});

test('parseRetryAfter reads integer seconds and rejects absent/non-numeric headers', () => {
  assert.equal(parseRetryAfter(response(429, '3')), 3000);
  assert.equal(parseRetryAfter(response(429)), null);
  assert.equal(parseRetryAfter(response(429, 'soon')), null);
});
