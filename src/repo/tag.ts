import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gitTag, gitTagList } from '../git/git.js';
import type { SnapshotMeta } from '../snapshot/serialize.js';

/** Structured `spit tag [name]` result, printed by the CLI layer. */
export interface TagResult {
  repoDir: string;
  playlistName: string;
  /** The tag just created, or undefined when the command only listed tags. */
  created?: string;
  /** All tags after the operation (git-sort order). */
  tags: string[];
}

/**
 * `spit tag [name] [dir]` — with a name, mark the current snapshot (`git tag
 * <name>`); without one, list existing tags. A duplicate name surfaces GitError
 * with git's stderr. Failure posture matches branch/checkout: not a spit repo →
 * the shared "No spit snapshot found … Run `spit init` first." error.
 */
export async function repoTag(dir: string | undefined, name?: string): Promise<TagResult> {
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

  if (name !== undefined && name.trim() !== '') {
    await gitTag(repoDir, name.trim());
  }
  const tags = await gitTagList(repoDir);

  return {
    repoDir,
    playlistName: meta.name,
    created: name && name.trim() !== '' ? name.trim() : undefined,
    tags,
  };
}
