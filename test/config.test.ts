import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveClientId,
  persistClientId,
  readConfig,
  configPath,
} from '../src/auth/config.js';
import { requireClientId } from '../src/auth/oauth.js';

/**
 * Point HOME at a fresh temp dir and clear the env var so every case starts from
 * a known-empty global config. homedir() follows HOME on posix, and config.ts
 * resolves its paths at call time, so this fully isolates ~/.spit per test.
 */
async function isolate(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'spit-cfg-'));
  process.env.HOME = home;
  delete process.env.SPOTIFY_CLIENT_ID;
  return home;
}

const ORIG_HOME = process.env.HOME;
const ORIG_ID = process.env.SPOTIFY_CLIENT_ID;
afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_ID === undefined) delete process.env.SPOTIFY_CLIENT_ID;
  else process.env.SPOTIFY_CLIENT_ID = ORIG_ID;
});

test('resolveClientId returns null when neither env nor config is set', async () => {
  await isolate();
  assert.equal(resolveClientId(), null);
});

test('persistClientId writes the id and resolveClientId reads it back', async () => {
  await isolate();
  persistClientId('abc123clientid');
  assert.equal(resolveClientId(), 'abc123clientid');
  assert.equal(readConfig().clientId, 'abc123clientid');
});

test('persisted config file is created 0600', async () => {
  await isolate();
  persistClientId('abc123clientid');
  const mode = (await stat(configPath())).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('SPOTIFY_CLIENT_ID env var wins over the persisted config', async () => {
  await isolate();
  persistClientId('from-config');
  process.env.SPOTIFY_CLIENT_ID = 'from-env';
  assert.equal(resolveClientId(), 'from-env');
});

test('env value is trimmed and blank env falls back to config', async () => {
  await isolate();
  persistClientId('from-config');
  process.env.SPOTIFY_CLIENT_ID = '   ';
  assert.equal(resolveClientId(), 'from-config');
});

test('persistClientId merges rather than clobbering other keys (writeMode survives)', async () => {
  const home = await isolate();
  await mkdir(join(home, '.spit'), { recursive: true });
  await writeFile(join(home, '.spit', 'config.json'), JSON.stringify({ writeMode: true }), 'utf8');
  persistClientId('later-id');
  const parsed = JSON.parse(await readFile(configPath(), 'utf8')) as Record<string, unknown>;
  assert.equal(parsed.writeMode, true);
  assert.equal(parsed.clientId, 'later-id');
});

test('requireClientId throws an actionable error naming both ways to set it', async () => {
  await isolate();
  assert.throws(
    () => requireClientId(),
    (err: Error) =>
      /set-client-id/.test(err.message) && /SPOTIFY_CLIENT_ID/.test(err.message),
  );
});

test('requireClientId returns the resolved id once persisted', async () => {
  await isolate();
  persistClientId('resolved-ok');
  assert.equal(requireClientId(), 'resolved-ok');
});
