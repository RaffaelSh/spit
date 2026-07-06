import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotAndCommit } from '../src/repo/snapshot-commit.js';
import { writePulledSnapshot } from '../src/repo/pull.js';
import { gitInit, gitLog, gitStatus } from '../src/git/git.js';
import { deserializePlaylist } from '../src/snapshot/serialize.js';
import type { PlaylistMeta, TrackRecord } from '../src/spotify/playlists.js';

// Inline fixtures — no Spotify. The pull core (writePulledSnapshot) is exercised
// directly by injecting PlaylistMeta + TrackRecord[], exactly as commit.test.ts
// drives snapshotAndCommit. The live getPlaylist/getPlaylistTracks read leg is
// inherently non-automatable (S01 boundary) and is covered by manual UAT.

const META: PlaylistMeta = {
  id: '37i9dQZF1DXcBWIGoYBM5M',
  name: 'Today’s Top Hits',
  description: 'The hottest tracks.',
  owner: 'Spotify',
};

const TRACKS_A: TrackRecord[] = [
  { id: 't1', uri: 'spotify:track:t1', name: 'First', artists: ['A'], album: 'AlbumA', duration_ms: 1000 },
  { id: 't2', uri: 'spotify:track:t2', name: 'Second', artists: ['B', 'C'], album: 'AlbumB', duration_ms: 2000 },
];

// TRACKS_B = TRACKS_A with one added track — a real live change to pull in.
const TRACKS_B: TrackRecord[] = [
  { id: 't1', uri: 'spotify:track:t1', name: 'First', artists: ['A'], album: 'AlbumA', duration_ms: 1000 },
  { id: 't2', uri: 'spotify:track:t2', name: 'Second', artists: ['B', 'C'], album: 'AlbumB', duration_ms: 2000 },
  { id: 't3', uri: 'spotify:track:t3', name: 'Third', artists: ['D'], album: 'AlbumC', duration_ms: 3000 },
];

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spit-pull-'));
}

function lineCount(log: string): number {
  return log.split('\n').filter((l) => l.length > 0).length;
}

// No-op pull: pulling the SAME live state that is already committed leaves the
// working tree clean — changed:false — and never creates a commit.
test('pulling an unchanged playlist is a clean no-op', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, TRACKS_A, 'initial');

    const res = await writePulledSnapshot(dir, META, TRACKS_A);
    assert.equal(res.changed, false, 'identical live state must leave the tree clean');
    assert.equal(res.trackCount, 2);
    assert.equal((await gitStatus(dir)).trim(), '', 'tree clean after a no-op pull');
    assert.equal(lineCount(await gitLog(dir)), 1, 'pull must not create a commit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Change pull: a changed live playlist is written into the working tree
// (changed:true, playlist.jsonl updated) but pull NEVER commits — the log is
// unchanged and the tree is left dirty for `spit commit`.
test('pulling a changed playlist updates the working tree without committing', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await snapshotAndCommit(dir, META, TRACKS_A, 'initial');

    const res = await writePulledSnapshot(dir, META, TRACKS_B);
    assert.equal(res.changed, true, 'a real live change must leave the tree dirty');
    assert.equal(res.trackCount, 3, 'the added track is reflected in the count');

    // The working-tree file now carries the pulled (3-track) state...
    const jsonl = await readFile(join(dir, 'playlist.jsonl'), 'utf8');
    assert.equal(deserializePlaylist(jsonl).length, 3, 'playlist.jsonl reflects the pulled state');

    // ...but pull did not commit: still exactly one revision, tree dirty.
    assert.equal(lineCount(await gitLog(dir)), 1, 'pull must not create a commit');
    assert.notEqual((await gitStatus(dir)).trim(), '', 'tree is left dirty for `spit commit`');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
