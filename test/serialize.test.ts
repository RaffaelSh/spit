import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializePlaylist } from '../src/snapshot/serialize.js';
import type { PlaylistMeta, TrackRecord } from '../src/spotify/playlists.js';

const META: PlaylistMeta = {
  id: '37i9dQZF1DXcBWIGoYBM5M',
  name: 'Today’s Top Hits',
  description: 'The hottest tracks.',
  owner: 'Spotify',
};

const TRACKS: TrackRecord[] = [
  { id: 't1', uri: 'spotify:track:t1', name: 'First', artists: ['A'], album: 'AlbumA', duration_ms: 1000 },
  { id: 't2', uri: 'spotify:track:t2', name: 'Second', artists: ['B', 'C'], album: 'AlbumB', duration_ms: 2000 },
  // Locally-added track / episode: null id/uri must serialize without throwing.
  { id: null, uri: null, name: 'Local File', artists: ['D'], album: null, duration_ms: null },
];

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spit-serialize-'));
}

test('playlist.jsonl has exactly one line per track, in input order', async () => {
  const dir = await scratchDir();
  try {
    await serializePlaylist(META, TRACKS, dir);
    const raw = await readFile(join(dir, 'playlist.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, TRACKS.length);
    assert.equal(JSON.parse(lines[0]).name, 'First');
    assert.equal(JSON.parse(lines[1]).name, 'Second');
    assert.equal(JSON.parse(lines[2]).name, 'Local File');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every line is newline-terminated', async () => {
  const dir = await scratchDir();
  try {
    await serializePlaylist(META, TRACKS, dir);
    const raw = await readFile(join(dir, 'playlist.jsonl'), 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.equal(raw.split('\n').length - 1, TRACKS.length); // n newlines for n tracks
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('serialization is byte-identical for identical input (determinism)', async () => {
  const dirA = await scratchDir();
  const dirB = await scratchDir();
  try {
    await serializePlaylist(META, TRACKS, dirA);
    await serializePlaylist(META, TRACKS, dirB);
    assert.equal(
      await readFile(join(dirA, 'playlist.jsonl'), 'utf8'),
      await readFile(join(dirB, 'playlist.jsonl'), 'utf8'),
    );
    assert.equal(
      await readFile(join(dirA, 'meta.json'), 'utf8'),
      await readFile(join(dirB, 'meta.json'), 'utf8'),
    );
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test('null-id local track serializes without throwing', async () => {
  const dir = await scratchDir();
  try {
    const local: TrackRecord[] = [
      { id: null, uri: null, name: 'Only Local', artists: [], album: null, duration_ms: null },
    ];
    await serializePlaylist(META, local, dir);
    const parsed = JSON.parse((await readFile(join(dir, 'playlist.jsonl'), 'utf8')).trim());
    assert.equal(parsed.id, null);
    assert.equal(parsed.uri, null);
    assert.equal(parsed.name, 'Only Local');
    assert.deepEqual(parsed.artists, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('meta.json contains id, name, description and omits owner/timestamps', async () => {
  const dir = await scratchDir();
  try {
    await serializePlaylist(META, TRACKS, dir);
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    assert.deepEqual(meta, { id: META.id, name: META.name, description: META.description });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('empty playlist produces an empty playlist.jsonl', async () => {
  const dir = await scratchDir();
  try {
    await serializePlaylist(META, [], dir);
    assert.equal(await readFile(join(dir, 'playlist.jsonl'), 'utf8'), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
