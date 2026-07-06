import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlaylistMeta, TrackRecord } from '../spotify/playlists.js';

/** meta.json shape — a deterministic subset of playlist metadata (no timestamps). */
export interface SnapshotMeta {
  id: string;
  name: string;
  description: string;
}

/** Absolute paths written by a snapshot. */
export interface SnapshotPaths {
  jsonlPath: string;
  metaPath: string;
}

/**
 * Serialize a track to a single JSONL line with a FIXED field order.
 * The key order is written explicitly here (not derived from object insertion
 * upstream) so the same logical track always yields byte-identical output.
 */
function serializeTrack(track: TrackRecord): string {
  return JSON.stringify({
    id: track.id ?? null,
    uri: track.uri ?? null,
    name: track.name ?? null,
    artists: track.artists ?? [],
    album: track.album ?? null,
    duration_ms: track.duration_ms ?? null,
  });
}

/**
 * Write a deterministic snapshot of a playlist into `dir`:
 *   - playlist.jsonl : one track per line, newline-terminated, playlist order (D002)
 *   - meta.json      : spotify id / name / description
 *
 * Deterministic by construction: fixed field order and no timestamps, so the
 * same input produces byte-identical output — a prerequisite for git diffs to
 * reflect real playlist changes rather than serialization noise.
 */
export async function serializePlaylist(
  meta: PlaylistMeta,
  tracks: TrackRecord[],
  dir: string,
): Promise<SnapshotPaths> {
  await mkdir(dir, { recursive: true });

  const jsonlPath = join(dir, 'playlist.jsonl');
  const metaPath = join(dir, 'meta.json');

  // Each line newline-terminated; an empty playlist yields an empty file.
  const jsonl = tracks.map((t) => serializeTrack(t) + '\n').join('');
  await writeFile(jsonlPath, jsonl, 'utf8');

  const metaOut: SnapshotMeta = {
    id: meta.id,
    name: meta.name,
    description: meta.description,
  };
  await writeFile(metaPath, JSON.stringify(metaOut, null, 2) + '\n', 'utf8');

  return { jsonlPath, metaPath };
}
