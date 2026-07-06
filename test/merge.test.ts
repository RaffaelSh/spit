import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoMerge } from '../src/repo/merge.js';
import { gitInit, gitAdd, gitCommit, gitBranch, gitCheckout, gitCurrentBranch } from '../src/git/git.js';
import type { TrackRecord } from '../src/spotify/playlists.js';

// Inline fixtures — no Spotify. A scratch repo is seeded with a real
// playlist.jsonl + meta.json, then genuine git branch/commit history is built so
// git itself produces (or avoids) a merge conflict. repoMerge is exercised over
// that real history — no conflict markers are hand-fabricated.

const META = { id: 'p1', name: 'Conflict Test', description: 'x' };

function track(id: string, name: string): TrackRecord {
  return {
    id,
    uri: `spotify:track:${id}`,
    name,
    artists: ['A'],
    album: 'Album',
    duration_ms: 1000,
  };
}

const T1 = track('t1', 'One');
const T2 = track('t2', 'Two');
const T3 = track('t3', 'Three');

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spit-merge-'));
}

/** Write playlist.jsonl (one JSON line per track, newline-terminated) + meta.json. */
async function writeSnapshot(dir: string, tracks: TrackRecord[]): Promise<void> {
  const jsonl = tracks.map((t) => JSON.stringify(t) + '\n').join('');
  await writeFile(join(dir, 'playlist.jsonl'), jsonl, 'utf8');
  await writeFile(join(dir, 'meta.json'), JSON.stringify(META, null, 2) + '\n', 'utf8');
}

// Conflict path: both branches rewrite line 1 to a DISTINCT track. git leaves
// conflict markers in playlist.jsonl; repoMerge must surface both sides' track
// NAMES (ours = the current branch's edit, theirs = the merged branch's edit).
test('repoMerge surfaces a per-track conflict with both sides\' names', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeSnapshot(dir, [T1, T2, T3]);
    await gitAdd(dir, ['playlist.jsonl', 'meta.json']);
    await gitCommit(dir, 'base');
    const base = await gitCurrentBranch(dir); // 'main' or 'master' depending on git config

    // Branch feature off the shared base, then diverge line 1 on each side.
    await gitBranch(dir, 'feature');

    await writeSnapshot(dir, [track('t1', 'Main Edit'), T2, T3]);
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'main edit');

    await gitCheckout(dir, 'feature');
    await writeSnapshot(dir, [track('t1', 'Feature Edit'), T2, T3]);
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'feature edit');

    // Merge feature INTO the base branch → conflict on line 1.
    await gitCheckout(dir, base);
    const result = await repoMerge(dir, 'feature');

    assert.equal(result.merged, false, 'a same-line divergence must not auto-merge');
    assert.equal(result.playlistName, META.name, 'reports the tracked playlist name');
    assert.ok(result.conflicts.length >= 1, 'at least one conflict region reported');

    const c = result.conflicts[0];
    assert.equal(c.ours?.name, 'Main Edit', 'ours side exposes the current branch track name');
    assert.equal(c.theirs?.name, 'Feature Edit', 'theirs side exposes the merged branch track name');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Clean path: feature is strictly ahead of an unchanged main → fast-forward, no
// conflicts. merged:true, empty conflicts.
test('repoMerge fast-forwards cleanly when the branch is ahead', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeSnapshot(dir, [T1, T2, T3]);
    await gitAdd(dir, ['playlist.jsonl', 'meta.json']);
    await gitCommit(dir, 'base');
    const base = await gitCurrentBranch(dir);

    await gitBranch(dir, 'feature');
    await gitCheckout(dir, 'feature');
    await writeSnapshot(dir, [T1, T2, T3, track('t4', 'Four')]);
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'feature add');

    // The base branch is untouched, so merging feature is a clean fast-forward.
    await gitCheckout(dir, base);
    const result = await repoMerge(dir, 'feature');

    assert.equal(result.merged, true, 'a branch strictly ahead fast-forwards cleanly');
    assert.deepEqual(result.conflicts, [], 'a clean merge reports no conflicts');
    assert.equal(result.playlistName, META.name, 'reports the tracked playlist name');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Negative surface: a directory with no meta.json is not a spit repo — the
// helper raises the established readable error, never a raw ENOENT.
test('repoMerge rejects a non-spit directory with a readable error', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await assert.rejects(
      () => repoMerge(dir, 'feature'),
      /No spit snapshot found.*Run `spit init/s,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
