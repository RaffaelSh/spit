import { resolve } from 'node:path';
import { gitLog } from '../git/git.js';

/** One revision in the snapshot chain, as rendered by `spit log`. */
export interface LogEntry {
  hash: string;
  message: string;
}

/** Structured `spit log` result, printed by the CLI layer. */
export interface LogResult {
  entries: LogEntry[];
}

/**
 * `spit log [dir]` — render the snapshot commit chain (most-recent-first) from
 * the local git history only. No Spotify call.
 *
 * Parses `git log --oneline`: each non-empty line splits on its FIRST space into
 * `{ hash, message }` (the message may be empty). Entries stay in git's order.
 * A not-a-spit-repo / no-history failure surfaces as a GitError from gitLog
 * carrying git's own stderr.
 */
export async function repoLog(dir?: string): Promise<LogResult> {
  const repoDir = resolve(dir ?? '.');
  const stdout = await gitLog(repoDir);

  const entries: LogEntry[] = stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const sp = line.indexOf(' ');
      if (sp === -1) return { hash: line, message: '' };
      return { hash: line.slice(0, sp), message: line.slice(sp + 1) };
    });

  return { entries };
}
