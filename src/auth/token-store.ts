import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TOKEN_ENDPOINT, requireClientId, type TokenResponse } from './oauth.js';

export const SPIT_DIR = join(homedir(), '.spit');
export const TOKEN_PATH = join(SPIT_DIR, 'token.json');

/** Persisted token shape. `expires_at` is an absolute epoch-ms timestamp. */
export interface StoredToken {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: number;
}

/** Refresh 30s early so a token never expires mid-request. */
const EXPIRY_SKEW_MS = 30_000;

/** Raised when the cached grant is dead and the user must re-run `spit login`. */
export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

/**
 * Persist tokens to ~/.spit/token.json with locked-down perms.
 * Modes are set at creation (dir 0700, file 0600) — never rely on umask.
 */
export async function saveTokens(tokens: TokenResponse): Promise<StoredToken> {
  const stored: StoredToken = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    expires_at: Date.now() + tokens.expires_in * 1000,
  };
  await mkdir(SPIT_DIR, { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_PATH, JSON.stringify(stored, null, 2), { mode: 0o600 });
  return stored;
}

/** Read the cached token, or null if none exists / is unreadable. */
export async function loadTokens(): Promise<StoredToken | null> {
  try {
    const raw = await readFile(TOKEN_PATH, 'utf8');
    return JSON.parse(raw) as StoredToken;
  } catch {
    return null;
  }
}

/** Delete the cached token file (used on invalid_grant). */
export async function discardTokens(): Promise<void> {
  await rm(TOKEN_PATH, { force: true });
}

/**
 * Refresh an access token via grant_type=refresh_token (PKCE — no secret).
 * Keeps the existing refresh_token if Spotify omits a rotated one.
 * On invalid_grant, discards the cache and raises ReauthRequiredError.
 */
async function refresh(stored: StoredToken): Promise<StoredToken> {
  const clientId = requireClientId();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refresh_token,
      client_id: clientId,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    let error = text;
    try {
      error = (JSON.parse(text) as { error?: string }).error || text;
    } catch {
      /* keep raw text */
    }
    if (error === 'invalid_grant') {
      await discardTokens();
      throw new ReauthRequiredError(
        'Your Spotify session expired (invalid_grant). Re-run `spit login`.',
      );
    }
    throw new Error(`Token refresh failed (${res.status}): ${error}`);
  }
  const body = JSON.parse(text) as Partial<TokenResponse>;
  const next: StoredToken = {
    // Spotify may omit refresh_token on refresh — keep the old one rather than clobber.
    refresh_token: body.refresh_token ?? stored.refresh_token,
    access_token: body.access_token!,
    token_type: body.token_type ?? stored.token_type,
    expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  await mkdir(SPIT_DIR, { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/**
 * Return a valid access token, transparently refreshing an expired one.
 * The single token seam consumed by downstream commands (T03+).
 * Pass `forceRefresh` to refresh even when the cached token looks unexpired —
 * used by the API client's 401→refresh→retry path when Spotify rejects a
 * token our clock still considers valid (revocation, clock skew).
 * Throws ReauthRequiredError when no cache exists or the grant is dead.
 */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  const stored = await loadTokens();
  if (!stored) {
    throw new ReauthRequiredError('Not logged in. Run `spit login` first.');
  }
  if (!forceRefresh && Date.now() < stored.expires_at - EXPIRY_SKEW_MS) {
    return stored.access_token;
  }
  const refreshed = await refresh(stored);
  return refreshed.access_token;
}
