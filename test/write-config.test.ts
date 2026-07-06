import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWriteMode, enableWrites, WRITE_DISABLED_MESSAGE } from '../src/repo/write-config.js';
import { gitInit, gitStatus } from '../src/git/git.js';
import { snapshotAndCommit } from '../src/repo/snapshot-commit.js';
import type { PlaylistMeta, TrackRecord } from '../src/spotify/playlists.js';

// Inline fixtures — no Spotify. A trivial snapshot is committed so the tree
// starts clean, which is what makes the "clean git status after enableWrites"
// assertion meaningful: any untracked .spit/ or .gitignore would show up.
const META: PlaylistMeta = {
  id: '37i9dQZF1DXcBWIGoYBM5M',
  name: 'Today’s Top Hits',
  description: 'The hottest tracks.',
  owner: 'Spotify',
};

const TRACKS: TrackRecord[] = [
  { id: 't1', uri: 'spotify:track:t1', name: 'First', artists: ['A'], album: 'AlbumA', duration_ms: 1000 },
];

async function cleanRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'spit-write-config-'));
  await gitInit(dir);
  await snapshotAndCommit(dir, META, TRACKS, 'initial');
  assert.equal((await gitStatus(dir)).trim(), '', 'repo must start clean');
  return dir;
}

// Fail-closed default: a repo with no .spit/ is display-only.
test('readWriteMode is false by default (no config → display-only)', async () => {
  const dir = await cleanRepo();
  try {
    assert.equal(await readWriteMode(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// enableWrites flips the gate AND leaves the tree clean (.spit/ + .gitignore ignored).
test('enableWrites → readWriteMode true, git status still clean', async () => {
  const dir = await cleanRepo();
  try {
    await enableWrites(dir);
    assert.equal(await readWriteMode(dir), true, 'write mode enabled after opt-in');
    assert.equal(
      (await gitStatus(dir)).trim(),
      '',
      'tree clean after enableWrites — .spit/ and .gitignore are ignored',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Q7 negative: a malformed config is fail-closed, not an error.
test('readWriteMode is false for malformed config JSON (fail-closed)', async () => {
  const dir = await cleanRepo();
  try {
    await enableWrites(dir);
    await writeFile(join(dir, '.spit', 'config.json'), '{ not valid json', 'utf8');
    assert.equal(await readWriteMode(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Q7 negative: writeMode explicitly false stays display-only.
test('readWriteMode is false when writeMode is not exactly true', async () => {
  const dir = await cleanRepo();
  try {
    await enableWrites(dir);
    await writeFile(
      join(dir, '.spit', 'config.json'),
      JSON.stringify({ writeMode: false }) + '\n',
      'utf8',
    );
    assert.equal(await readWriteMode(dir), false);
    await writeFile(
      join(dir, '.spit', 'config.json'),
      JSON.stringify({ writeMode: 'true' }) + '\n',
      'utf8',
    );
    assert.equal(await readWriteMode(dir), false, 'string "true" must not open the gate');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Idempotency: a pre-existing .gitignore with unrelated content is not clobbered
// and lines are not duplicated across repeated enableWrites calls.
test('enableWrites is idempotent and preserves unrelated .gitignore content', async () => {
  const dir = await cleanRepo();
  try {
    await writeFile(join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
    await enableWrites(dir);
    await enableWrites(dir);

    const gitignore = await readFile(join(dir, '.gitignore'), 'utf8');
    const lines = gitignore.split('\n').filter((l) => l.trim() !== '');
    assert.ok(lines.includes('node_modules/'), 'unrelated content preserved');
    assert.equal(lines.filter((l) => l === '.spit/').length, 1, '.spit/ appears once');
    assert.equal(lines.filter((l) => l === '.gitignore').length, 1, '.gitignore appears once');
    // node_modules is untracked (not ignored), so it shows — but .spit/ and
    // .gitignore must not, which is the gate's contract.
    const status = await gitStatus(dir);
    assert.ok(!status.includes('.spit/'), '.spit/ is ignored');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('WRITE_DISABLED_MESSAGE is actionable', () => {
  assert.match(WRITE_DISABLED_MESSAGE, /--enable-writes/);
});
