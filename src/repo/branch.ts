import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gitBranch } from '../git/git.js';
import type { SnapshotMeta } from '../snapshot/serialize.js';

/** Structured `spit branch <name>` result, printed by the CLI layer. */
export interface BranchResult {
  repoDir: string;
  branch: string;
  playlistName: string;
}

/**
 * `spit branch <name> [dir]` — create a new branch pointing at the current HEAD,
 * matching `git branch <name>`: the branch is created but NOT checked out.
 *
 * Failure paths inherit S01's readable posture: not a spit repo → the same
 * "No spit snapshot found … Run `spit init` first." error as commit/status;
 * a duplicate branch name → GitError carrying git's stderr.
 */
export async function repoBranch(
  dir: string | undefined,
  branchName: string,
): Promise<BranchResult> {
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
  const meta = JSON.parse(metaRaw) as SnapshotMeta;

  await gitBranch(repoDir, branchName);

  return { repoDir, branch: branchName, playlistName: meta.name };
}
