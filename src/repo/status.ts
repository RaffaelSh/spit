import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gitStatus } from '../git/git.js';
import type { SnapshotMeta } from '../snapshot/serialize.js';

/** Structured `spit status` result, printed by the CLI layer. */
export interface StatusResult {
  repoDir: string;
  meta: SnapshotMeta;
  trackCount: number;
  clean: boolean;
  porcelain: string;
}

/**
 * `spit status [dir]` — summarize the LOCAL snapshot + git state only.
 *
 * Scope note (S01): status never contacts Spotify. It reports the tracked
 * playlist (from meta.json), the local track count (playlist.jsonl lines), and
 * the git working-tree state. Live local-vs-Spotify comparison is `pull`/
 * `fetch`/`diff` in later slices.
 *
 * A missing snapshot (not a spit repo) surfaces a readable, actionable error
 * rather than a raw ENOENT.
 */
export async function repoStatus(dir?: string): Promise<StatusResult> {
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

  let jsonl: string;
  try {
    jsonl = await readFile(join(repoDir, 'playlist.jsonl'), 'utf8');
  } catch {
    throw new Error(
      `Snapshot in ${repoDir} is corrupt: meta.json exists but playlist.jsonl is missing.`,
    );
  }
  const trackCount = jsonl.split('\n').filter((line) => line.length > 0).length;

  const porcelain = await gitStatus(repoDir);
  const clean = porcelain.trim().length === 0;

  return { repoDir, meta, trackCount, clean, porcelain };
}
