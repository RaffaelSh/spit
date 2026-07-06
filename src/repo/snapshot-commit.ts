import { serializePlaylist } from '../snapshot/serialize.js';
import { gitAdd, gitCommit, gitHasStagedChanges, gitShortHead } from '../git/git.js';
import type { PlaylistMeta, TrackRecord } from '../spotify/playlists.js';

/**
 * The ONE serialize→stage→commit tail shared by `init` and `commit`, so the two
 * commands can never drift into writing byte-divergent snapshots (research
 * Pitfall: init/commit drift). Callers own repo creation: `init` runs
 * `gitInit` first; `commit` runs against an already-initialized repo. This
 * helper deliberately does NOT run `gitInit`.
 *
 * Serializes the live playlist deterministically, stages ONLY the two managed
 * files, then commits — but only when the staged snapshot actually differs from
 * HEAD. An unchanged playlist is a clean no-op: `changed: false` and the current
 * short HEAD are returned without creating an empty revision.
 */
export async function snapshotAndCommit(
  repoDir: string,
  meta: PlaylistMeta,
  tracks: TrackRecord[],
  message: string,
): Promise<{ changed: boolean; commit: string }> {
  await serializePlaylist(meta, tracks, repoDir);
  await gitAdd(repoDir, ['playlist.jsonl', 'meta.json']);

  if (!(await gitHasStagedChanges(repoDir))) {
    return { changed: false, commit: await gitShortHead(repoDir) };
  }

  await gitCommit(repoDir, message);
  return { changed: true, commit: await gitShortHead(repoDir) };
}
