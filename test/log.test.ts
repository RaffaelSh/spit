import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitInit } from '../src/git/git.js';
import { snapshotAndCommit } from '../src/repo/snapshot-commit.js';
import { repoLog } from '../src/repo/log.js';
import type { PlaylistMeta, TrackRecord } from '../src/spotify/playlists.js';

// Inline fixtures — no Spotify. A real 2-commit repo is built with
// snapshotAndCommit, then repoLog is asserted to read git's own history.

const META: PlaylistMeta = {
  id: '37i9dQZF1DXcBWIGoYBM5M',
  name: 'Today’s Top Hits',
  description: 'The hottest tracks.',
  owner: 'Spotify',
};

const TRACKS_A: TrackRecord[] = [
  { id: 't1', uri: 'spotify:track:t1', name: 'First', artists: ['A'], album: 'AlbumA', duration_ms: 1000 },
  { id: 't2', uri: 'spotify:track:t2', name: 'Second', artists: ['B'], album: 'AlbumB', duration_ms: 2000 },
];

const TRACKS_B: TrackRecord[] = [
  { id: 't2', uri: 'spotify:track:t2', name: 'Second', artists: ['B'], album: 'AlbumB', duration_ms: 2000 },
  { id: 't1', uri: 'spotify:track:t1', name: 'First', artists: ['A'], album: 'AlbumA', duration_ms: 1000 },
  { id: 't3', uri: 'spotify:track:t3', name: 'Third', artists: ['C'], album: 'AlbumC', duration_ms: 3000 },
];

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spit-log-'));
}

test('repoLog returns entries most-recent-first with committed messages', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, TRACKS_A, 'first snapshot');
    await snapshotAndCommit(dir, META, TRACKS_B, 'second snapshot');

    const { entries } = await repoLog(dir);
    assert.equal(entries.length, 2, 'two commits => two entries');
    // git log --oneline is most-recent-first.
    assert.equal(entries[0].message, 'second snapshot');
    assert.equal(entries[1].message, 'first snapshot');
    // Each entry carries a non-empty short hash.
    for (const e of entries) {
      assert.ok(e.hash.length > 0, 'entry has a hash');
      assert.ok(!e.hash.includes(' '), 'hash has no embedded space');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a single-commit repo yields exactly one entry', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, TRACKS_A, 'only snapshot');

    const { entries } = await repoLog(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message, 'only snapshot');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
