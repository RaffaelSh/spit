import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSpotifyError, ExitCode } from '../src/spotify/errors.js';
import { SpotifyApiError, SpotifyNetworkError } from '../src/spotify/client.js';
import { ReauthRequiredError } from '../src/auth/token-store.js';

test('401 → AUTH exit code with a re-login instruction', () => {
  const d = describeSpotifyError(new SpotifyApiError(401, 'raw'));
  assert.equal(d.exitCode, ExitCode.AUTH);
  assert.match(d.message, /spit login/);
});

test('403 → FORBIDDEN exit code naming scopes / dev mode / ownership', () => {
  const d = describeSpotifyError(new SpotifyApiError(403, 'raw'));
  assert.equal(d.exitCode, ExitCode.FORBIDDEN);
  assert.match(d.message, /scope|development mode|owner/i);
});

test('404 → NOT_FOUND exit code pointing at the playlist id/URL', () => {
  const d = describeSpotifyError(new SpotifyApiError(404, 'raw'));
  assert.equal(d.exitCode, ExitCode.NOT_FOUND);
  assert.match(d.message, /playlist id|URL/i);
});

test('429 → RATE_LIMIT exit code', () => {
  const d = describeSpotifyError(new SpotifyApiError(429, 'raw'));
  assert.equal(d.exitCode, ExitCode.RATE_LIMIT);
  assert.match(d.message, /rate limit/i);
});

test('5xx → general exit code, flagged as transient', () => {
  const d = describeSpotifyError(new SpotifyApiError(503, 'raw'));
  assert.equal(d.exitCode, ExitCode.GENERAL);
  assert.match(d.message, /server error|transient/i);
});

test('network throw → NETWORK exit code with a connectivity hint', () => {
  const d = describeSpotifyError(new SpotifyNetworkError('could not reach Spotify (ENOTFOUND)'));
  assert.equal(d.exitCode, ExitCode.NETWORK);
  assert.match(d.message, /internet connection/i);
  assert.match(d.message, /ENOTFOUND/);
});

test('ReauthRequiredError → AUTH exit code, preserves its message', () => {
  const d = describeSpotifyError(new ReauthRequiredError('Not logged in. Run `spit login` first.'));
  assert.equal(d.exitCode, ExitCode.AUTH);
  assert.match(d.message, /spit login/);
});

test('unknown error → general exit code, message preserved (never swallowed)', () => {
  const d = describeSpotifyError(new Error('some git failure'));
  assert.equal(d.exitCode, ExitCode.GENERAL);
  assert.equal(d.message, 'some git failure');
});

test('the four Spotify status classes map to four distinct exit codes', () => {
  const codes = [401, 403, 404, 429].map((s) => describeSpotifyError(new SpotifyApiError(s, '')).exitCode);
  assert.equal(new Set(codes).size, 4);
});
