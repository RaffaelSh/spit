import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PushError,
  describePushError,
  executePush,
  extractPushUris,
  planBatches,
  summarizeChange,
} from '../src/repo/push.js';
import type { PushIo } from '../src/repo/push.js';
import { SpotifyApiError } from '../src/spotify/client.js';
import type { TrackRecord } from '../src/spotify/playlists.js';

// ---------- fixtures (no network) ----------

function track(id: string, name = id): TrackRecord {
  return {
    id,
    uri: `spotify:track:${id}`,
    name,
    artists: ['A'],
    album: 'Album',
    duration_ms: 1000,
  };
}

/** N tracks t0..t(N-1), each with a distinct spotify:track URI. */
function tracks(n: number): TrackRecord[] {
  return Array.from({ length: n }, (_, i) => track(`t${i}`));
}

function uris(n: number): string[] {
  return tracks(n).map((t) => t.uri as string);
}

/** A fake io that records every call as { verb, count } and returns a snapshot id. */
function recordingIo(): { io: PushIo; log: Array<{ verb: 'put' | 'post'; count: number }> } {
  const log: Array<{ verb: 'put' | 'post'; count: number }> = [];
  const io: PushIo = {
    put: async (_id, u) => {
      log.push({ verb: 'put', count: u.length });
      return { snapshot_id: 'snap' };
    },
    post: async (_id, u) => {
      log.push({ verb: 'post', count: u.length });
      return { snapshot_id: 'snap' };
    },
  };
  return { io, log };
}

// ---------- extractPushUris ----------

test('extractPushUris maps each track to its uri in order', () => {
  assert.deepEqual(extractPushUris(tracks(3)), [
    'spotify:track:t0',
    'spotify:track:t1',
    'spotify:track:t2',
  ]);
});

test('extractPushUris throws PushError when any track has a null uri', () => {
  const local: TrackRecord = { id: null, uri: null, name: 'Local', artists: [], album: null, duration_ms: null };
  assert.throws(
    () => extractPushUris([track('t0'), local]),
    (err: unknown) => err instanceof PushError && /local tracks with no Spotify URI/.test((err as Error).message),
  );
});

// ---------- planBatches ----------

test('planBatches puts a ≤100 push in a single PUT with no POSTs', () => {
  const plan = planBatches(uris(100));
  assert.equal(plan.put.length, 100);
  assert.deepEqual(plan.posts, []);
});

test('planBatches spills the 101st uri into a single POST', () => {
  const plan = planBatches(uris(101));
  assert.equal(plan.put.length, 100);
  assert.equal(plan.posts.length, 1);
  assert.equal(plan.posts[0].length, 1);
});

test('planBatches chunks 250 into PUT100 + POST100 + POST50', () => {
  const plan = planBatches(uris(250));
  assert.equal(plan.put.length, 100);
  assert.deepEqual(plan.posts.map((p) => p.length), [100, 50]);
});

test('planBatches of an empty push is an empty PUT with no POSTs', () => {
  assert.deepEqual(planBatches([]), { put: [], posts: [] });
});

// ---------- executePush call sequence ----------

test('executePush issues a single PUT for 100 uris', async () => {
  const { io, log } = recordingIo();
  const res = await executePush('pl', uris(100), io);
  assert.deepEqual(log, [{ verb: 'put', count: 100 }]);
  assert.equal(res.batches, 1);
  assert.equal(res.snapshotId, 'snap');
});

test('executePush issues PUT then POST for 101 uris, in order', async () => {
  const { io, log } = recordingIo();
  const res = await executePush('pl', uris(101), io);
  assert.deepEqual(log, [
    { verb: 'put', count: 100 },
    { verb: 'post', count: 1 },
  ]);
  assert.equal(res.batches, 2);
});

test('executePush issues PUT100 + POST100 + POST50 for 250 uris, in order', async () => {
  const { io, log } = recordingIo();
  const res = await executePush('pl', uris(250), io);
  assert.deepEqual(log, [
    { verb: 'put', count: 100 },
    { verb: 'post', count: 100 },
    { verb: 'post', count: 50 },
  ]);
  assert.equal(res.batches, 3);
});

// ---------- summarizeChange ----------

test('summarizeChange counts added, removed, and moved tracks', () => {
  // live:      [t0, t1, t2, t3]
  // committed: [t1, t0, t2, t4]
  //   t0: 0 -> 1 (moved), t1: 1 -> 0 (moved), t2: 2 -> 2 (unchanged),
  //   t3 removed, t4 added.
  const live = [track('t0'), track('t1'), track('t2'), track('t3')];
  const committed = [track('t1'), track('t0'), track('t2'), track('t4')];
  assert.deepEqual(summarizeChange(live, committed), { added: 1, removed: 1, moved: 2 });
});

test('summarizeChange reports no change for identical playlists', () => {
  const same = tracks(3);
  assert.deepEqual(summarizeChange(same, same), { added: 0, removed: 0, moved: 0 });
});

test('summarizeChange counts every committed track as added against an empty live playlist', () => {
  assert.deepEqual(summarizeChange([], tracks(2)), { added: 2, removed: 0, moved: 0 });
});

// ---------- describePushError ----------

test('describePushError maps each SpotifyApiError status to an actionable message', () => {
  const msg = (status: number) => describePushError(new SpotifyApiError(status, 'raw'));
  assert.match(msg(401), /re-run spit login/);
  assert.match(msg(403), /missing write scopes/);
  assert.match(msg(404), /playlist was deleted/);
  assert.match(msg(409), /changed concurrently/);
  assert.match(msg(422), /changed concurrently/);
  assert.match(msg(429), /rate limited/);
  assert.match(msg(500), /server error/);
  assert.match(msg(503), /server error/);
});

test('describePushError treats a non-Spotify throw as a network error', () => {
  assert.equal(describePushError(new Error('socket hang up')), 'Network error: socket hang up');
});
