import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { getPlaylist, getPlaylistTracks } from '../spotify/playlists.js';
import { snapshotAndCommit } from './snapshot-commit.js';
import type { SnapshotMeta } from '../snapshot/serialize.js';

/** Structured `spit commit` result, printed by the CLI layer. */
export interface CommitResult {
  repoDir: string;
  playlistName: string;
  trackCount: number;
  changed: boolean;
  commit: string;
}

/**
 * `spit commit [dir] -m <message>` — re-read the live Spotify playlist tracked
 * by this repo, re-serialize it deterministically, and record a new git
 * revision — but ONLY when the staged snapshot actually differs from HEAD.
 *
 * A change on Spotify becomes a clean second revision (`changed: true`); an
 * unchanged playlist is a clean no-op (`changed: false`, no empty commit).
 *
 * Failure paths inherit S01's readable posture: not a spit repo → the same
 * "No spit snapshot found … Run `spit init` first." error as status; auth
 * failure → ReauthRequiredError ("Run `spit login`"); git failure → GitError
 * carrying git's stderr. All Spotify access flows through the S01 token seam.
 */
export async function commitSnapshot(
  dir: string | undefined,
  opts: { message: string },
): Promise<CommitResult> {
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

  const { changed, commit } = await snapshotAndCommit(repoDir, liveMeta, tracks, opts.message);

  return { repoDir, playlistName: liveMeta.name, trackCount: tracks.length, changed, commit };
}
