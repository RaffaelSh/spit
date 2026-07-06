import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { getPlaylist, getPlaylistTracks } from '../spotify/playlists.js';
import { serializePlaylist } from '../snapshot/serialize.js';
import { gitStatus } from '../git/git.js';
import type { PlaylistMeta, TrackRecord } from '../spotify/playlists.js';
import type { SnapshotMeta } from '../snapshot/serialize.js';

/** Structured `spit pull` result, printed by the CLI layer. */
export interface PullResult {
  repoDir: string;
  playlistName: string;
  trackCount: number;
  changed: boolean;
}

/**
 * Write the live playlist state into the working tree WITHOUT committing, then
 * report whether that left the tree dirty. This is the testable core of `pull`:
 * tests inject PlaylistMeta + TrackRecord[] directly (no Spotify), exactly as
 * commit.test.ts drives snapshotAndCommit.
 *
 * `changed` mirrors status.ts's whole-tree clean/dirty check: after writing the
 * two managed files, an empty `git status` means the pulled state matched what
 * was already committed (a no-op pull); a non-empty status means the working
 * tree now carries an uncommitted update ready for `spit commit`.
 */
export async function writePulledSnapshot(
  repoDir: string,
  meta: PlaylistMeta,
  tracks: TrackRecord[],
): Promise<PullResult> {
  await serializePlaylist(meta, tracks, repoDir);
  const porcelain = await gitStatus(repoDir);
  const changed = porcelain.trim().length > 0;
  return { repoDir, playlistName: meta.name, trackCount: tracks.length, changed };
}

/**
 * `spit pull [dir]` — the fetch half of spit's Spotify-as-remote model: re-read
 * the live Spotify playlist tracked by this repo and write it into the working
 * tree, WITHOUT committing. After a pull, `spit status`/`spit diff` show the
 * delta and `spit commit` records it — mirroring git's fetch-into-working-tree
 * then commit flow. Unlike `commit`, pull never creates a revision, so the live
 * state can be inspected before deciding to snapshot it.
 *
 * Failure paths match commit/status: not a spit repo → the readable "Run `spit
 * init` first" error; auth failure → ReauthRequiredError ("Run `spit login`");
 * all Spotify access flows through the S01 token seam.
 */
export async function repoPull(dir: string | undefined): Promise<PullResult> {
  const repoDir = resolve(dir ?? '.');

  let metaRaw: string;
  try {
    metaRaw = await readFile(join(repoDir, 'meta.json'), 'utf8');
  } catch {
    throw new Error(
      `No spit snapshot found in ${repoDir} (meta.json missing). ` +
        'Run `spit init <playlistId>` first.',
    );
  }
  const tracked = JSON.parse(metaRaw) as SnapshotMeta;

  const liveMeta = await getPlaylist(tracked.id);
  const tracks = await getPlaylistTracks(tracked.id);

  return writePulledSnapshot(repoDir, liveMeta, tracks);
}
