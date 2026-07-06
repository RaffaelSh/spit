import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRevert } from '../src/repo/revert.js';
import { snapshotAndCommit } from '../src/repo/snapshot-commit.js';
import { gitInit, gitLog } from '../src/git/git.js';
import type { PlaylistMeta, TrackRecord } from '../src/spotify/playlists.js';

// Inline fixtures — no Spotify. A and B differ in LENGTH (3 vs 2) so trackCount
// alone proves the working tree returned to the A state after reverting B.

const META: PlaylistMeta = {
  id: '37i9dQZF1DXcBWIGoYBM5M',
  name: 'Today’s Top Hits',
  description: 'The hottest tracks.',
  owner: 'Spotify',
};

const TRACKS_A: TrackRecord[] = [
  { id: 't1', uri: 'spotify:track:t1', name: 'First', artists: ['A'], album: 'AlbumA', duration_ms: 1000 },
  { id: 't2', uri: 'spotify:track:t2', name: 'Second', artists: ['B'], album: 'AlbumB', duration_ms: 2000 },
  { id: 't3', uri: 'spotify:track:t3', name: 'Third', artists: ['C'], album: 'AlbumC', duration_ms: 3000 },
];

const TRACKS_B: TrackRecord[] = [
  { id: 't1', uri: 'spotify:track:t1', name: 'First', artists: ['A'], album: 'AlbumA', duration_ms: 1000 },
  { id: 't2', uri: 'spotify:track:t2', name: 'Second', artists: ['B'], album: 'AlbumB', duration_ms: 2000 },
];

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spit-revert-'));
}

function lineCount(log: string): number {
  return log.split('\n').filter((l) => l.length > 0).length;
}

// Revert HEAD (commit B): git writes an inverse commit AND restores the A-state
// files. History grows by one; the working tree returns to snapshot A.
test('repoRevert creates an inverse commit and restores the prior snapshot', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, TRACKS_A, 'A');
    await snapshotAndCommit(dir, META, TRACKS_B, 'B');
    assert.equal(lineCount(await gitLog(dir)), 2, 'two commits before revert');

    const result = await repoRevert(dir, 'HEAD');
    assert.equal(lineCount(await gitLog(dir)), 3, 'revert adds a new (inverse) commit');
    assert.equal(result.trackCount, TRACKS_A.length, 'working tree returned to snapshot A');
    assert.equal(result.playlistName, META.name, 'reports the restored playlist name');
    assert.ok(result.commit.length > 0, 'reports the new short commit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Negative surface: no meta.json ⇒ the established readable error, not ENOENT.
test('repoRevert rejects a non-spit directory with a readable error', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await assert.rejects(
      () => repoRevert(dir, 'HEAD'),
      /No spit snapshot found.*Run `spit init/s,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Negative surface: an unknown ref exits git non-zero ⇒ GitError.
test('repoRevert surfaces an invalid ref as a GitError', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, TRACKS_A, 'A');
    await assert.rejects(() => repoRevert(dir, 'no-such-ref'), /git revert/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
