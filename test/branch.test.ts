import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoBranch } from '../src/repo/branch.js';
import { snapshotAndCommit } from '../src/repo/snapshot-commit.js';
import { gitInit, gitCheckout } from '../src/git/git.js';
import type { PlaylistMeta, TrackRecord } from '../src/spotify/playlists.js';

// Inline fixtures — no Spotify. A scratch repo is seeded via snapshotAndCommit
// (the same tail init/commit use), then the helper is exercised directly.

const META: PlaylistMeta = {
  id: '37i9dQZF1DXcBWIGoYBM5M',
  name: 'Today’s Top Hits',
  description: 'The hottest tracks.',
  owner: 'Spotify',
};

const TRACKS: TrackRecord[] = [
  { id: 't1', uri: 'spotify:track:t1', name: 'First', artists: ['A'], album: 'AlbumA', duration_ms: 1000 },
  { id: 't2', uri: 'spotify:track:t2', name: 'Second', artists: ['B'], album: 'AlbumB', duration_ms: 2000 },
];

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spit-branch-'));
}

// repoBranch names the created branch and reports the tracked playlist name.
// The branch is real: it must be checkoutable without throwing.
test('repoBranch creates a checkoutable branch and reports playlist name', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, TRACKS, 'first');

    const result = await repoBranch(dir, 'experiment');
    assert.equal(result.branch, 'experiment', 'returns the created branch name');
    assert.equal(result.playlistName, META.name, 'reports the tracked playlist name');

    // The branch exists and points at a real commit ⇒ checkout succeeds.
    await gitCheckout(dir, 'experiment');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Negative surface: a repo with no meta.json is not a spit repo — the helper
// raises the established readable error, never a raw ENOENT.
test('repoBranch rejects a non-spit directory with a readable error', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await assert.rejects(
      () => repoBranch(dir, 'experiment'),
      /No spit snapshot found.*Run `spit init/s,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Negative surface: a duplicate branch name exits git non-zero — the failure
// bubbles as a GitError carrying git's stderr, not a swallowed success.
test('repoBranch surfaces a duplicate-branch failure as a GitError', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, TRACKS, 'first');
    await repoBranch(dir, 'experiment');
    await assert.rejects(() => repoBranch(dir, 'experiment'), /already exists/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
