import { resolve } from 'node:path';
import { gitShow } from '../git/git.js';
import type { TrackRecord } from '../spotify/playlists.js';

/** A track that changed position between two snapshots. */
export interface MovedTrack {
  track: TrackRecord;
  fromIndex: number;
  toIndex: number;
}

/** Structured `spit diff` result, printed by the CLI layer. */
export interface DiffResult {
  added: TrackRecord[];
  removed: TrackRecord[];
  moved: MovedTrack[];
  /** True when the revisions differ but the track lines are identical (e.g. a meta.json-only change). */
  metaOnly: boolean;
}

/** A parsed playlist.jsonl line: raw content + decoded track + position. */
interface ParsedLine {
  raw: string;
  track: TrackRecord;
  index: number;
}

/**
 * Parse a raw playlist.jsonl blob into an ordered array of lines. The RAW line
 * string is kept alongside its parsed track + position because identity is line
 * content + position (D009) — no synthetic track key is invented.
 */
function parseSnapshot(jsonl: string): ParsedLine[] {
  return jsonl
    .split('\n')
    .filter((line) => line.length > 0)
    .map((raw, index) => ({ raw, track: JSON.parse(raw) as TrackRecord, index }));
}

/**
 * `spit diff [dir] [rev1] [rev2]` — a human-readable added/removed/moved track
 * diff between two playlist snapshots, read from the local git repo only (no
 * Spotify call).
 *
 * Both snapshots are read with `git show <rev>:playlist.jsonl`. The diff is a
 * multiset over raw line content: occurrences of each distinct line are paired
 * between the two revisions in positional order — a paired line whose position
 * moved is MOVED, an unpaired rev1 line is REMOVED, an unpaired rev2 line is
 * ADDED. Duplicate identical lines are handled by the multiset pairing.
 *
 * `metaOnly` is true when the revisions differ but no track line changed (e.g. a
 * meta.json-only rename). An invalid revision makes `gitShow` raise a GitError
 * carrying git's own stderr — that propagates unchanged.
 */
export async function repoDiff(
  dir: string | undefined,
  rev1 = 'HEAD~1',
  rev2 = 'HEAD',
): Promise<DiffResult> {
  const repoDir = resolve(dir ?? '.');

  const [jsonl1, jsonl2] = await Promise.all([
    gitShow(repoDir, rev1, 'playlist.jsonl'),
    gitShow(repoDir, rev2, 'playlist.jsonl'),
  ]);

  const before = parseSnapshot(jsonl1);
  const after = parseSnapshot(jsonl2);

  // Bucket occurrences of each distinct raw line, preserving positional order.
  const beforeByLine = new Map<string, ParsedLine[]>();
  for (const line of before) {
    const bucket = beforeByLine.get(line.raw);
    if (bucket) bucket.push(line);
    else beforeByLine.set(line.raw, [line]);
  }
  const afterByLine = new Map<string, ParsedLine[]>();
  for (const line of after) {
    const bucket = afterByLine.get(line.raw);
    if (bucket) bucket.push(line);
    else afterByLine.set(line.raw, [line]);
  }

  const added: TrackRecord[] = [];
  const removed: TrackRecord[] = [];
  const moved: MovedTrack[] = [];

  // Every distinct line that appears in either revision.
  const rawLines = new Set<string>([...beforeByLine.keys(), ...afterByLine.keys()]);
  for (const raw of rawLines) {
    const b = beforeByLine.get(raw) ?? [];
    const a = afterByLine.get(raw) ?? [];
    const paired = Math.min(b.length, a.length);
    for (let i = 0; i < paired; i++) {
      if (b[i].index !== a[i].index) {
        moved.push({ track: a[i].track, fromIndex: b[i].index, toIndex: a[i].index });
      }
    }
    for (let i = paired; i < b.length; i++) removed.push(b[i].track);
    for (let i = paired; i < a.length; i++) added.push(a[i].track);
  }

  const metaOnly = added.length === 0 && removed.length === 0 && moved.length === 0;
  return { added, removed, moved, metaOnly };
}
