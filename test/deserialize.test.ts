import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializePlaylist, deserializePlaylist } from '../src/snapshot/serialize.js';
import type { PlaylistMeta, TrackRecord } from '../src/spotify/playlists.js';

const META: PlaylistMeta = {
  id: '37i9dQZF1DXcBWIGoYBM5M',
  name: 'Today’s Top Hits',
  description: 'The hottest tracks.',
  owner: 'Spotify',
};

const TRACKS: TrackRecord[] = [
  { id: 't1', uri: 'spotify:track:t1', name: 'First', artists: ['A'], album: 'AlbumA', duration_ms: 1000 },
  // Multi-artist track: array order must survive the round-trip.
  { id: 't2', uri: 'spotify:track:t2', name: 'Second', artists: ['B', 'C'], album: 'AlbumB', duration_ms: 2000 },
  // Locally-added track / episode: null id/uri must round-trip as null.
  { id: null, uri: null, name: 'Local File', artists: ['D'], album: null, duration_ms: null },
];

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spit-deserialize-'));
}

test('serialize → read → deserialize round-trips to the original TrackRecord[]', async () => {
  const dir = await scratchDir();
  try {
    await serializePlaylist(META, TRACKS, dir);
    const jsonl = await readFile(join(dir, 'playlist.jsonl'), 'utf8');
    const parsed = deserializePlaylist(jsonl);
    assert.deepEqual(parsed, TRACKS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deserializePlaylist preserves playlist (file) order', async () => {
  const dir = await scratchDir();
  try {
    await serializePlaylist(META, TRACKS, dir);
    const jsonl = await readFile(join(dir, 'playlist.jsonl'), 'utf8');
    const parsed = deserializePlaylist(jsonl);
    assert.deepEqual(parsed.map((t) => t.name), ['First', 'Second', 'Local File']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deserializePlaylist of the empty-playlist empty file yields []', async () => {
  const dir = await scratchDir();
  try {
    await serializePlaylist(META, [], dir);
    const jsonl = await readFile(join(dir, 'playlist.jsonl'), 'utf8');
    assert.equal(jsonl, '');
    assert.deepEqual(deserializePlaylist(jsonl), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deserializePlaylist('') → []", () => {
  assert.deepEqual(deserializePlaylist(''), []);
});

test('a trailing newline drops no real tracks', () => {
  const one: TrackRecord = {
    id: 't1', uri: 'spotify:track:t1', name: 'Only', artists: ['A'], album: 'AlbumA', duration_ms: 1000,
  };
  // serializePlaylist newline-terminates every line, so single-track output ends in '\n'.
  const jsonl = JSON.stringify(one) + '\n';
  const parsed = deserializePlaylist(jsonl);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], one);
});
