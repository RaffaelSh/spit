import { resolve } from 'node:path';
import { gitShow } from '../git/git.js';
import { SpotifyApiError, spotifyPost, spotifyPut } from '../spotify/client.js';
import { getPlaylist, getPlaylistTracks } from '../spotify/playlists.js';
import type { TrackRecord } from '../spotify/playlists.js';
import { deserializePlaylist, serializeTrackLine } from '../snapshot/serialize.js';
import type { SnapshotMeta } from '../snapshot/serialize.js';
import { WRITE_DISABLED_MESSAGE, enableWrites, readWriteMode } from './write-config.js';

/**
 * A push failure whose message is already the actionable sentence the CLI (T05)
 * prints verbatim. Every R010 failure mode — disabled gate, missing scopes,
 * deleted playlist, concurrent edit, rate limit, network — surfaces as a
 * PushError so the CLI never has to interpret raw Spotify/HTTP errors itself.
 */
export class PushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushError';
  }
}

/** Counts driving the pre-warning ("+A added, -R removed, ~M moved"). */
export interface ChangeSummary {
  added: number;
  removed: number;
  moved: number;
}

/** The result the CLI reports after a successful push. */
export interface PushResult {
  playlistId: string;
  playlistName: string;
  affected: ChangeSummary;
  batches: number;
  trackCount: number;
}

/**
 * Injectable write surface for {@link executePush}. Defaults hit the real
 * Spotify write endpoints; tests pass a fake that records calls, which is what
 * makes the ≤100 PUT / >100 PUT+POST batching CI-testable without the network.
 */
export interface PushIo {
  put: (playlistId: string, uris: string[]) => Promise<{ snapshot_id?: string }>;
  post: (playlistId: string, uris: string[]) => Promise<{ snapshot_id?: string }>;
}

/**
 * Options for {@link pushSnapshot}. `confirm` receives the change summary AND
 * the live playlist name so the CLI (T05) can render the full pre-warning line
 * ("...moved to \"<name>\"") before the interactive [y/N] prompt. T04/T05
 * co-own this contract.
 */
export interface PushOptions {
  commit?: string;
  force?: boolean;
  enableWrites?: boolean;
  confirm?: (summary: ChangeSummary, playlistName: string) => Promise<boolean>;
}

const defaultIo: PushIo = {
  put: (playlistId, uris) => spotifyPut(`/playlists/${playlistId}/tracks`, { uris }),
  post: (playlistId, uris) => spotifyPost(`/playlists/${playlistId}/tracks`, { uris }),
};

/**
 * Map each committed track to its Spotify URI. A null uri means a local file /
 * episode that Spotify cannot re-add via URI, so the whole push is rejected up
 * front with an actionable message rather than silently dropping tracks. Pure.
 */
export function extractPushUris(tracks: TrackRecord[]): string[] {
  const uris: string[] = [];
  for (const track of tracks) {
    if (track.uri == null) {
      throw new PushError(
        'This snapshot contains local tracks with no Spotify URI and cannot be pushed.',
      );
    }
    uris.push(track.uri);
  }
  return uris;
}

/**
 * Split URIs into a single atomic replace (first ≤100) plus zero or more add
 * batches (the remainder, chunked into ≤100). A ≤100-track push yields an empty
 * `posts`. Pure — the batching contract is exercised directly in CI.
 */
export function planBatches(uris: string[]): { put: string[]; posts: string[][] } {
  const put = uris.slice(0, 100);
  const rest = uris.slice(100);
  const posts: string[][] = [];
  for (let i = 0; i < rest.length; i += 100) {
    posts.push(rest.slice(i, i + 100));
  }
  return { put, posts };
}

/**
 * Execute the planned batches in order: one atomic PUT (replaces the playlist,
 * even with an empty URI list — that clears it) followed by each remaining
 * chunk as an ordered POST. Returns the batch count (1 PUT + N POSTs) and the
 * last snapshot_id Spotify returned. `io` is injectable so the call sequence is
 * asserted in CI without touching the network.
 */
export async function executePush(
  playlistId: string,
  uris: string[],
  io: PushIo = defaultIo,
): Promise<{ batches: number; snapshotId?: string }> {
  const plan = planBatches(uris);

  let snapshotId: string | undefined;
  const putRes = await io.put(playlistId, plan.put);
  if (putRes.snapshot_id) snapshotId = putRes.snapshot_id;

  for (const chunk of plan.posts) {
    const postRes = await io.post(playlistId, chunk);
    if (postRes.snapshot_id) snapshotId = postRes.snapshot_id;
  }

  return { batches: 1 + plan.posts.length, snapshotId };
}

/**
 * Count added / removed / moved tracks between a live playlist and a committed
 * snapshot, mirroring diff.ts semantics over the canonical per-track line
 * (serializeTrackLine): identical lines are paired positionally, a paired line
 * whose index differs is MOVED, an unpaired committed line is ADDED, an unpaired
 * live line is REMOVED. Drives the live→committed pre-warning. Pure.
 */
export function summarizeChange(
  live: TrackRecord[],
  committed: TrackRecord[],
): ChangeSummary {
  const bucket = (tracks: TrackRecord[]): Map<string, number[]> => {
    const map = new Map<string, number[]>();
    tracks.forEach((track, index) => {
      const key = serializeTrackLine(track);
      const indices = map.get(key);
      if (indices) indices.push(index);
      else map.set(key, [index]);
    });
    return map;
  };

  const liveByLine = bucket(live);
  const committedByLine = bucket(committed);

  let added = 0;
  let removed = 0;
  let moved = 0;

  const lines = new Set<string>([...liveByLine.keys(), ...committedByLine.keys()]);
  for (const line of lines) {
    const l = liveByLine.get(line) ?? [];
    const c = committedByLine.get(line) ?? [];
    const paired = Math.min(l.length, c.length);
    for (let i = 0; i < paired; i++) {
      if (l[i] !== c[i]) moved++;
    }
    removed += l.length - paired;
    added += c.length - paired;
  }

  return { added, removed, moved };
}

/**
 * Turn any error thrown by a Spotify write/read into the exact sentence the CLI
 * should print (R010). A SpotifyApiError maps by status; anything else is
 * treated as a fetch-level network throw. Pure.
 */
export function describePushError(err: unknown): string {
  if (err instanceof SpotifyApiError) {
    const status = err.status;
    if (status === 401) return 're-run spit login';
    if (status === 403) {
      return "missing write scopes — re-run spit login (or you don't own this playlist)";
    }
    if (status === 404) {
      return 'Spotify playlist was deleted; history remains in git but push is no longer possible';
    }
    if (status === 409 || status === 422) {
      return 'playlist changed concurrently (snapshot mismatch); re-commit and try again';
    }
    if (status === 429) return 'Spotify rate limited; try again shortly';
    if (status >= 500) return 'Spotify server error; try again';
    return err.message;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Network error: ${message}`;
}

/**
 * Rethrow any Spotify-originated error as an actionable PushError. A PushError
 * that already surfaced (e.g. extractPushUris) is passed through unchanged.
 */
async function spotifyGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PushError) throw err;
    throw new PushError(describePushError(err));
  }
}

/**
 * Write a committed snapshot back to the live Spotify playlist (R008), gated on
 * the per-repo opt-in (R009) and surfacing every failure as an actionable
 * PushError (R010).
 *
 * Order: optionally flip on write-mode (`enableWrites`), then fail closed if the
 * repo is still display-only. Read the committed meta.json + playlist.jsonl at
 * `commit` (default HEAD) from git — no re-serialization, no Spotify read for the
 * committed side. Read the live playlist to compute the added/removed/moved
 * summary, and — unless `force` — call `confirm(summary)` and abort on false
 * BEFORE any write. Then extract URIs, plan batches, and execute the PUT(+POSTs).
 *
 * The orchestrator is I/O-free except the git reads and the Spotify reads/writes;
 * the interactive [y/N] prompt lives in the CLI-supplied `confirm` callback (T05).
 */
export async function pushSnapshot(
  dir: string | undefined,
  opts: PushOptions = {},
): Promise<PushResult> {
  const repoDir = resolve(dir ?? '.');

  if (opts.enableWrites) await enableWrites(repoDir);
  if (!(await readWriteMode(repoDir))) throw new PushError(WRITE_DISABLED_MESSAGE);

  const rev = opts.commit ?? 'HEAD';
  const meta = JSON.parse(await gitShow(repoDir, rev, 'meta.json')) as SnapshotMeta;
  const committed = deserializePlaylist(await gitShow(repoDir, rev, 'playlist.jsonl'));

  const liveMeta = await spotifyGuard(() => getPlaylist(meta.id));
  const live = await spotifyGuard(() => getPlaylistTracks(meta.id));

  const summary = summarizeChange(live, committed);

  if (!opts.force) {
    const confirm = opts.confirm ?? (() => Promise.resolve(false));
    const ok = await confirm(summary, liveMeta.name);
    if (!ok) throw new PushError('Aborted.');
  }

  const uris = extractPushUris(committed);
  const { batches } = await spotifyGuard(() => executePush(meta.id, uris));

  return {
    playlistId: meta.id,
    playlistName: liveMeta.name,
    affected: summary,
    batches,
    trackCount: uris.length,
  };
}
