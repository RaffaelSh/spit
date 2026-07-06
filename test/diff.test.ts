import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitInit, GitError } from '../src/git/git.js';
import { snapshotAndCommit } from '../src/repo/snapshot-commit.js';
import { repoDiff } from '../src/repo/diff.js';
import type { PlaylistMeta, TrackRecord } from '../src/spotify/playlists.js';

// Inline fixtures — no Spotify. Real repos are built with snapshotAndCommit so
// repoDiff reads git's own object store via gitShow.

const META: PlaylistMeta = {
  id: '37i9dQZF1DXcBWIGoYBM5M',
  name: 'Today’s Top Hits',
  description: 'The hottest tracks.',
  owner: 'Spotify',
};

const T1: TrackRecord = { id: 't1', uri: 'spotify:track:t1', name: 'First', artists: ['A'], album: 'AlbumA', duration_ms: 1000 };
const T2: TrackRecord = { id: 't2', uri: 'spotify:track:t2', name: 'Second', artists: ['B', 'C'], album: 'AlbumB', duration_ms: 2000 };
const T3: TrackRecord = { id: 't3', uri: 'spotify:track:t3', name: 'Third', artists: ['D'], album: 'AlbumC', duration_ms: 3000 };
const T4: TrackRecord = { id: 't4', uri: 'spotify:track:t4', name: 'Fourth', artists: ['E'], album: 'AlbumD', duration_ms: 4000 };

const TRACKS_A: TrackRecord[] = [T1, T2, T3];
// B = A reordered (t2 before t1) + one added (t4) + one removed (t3).
const TRACKS_B: TrackRecord[] = [T2, T1, T4];

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spit-diff-'));
}

const ids = (tracks: TrackRecord[]): string[] => tracks.map((t) => t.id ?? '(null)').sort();

test('repoDiff reports added/removed/moved between two snapshots', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, TRACKS_A, 'A');
    await snapshotAndCommit(dir, META, TRACKS_B, 'B');

    const res = await repoDiff(dir, 'HEAD~1', 'HEAD');
    assert.deepEqual(ids(res.added), ['t4'], 't4 added');
    assert.deepEqual(ids(res.removed), ['t3'], 't3 removed');
    assert.equal(res.metaOnly, false);

    const movedById = new Map(res.moved.map((m) => [m.track.id, m]));
    assert.equal(res.moved.length, 2, 't1 and t2 both moved');
    assert.deepEqual({ from: movedById.get('t1')!.fromIndex, to: movedById.get('t1')!.toIndex }, { from: 0, to: 1 });
    assert.deepEqual({ from: movedById.get('t2')!.fromIndex, to: movedById.get('t2')!.toIndex }, { from: 1, to: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('empty → non-empty playlist reports all tracks as added', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, [], 'empty');
    await snapshotAndCommit(dir, META, TRACKS_A, 'filled');

    const res = await repoDiff(dir); // defaults HEAD~1..HEAD
    assert.deepEqual(ids(res.added), ['t1', 't2', 't3']);
    assert.deepEqual(res.removed, []);
    assert.deepEqual(res.moved, []);
    assert.equal(res.metaOnly, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a metadata-only change yields metaOnly with no track diff', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, TRACKS_A, 'A');
    const renamed: PlaylistMeta = { ...META, name: 'Yesterday’s Top Hits' };
    await snapshotAndCommit(dir, renamed, TRACKS_A, 'renamed');

    const res = await repoDiff(dir, 'HEAD~1', 'HEAD');
    assert.equal(res.metaOnly, true, 'renamed meta.json is a track no-op');
    assert.deepEqual(res.added, []);
    assert.deepEqual(res.removed, []);
    assert.deepEqual(res.moved, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('duplicate identical track lines are counted by multiset without crashing', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, [T1, T1], 'two');
    await snapshotAndCommit(dir, META, [T1, T1, T1], 'three');

    const res = await repoDiff(dir, 'HEAD~1', 'HEAD');
    // Two paired occurrences at the same positions; the third is a fresh add.
    assert.deepEqual(ids(res.added), ['t1']);
    assert.deepEqual(res.removed, []);
    assert.deepEqual(res.moved, []);
    assert.equal(res.metaOnly, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an invalid revision rejects with a GitError', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, TRACKS_A, 'A');

    await assert.rejects(
      () => repoDiff(dir, 'no-such-rev', 'HEAD'),
      (err: unknown) => err instanceof GitError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
