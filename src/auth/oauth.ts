import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { URL } from 'node:url';
import { generateVerifier, challengeFromVerifier, generateState } from './pkce.js';

export const AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';
export const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
export const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
export const CALLBACK_PORT = 8888;
export const SCOPES = 'playlist-read-private playlist-read-collaborative';

/** Shape returned by Spotify's token endpoint (fields we consume). */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/** Read the Spotify client id from the environment, or throw an actionable error. */
export function requireClientId(): string {
  const id = process.env.SPOTIFY_CLIENT_ID;
  if (!id || id.trim() === '') {
    throw new Error(
      'SPOTIFY_CLIENT_ID is not set. Export your Spotify app client id, e.g.\n' +
        '  export SPOTIFY_CLIENT_ID=<your-app-client-id>\n' +
        'and ensure the redirect URI http://127.0.0.1:8888/callback is registered on the app.',
    );
  }
  return id;
}

/** Build the fully-qualified /authorize URL for the PKCE flow. */
export function buildAuthorizeUrl(clientId: string, challenge: string, state: string): string {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
    state,
  }).toString();
  return url.toString();
}

/** Best-effort open of a URL in the user's browser; never throws. */
function openInBrowser(url: string): void {
  const cmd = platform() === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* fallback is the printed URL */
    });
    child.unref();
  } catch {
    /* fallback is the printed URL */
  }
}

/**
 * Exchange an authorization code for tokens (PKCE — no client secret).
 * Surfaces INVALID_CLIENT hints toward the loopback redirect-URI pitfall.
 */
async function exchangeCode(
  clientId: string,
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      detail = parsed.error_description || parsed.error || text;
      if (parsed.error === 'invalid_client') {
        detail +=
          '\nCheck the redirect URI is exactly http://127.0.0.1:8888/callback (127.0.0.1, not localhost).';
      }
    } catch {
      /* keep raw text */
    }
    throw new Error(`Token exchange failed (${res.status}): ${detail}`);
  }
  return JSON.parse(text) as TokenResponse;
}

/**
 * Run the full Authorization Code + PKCE flow:
 * open consent URL, capture the loopback callback, verify state, exchange code.
 * Returns the token set; never persists (see token-store).
 */
export function runOAuthFlow(clientId: string): Promise<TokenResponse> {
  const verifier = generateVerifier();
  const challenge = challengeFromVerifier(verifier);
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl(clientId, challenge, state);

  return new Promise<TokenResponse>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, value?: TokenResponse) => {
      if (settled) return;
      settled = true;
      server.close();
      if (err) reject(err);
      else resolve(value!);
    };

    const server = createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400).end('Bad request');
        return;
      }
      const reqUrl = new URL(req.url, REDIRECT_URI);
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      const returnedState = reqUrl.searchParams.get('state');
      const code = reqUrl.searchParams.get('code');
      const oauthError = reqUrl.searchParams.get('error');

      if (oauthError) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Login failed: ${oauthError}`);
        finish(new Error(`Spotify returned an error: ${oauthError}`));
        return;
      }
      if (!returnedState || returnedState !== state) {
        res
          .writeHead(400, { 'Content-Type': 'text/plain' })
          .end('State mismatch — aborting login for your safety.');
        finish(new Error('OAuth state mismatch — possible CSRF; login aborted.'));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Missing authorization code.');
        finish(new Error('No authorization code returned from Spotify.'));
        return;
      }

      exchangeCode(clientId, code, verifier).then(
        (tokens) => {
          res
            .writeHead(200, { 'Content-Type': 'text/plain' })
            .end('spit: login successful — you can close this tab and return to the terminal.');
          finish(null, tokens);
        },
        (err: Error) => {
          res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Token exchange failed.');
          finish(err);
        },
      );
    });

    server.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      console.log('Opening Spotify consent in your browser…');
      console.log(`If it does not open automatically, visit:\n  ${authorizeUrl}\n`);
      openInBrowser(authorizeUrl);
    });
  });
}
