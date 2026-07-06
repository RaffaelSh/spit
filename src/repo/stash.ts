import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gitStash, gitStashPop, GitError } from '../git/git.js';
import type { SnapshotMeta } from '../snapshot/serialize.js';

/** Structured `spit stash` / `spit stash pop` result, printed by the CLI layer. */
export interface StashResult {
  repoDir: string;
  playlistName: string;
  action: 'save' | 'pop';
  /** git's own one-line summary (trimmed). */
  message: string;
  /** true when `spit stash` ran with a clean working tree (nothing to save). */
  noOp: boolean;
}

/**
 * `spit stash [dir]` (save) / `spit stash pop [dir]` (restore) — shelve or restore
 * uncommitted edits to the working snapshot (playlist.jsonl / meta.json) via real
 * `git stash`. Spotify is never touched. Save on a clean tree is a no-op, not an
 * error (git prints "No local changes to save"); pop on an empty stash surfaces a
 * readable message. Failure posture matches branch/checkout.
 */
export async function repoStash(
  dir: string | undefined,
  action: 'save' | 'pop',
): Promise<StashResult> {
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

  if (action === 'save') {
    const out = (await gitStash(repoDir)).trim();
    const noOp = /no local changes to save/i.test(out);
    return { repoDir, playlistName: meta.name, action, message: out, noOp };
  }

  try {
    const out = (await gitStashPop(repoDir)).trim();
    return { repoDir, playlistName: meta.name, action, message: out, noOp: false };
  } catch (err) {
    if (err instanceof GitError && /no stash entries|no stash found/i.test(err.stderr)) {
      throw new Error('Nothing to restore — the stash is empty.');
    }
    throw err;
  }
}
