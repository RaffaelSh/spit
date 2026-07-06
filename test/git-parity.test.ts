import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoTag } from '../src/repo/tag.js';
import { repoStash } from '../src/repo/stash.js';
import { repoRebase } from '../src/repo/rebase.js';
import { snapshotAndCommit } from '../src/repo/snapshot-commit.js';
import {
  gitInit,
  gitAdd,
  gitCommit,
  gitBranch,
  gitCheckout,
  gitCurrentBranch,
} from '../src/git/git.js';
import type { PlaylistMeta, TrackRecord } from '../src/spotify/playlists.js';

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

async function seeded(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await gitInit(dir);
  await snapshotAndCommit(dir, META, TRACKS, 'base');
  return dir;
}

// --- tag ---

test('repoTag creates a tag and then lists it', async () => {
  const dir = await seeded('spit-tag-');
  try {
    const created = await repoTag(dir, 'v1');
    assert.equal(created.created, 'v1');
    assert.ok(created.tags.includes('v1'), 'created tag appears in the list');

    const listed = await repoTag(dir);
    assert.equal(listed.created, undefined, 'listing does not report a creation');
    assert.deepEqual(listed.tags, ['v1']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repoTag surfaces a duplicate tag as a GitError', async () => {
  const dir = await seeded('spit-tag-dup-');
  try {
    await repoTag(dir, 'v1');
    await assert.rejects(() => repoTag(dir, 'v1'), /already exists/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repoTag rejects a non-spit directory with a readable error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spit-tag-none-'));
  try {
    await gitInit(dir);
    await assert.rejects(() => repoTag(dir, 'v1'), /No spit snapshot found.*Run `spit init/s);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- stash ---

test('repoStash save shelves working-tree edits, pop restores them', async () => {
  const dir = await seeded('spit-stash-');
  try {
    const jsonl = join(dir, 'playlist.jsonl');
    const committed = await readFile(jsonl, 'utf8');
    await writeFile(jsonl, committed + '{"id":"t3","uri":"spotify:track:t3"}\n', 'utf8');

    const saved = await repoStash(dir, 'save');
    assert.equal(saved.noOp, false, 'a dirty tree is actually stashed');
    assert.equal(await readFile(jsonl, 'utf8'), committed, 'working tree reverts to committed state');

    const popped = await repoStash(dir, 'pop');
    assert.equal(popped.action, 'pop');
    assert.match(await readFile(jsonl, 'utf8'), /t3/, 'the shelved edit is restored');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repoStash save on a clean tree is a no-op, not an error', async () => {
  const dir = await seeded('spit-stash-clean-');
  try {
    const res = await repoStash(dir, 'save');
    assert.equal(res.noOp, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repoStash pop on an empty stash gives a readable error', async () => {
  const dir = await seeded('spit-stash-empty-');
  try {
    await assert.rejects(() => repoStash(dir, 'pop'), /stash is empty/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- rebase ---

test('repoRebase replays a linear, non-conflicting branch cleanly', async () => {
  const dir = await seeded('spit-rebase-');
  try {
    const base = await gitCurrentBranch(dir); // 'main' or 'master' per git config

    // feature branches off base, adds a commit touching a distinct file.
    await gitBranch(dir, 'feature');
    await gitCheckout(dir, 'feature');
    await writeFile(join(dir, 'feature.txt'), 'from feature\n', 'utf8');
    await gitAdd(dir, ['feature.txt']);
    await gitCommit(dir, 'feature work');

    // base advances with a commit touching a different file — no overlap.
    await gitCheckout(dir, base);
    await writeFile(join(dir, 'mainline.txt'), 'from main\n', 'utf8');
    await gitAdd(dir, ['mainline.txt']);
    await gitCommit(dir, 'mainline work');

    // Rebase feature onto the advanced base: a clean replay.
    await gitCheckout(dir, 'feature');
    const res = await repoRebase(dir, base);
    assert.ok(res.commit.length > 0, 'reports the new HEAD');

    // Both the replayed and the mainline files are present ⇒ history is linear.
    assert.match(await readFile(join(dir, 'feature.txt'), 'utf8'), /from feature/);
    assert.match(await readFile(join(dir, 'mainline.txt'), 'utf8'), /from main/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repoRebase rejects a non-spit directory with a readable error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spit-rebase-none-'));
  try {
    await gitInit(dir);
    await assert.rejects(() => repoRebase(dir, 'main'), /No spit snapshot found.*Run `spit init/s);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
