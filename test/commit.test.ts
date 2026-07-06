import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotAndCommit } from '../src/repo/snapshot-commit.js';
import { gitInit, gitLog, gitStatus } from '../src/git/git.js';
import type { PlaylistMeta, TrackRecord } from '../src/spotify/playlists.js';

// Inline fixtures — no Spotify. snapshotAndCommit is exercised directly by
// injecting PlaylistMeta + TrackRecord[], exactly as serialize.test.ts and
// git.test.ts inject data. Determinism of serialize (proven in
// serialize.test.ts) is what makes the no-op assertion sound: identical input ⇒
// byte-identical snapshot ⇒ empty staged diff ⇒ no new revision.

const META: PlaylistMeta = {
  id: '37i9dQZF1DXcBWIGoYBM5M',
  name: 'Today’s Top Hits',
  description: 'The hottest tracks.',
  owner: 'Spotify',
};

const TRACKS_A: TrackRecord[] = [
  { id: 't1', uri: 'spotify:track:t1', name: 'First', artists: ['A'], album: 'AlbumA', duration_ms: 1000 },
  { id: 't2', uri: 'spotify:track:t2', name: 'Second', artists: ['B', 'C'], album: 'AlbumB', duration_ms: 2000 },
  { id: 't3', uri: 'spotify:track:t3', name: 'Third', artists: ['D'], album: 'AlbumC', duration_ms: 3000 },
];

// tracksB = tracksA reordered (t2 before t1) + one added (t4) + one removed (t3).
const TRACKS_B: TrackRecord[] = [
  { id: 't2', uri: 'spotify:track:t2', name: 'Second', artists: ['B', 'C'], album: 'AlbumB', duration_ms: 2000 },
  { id: 't1', uri: 'spotify:track:t1', name: 'First', artists: ['A'], album: 'AlbumA', duration_ms: 1000 },
  { id: 't4', uri: 'spotify:track:t4', name: 'Fourth', artists: ['E'], album: 'AlbumD', duration_ms: 4000 },
];

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spit-commit-'));
}

function lineCount(log: string): number {
  return log.split('\n').filter((l) => l.length > 0).length;
}

// No-op path: a second snapshot of an IDENTICAL playlist must not create a
// revision. changed:false, one commit total, clean tree.
test('identical snapshot is a clean no-op — no second revision', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);

    const first = await snapshotAndCommit(dir, META, TRACKS_A, 'first');
    assert.equal(first.changed, true, 'first snapshot must commit');

    const second = await snapshotAndCommit(dir, META, TRACKS_A, 'second');
    assert.equal(second.changed, false, 'identical snapshot must be a no-op');

    assert.equal(lineCount(await gitLog(dir)), 1, 'exactly one commit after no-op');
    assert.equal((await gitStatus(dir)).trim(), '', 'tree clean after no-op');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Change path: reorder + add + remove yields a real diff, so a clean second
// revision is created. changed:true, two commits, clean tree afterwards.
test('a changed playlist produces a clean second revision', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);

    await snapshotAndCommit(dir, META, TRACKS_A, 'first');
    const second = await snapshotAndCommit(dir, META, TRACKS_B, 'second');
    assert.equal(second.changed, true, 'a real change must commit');

    assert.equal(lineCount(await gitLog(dir)), 2, 'exactly two commits after a change');
    assert.equal((await gitStatus(dir)).trim(), '', 'tree clean after the second revision');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// meta.json is part of the versioned snapshot: a metadata-only change (same
// tracks, renamed playlist) is still a real revision.
test('a meta-only change (renamed playlist) still commits', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);

    await snapshotAndCommit(dir, META, TRACKS_A, 'first');
    const renamed: PlaylistMeta = { ...META, name: 'Yesterday’s Top Hits' };
    const second = await snapshotAndCommit(dir, renamed, TRACKS_A, 'second');
    assert.equal(second.changed, true, 'meta.json change must commit');

    assert.equal(lineCount(await gitLog(dir)), 2, 'meta-only change creates a revision');
    assert.equal((await gitStatus(dir)).trim(), '', 'tree clean after meta change');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
