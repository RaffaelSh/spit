import { getAccessToken } from '../auth/token-store.js';

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
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
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
