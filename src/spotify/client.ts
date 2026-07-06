import { getAccessToken } from '../auth/token-store.js';
import { retryWithBackoff } from './retry.js';

export const API_BASE = 'https://api.spotify.com/v1';

/** Raised when a Spotify Web API request fails after the 401 refresh+retry seam. */
export class SpotifyApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SpotifyApiError';
    this.status = status;
  }
}

/**
 * Raised when the request never reached Spotify (DNS failure, refused/reset
 * connection, offline). Carries the low-level cause code (ENOTFOUND, …) when the
 * runtime exposes one, so the diagnostic layer can point at connectivity rather
 * than at Spotify. Distinct from SpotifyApiError, which always has an HTTP status.
 */
export class SpotifyNetworkError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SpotifyNetworkError';
    this.cause = cause;
  }
}

/**
 * fetch() that turns a transport-level rejection (no HTTP response was received)
 * into a typed SpotifyNetworkError. An HTTP error status is NOT a rejection —
 * those still resolve and are handled by the status checks downstream.
 */
async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'cause' in err && err.cause
        ? (err.cause as { code?: string }).code
        : undefined;
    const suffix = code ? ` (${code})` : '';
    throw new SpotifyNetworkError(`could not reach Spotify${suffix}`, err);
  }
}

/**
 * GET a Spotify Web API resource and parse JSON.
 *
 * `pathOrUrl` is either an API-relative path (e.g. "/playlists/{id}") or an
 * absolute URL — a pagination `next` link — which is passed through unchanged.
 *
 * On HTTP 401 the access token is force-refreshed exactly once and the request
 * retried exactly once; any remaining error surfaces status + Spotify's error
 * body. 429/backoff is intentionally NOT handled here — that is R010, owned by
 * S05. This function is the single seam S05 later extends.
 */
export async function spotifyGet<T>(pathOrUrl: string): Promise<T> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API_BASE}${pathOrUrl}`;

  let res = await doGet(url, await getAccessToken());
  if (res.status === 401) {
    // Token rejected despite our clock — force one refresh and retry once.
    res = await doGet(url, await getAccessToken(true));
  }

  const text = await res.text();
  if (!res.ok) {
    throw new SpotifyApiError(res.status, formatError(res.status, text));
  }
  return JSON.parse(text) as T;
}

function doGet(url: string, token: string): Promise<Response> {
  return safeFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
}

/**
 * PUT a JSON body to a Spotify Web API resource (e.g. reorder/replace tracks).
 * See {@link doWrite} for the shared 401-refresh + 429/5xx-backoff semantics.
 */
export function spotifyPut<T>(path: string, body: unknown): Promise<T> {
  return writeRequest<T>('PUT', path, body);
}

/**
 * POST a JSON body to a Spotify Web API resource (e.g. add tracks to a playlist).
 * See {@link doWrite} for the shared 401-refresh + 429/5xx-backoff semantics.
 */
export function spotifyPost<T>(path: string, body: unknown): Promise<T> {
  return writeRequest<T>('POST', path, body);
}

/**
 * Shared write path: wraps the 401-refresh-and-retry-once request in
 * retryWithBackoff so 429/5xx are transparently backed off (R010). Non-ok
 * after retries throws SpotifyApiError; an empty 200/201 body returns `{}`.
 */
async function writeRequest<T>(method: 'PUT' | 'POST', path: string, body: unknown): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;

  const res = await retryWithBackoff(() => doWrite(method, url, body));

  const text = await res.text();
  if (!res.ok) {
    throw new SpotifyApiError(res.status, formatError(res.status, text));
  }
  // 201 Created / 200 with an empty body must not crash JSON.parse.
  return text.trim() === '' ? ({} as T) : (JSON.parse(text) as T);
}

/**
 * Perform a single write with a transparent 401→force-refresh→retry-once seam,
 * mirroring spotifyGet. The 401 retry runs at most once; 429/5xx are the caller's
 * (retryWithBackoff) concern and are returned untouched for it to back off.
 */
async function doWrite(method: 'PUT' | 'POST', url: string, body: unknown): Promise<Response> {
  let res = await sendWrite(method, url, await getAccessToken(), body);
  if (res.status === 401) {
    // Token rejected despite our clock — force one refresh and retry once.
    res = await sendWrite(method, url, await getAccessToken(true), body);
  }
  return res;
}

function sendWrite(
  method: 'PUT' | 'POST',
  url: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return safeFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/** Extract Spotify's `error.message` when present; fall back to the raw body. */
function formatError(status: number, body: string): string {
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    if (parsed.error && typeof parsed.error === 'object' && parsed.error.message) {
      detail = parsed.error.message;
    } else if (typeof parsed.error === 'string') {
      detail = parsed.error;
    }
  } catch {
    /* non-JSON body — keep raw text */
  }
  return `Spotify API request failed (${status}): ${detail}`;
}
