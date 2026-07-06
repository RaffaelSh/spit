import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gitRebase, gitShortHead } from '../git/git.js';
import type { SnapshotMeta } from '../snapshot/serialize.js';

/** Structured `spit rebase <upstream>` result, printed by the CLI layer. */
export interface RebaseResult {
  repoDir: string;
  playlistName: string;
  /** Short HEAD after the rebase. */
  commit: string;
  /** git's own summary (trimmed) — e.g. the fast-forward or replay report. */
  output: string;
}

/**
 * `spit rebase <upstream> [dir]` — replay the current branch's snapshots onto
 * `upstream` via real `git rebase`. Clean/linear cases fast-forward or replay
 * without prompting; a conflicting rebase exits non-zero and leaves the rebase in
 * progress (GitError with git's guidance) — spit does not auto-resolve, matching
 * merge's posture. Spotify is never touched. Failure posture matches branch/checkout.
 */
export async function repoRebase(dir: string | undefined, upstream: string): Promise<RebaseResult> {
  const repoDir = resolve(dir ?? '.');

  let meta: SnapshotMeta;
  try {
    meta = JSON.parse(await readFile(join(repoDir, 'meta.json'), 'utf8')) as SnapshotMeta;
  } catch {
    throw new Error(
      `No spit snapshot found in ${repoDir} (meta.json missing). ` +
        'Run `spit init <playlistId>` first.',
    );
  }

  const output = (await gitRebase(repoDir, upstream)).trim();
  const commit = await gitShortHead(repoDir);

  return { repoDir, playlistName: meta.name, commit, output };
}
