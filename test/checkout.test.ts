import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoCheckout } from '../src/repo/checkout.js';
import { snapshotAndCommit } from '../src/repo/snapshot-commit.js';
import { gitInit, gitCurrentBranch } from '../src/git/git.js';
import type { PlaylistMeta, TrackRecord } from '../src/spotify/playlists.js';

// Inline fixtures — no Spotify. A and B differ in LENGTH (3 vs 2) so trackCount
// alone proves which snapshot the working tree was restored to.

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
  return mkdtemp(join(tmpdir(), 'spit-checkout-'));
}

// Checkout a bare commit hash: the working tree is restored to snapshot A and
// HEAD detaches. trackCount + playlistName prove the restored content; detached
// proves the advisory signal the CLI must surface.
test('repoCheckout restores an earlier snapshot and detaches HEAD', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    const a = await snapshotAndCommit(dir, META, TRACKS_A, 'A');
    await snapshotAndCommit(dir, META, TRACKS_B, 'B');

    const result = await repoCheckout(dir, a.commit);
    assert.equal(result.trackCount, TRACKS_A.length, 'restored working tree holds snapshot A');
    assert.equal(result.playlistName, META.name, 'reports the restored playlist name');
    assert.equal(result.commit, a.commit, 'short commit matches the checked-out revision');
    assert.equal(result.detached, true, 'checking out a bare commit detaches HEAD');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Checkout a branch name (not a bare commit): HEAD stays attached ⇒ no advisory.
test('repoCheckout of a branch name does not report detached HEAD', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, TRACKS_A, 'A');

    const branch = await gitCurrentBranch(dir);
    const result = await repoCheckout(dir, branch);
    assert.equal(result.detached, false, 'a branch checkout keeps HEAD attached');
    assert.equal(result.trackCount, TRACKS_A.length, 'working tree unchanged on same-branch checkout');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Negative surface: no meta.json ⇒ the established readable error, not ENOENT.
test('repoCheckout rejects a non-spit directory with a readable error', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await assert.rejects(
      () => repoCheckout(dir, 'HEAD'),
      /No spit snapshot found.*Run `spit init/s,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Negative surface: an unknown ref exits git non-zero ⇒ GitError.
test('repoCheckout surfaces an invalid ref as a GitError', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, TRACKS_A, 'A');
    await assert.rejects(() => repoCheckout(dir, 'no-such-ref'), /git checkout/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
