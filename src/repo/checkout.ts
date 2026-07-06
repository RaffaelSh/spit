import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gitCheckout, gitCurrentBranch, gitShortHead } from '../git/git.js';
import type { SnapshotMeta } from '../snapshot/serialize.js';

/** Structured `spit checkout <ref>` result, printed by the CLI layer. */
export interface CheckoutResult {
  repoDir: string;
  ref: string;
  commit: string;
  playlistName: string;
  trackCount: number;
  detached: boolean;
}

/**
 * `spit checkout <ref> [dir]` — restore an earlier snapshot into the LOCAL
 * working tree. git checkout already rewrites playlist.jsonl + meta.json from the
 * target commit; this helper does NOT re-serialize and does NOT touch Spotify
 * (write-back is S05's `spit push`). It simply reads the restored files back to
 * report the playlist name, track count, and short commit.
 *
 * Checking out a bare commit detaches HEAD — a normal, non-error outcome that the
 * CLI must warn about; `detached` is true exactly when the current ref is HEAD.
 *
 * Failure paths inherit S01's readable posture: not a spit repo → the same
 * "No spit snapshot found … Run `spit init` first." error; an invalid ref →
 * GitError carrying git's stderr.
 */
export async function repoCheckout(
  dir: string | undefined,
  ref: string,
): Promise<CheckoutResult> {
  const repoDir = resolve(dir ?? '.');

  try {
    await readFile(join(repoDir, 'meta.json'), 'utf8');
  } catch {
    throw new Error(
      `No spit snapshot found in ${repoDir} (meta.json missing). ` +
        'Run `spit init <playlistId>` first.',
    );
  }

  await gitCheckout(repoDir, ref);

  const restoredMeta = JSON.parse(
    await readFile(join(repoDir, 'meta.json'), 'utf8'),
  ) as SnapshotMeta;
  const jsonl = await readFile(join(repoDir, 'playlist.jsonl'), 'utf8');
  const trackCount = jsonl.split('\n').filter((l) => l.length > 0).length;
  const commit = await gitShortHead(repoDir);
  const detached = (await gitCurrentBranch(repoDir)) === 'HEAD';

  return { repoDir, ref, commit, playlistName: restoredMeta.name, trackCount, detached };
}
