import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gitRevert, gitShortHead } from '../git/git.js';
import type { SnapshotMeta } from '../snapshot/serialize.js';

/** Structured `spit revert <ref>` result, printed by the CLI layer. */
export interface RevertResult {
  repoDir: string;
  ref: string;
  commit: string;
  playlistName: string;
  trackCount: number;
}

/**
 * `spit revert <ref> [dir]` — undo a revision by creating its inverse commit.
 * git revert both writes the new commit AND restores playlist.jsonl + meta.json
 * in the working tree, so this helper does NOT re-serialize; it reads the files
 * back to report the resulting playlist name, track count, and short commit.
 *
 * Boundary: this restores the LOCAL snapshot only. Reflecting the reverted state
 * onto Spotify is S05's `spit push` — revert never touches the Spotify API.
 *
 * Failure paths inherit S01's readable posture: not a spit repo → the same
 * "No spit snapshot found … Run `spit init` first." error; an invalid ref or a
 * revert conflict → GitError carrying git's stderr.
 */
export async function repoRevert(
  dir: string | undefined,
  ref: string,
): Promise<RevertResult> {
  const repoDir = resolve(dir ?? '.');

  try {
    await readFile(join(repoDir, 'meta.json'), 'utf8');
  } catch {
    throw new Error(
      `No spit snapshot found in ${repoDir} (meta.json missing). ` +
        'Run `spit init <playlistId>` first.',
    );
  }

  await gitRevert(repoDir, ref);

  const restoredMeta = JSON.parse(
    await readFile(join(repoDir, 'meta.json'), 'utf8'),
  ) as SnapshotMeta;
  const jsonl = await readFile(join(repoDir, 'playlist.jsonl'), 'utf8');
  const trackCount = jsonl.split('\n').filter((l) => l.length > 0).length;
  const commit = await gitShortHead(repoDir);

  return { repoDir, ref, commit, playlistName: restoredMeta.name, trackCount };
}
