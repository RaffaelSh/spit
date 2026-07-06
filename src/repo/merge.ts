import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gitMerge } from '../git/git.js';
import type { SnapshotMeta } from '../snapshot/serialize.js';
import type { TrackRecord } from '../spotify/playlists.js';

/**
 * One conflicting track region: the OURS side and the THEIRS side of a single
 * paired line inside a git conflict block. Either side may be null when that
 * line is absent (unequal block lengths) or fails to JSON.parse — a malformed
 * side is reported as null, never silently dropped.
 */
export interface ConflictInfo {
  ours: TrackRecord | null;
  theirs: TrackRecord | null;
}

/** Structured `spit merge <branch>` result, printed by the CLI layer. */
export interface MergeResult {
  repoDir: string;
  merged: boolean;
  playlistName: string;
  conflicts: ConflictInfo[];
}

/**
 * Parse a non-marker playlist.jsonl line into a TrackRecord, or null if it is
 * not valid JSON. A malformed conflict side must surface as a null side in the
 * report rather than throw — the merge itself already succeeded/conflicted at
 * the git layer; a bad line is a rendering fact, not a fatal error.
 */
function parseLine(raw: string): TrackRecord | null {
  try {
    return JSON.parse(raw) as TrackRecord;
  } catch {
    return null;
  }
}

/**
 * Scan working-tree playlist.jsonl for git conflict blocks and pair the two
 * sides index-wise into ConflictInfo entries.
 *
 * A block opens on `<<<<<<< ` (OURS), switches on `=======` (THEIRS), and closes
 * on `>>>>>>> `. Each side may carry multiple lines; they are paired positionally
 * (ours[i]/theirs[i]), padding the shorter side with null. Lines outside any
 * conflict block are the cleanly-merged tracks and are ignored for the report.
 */
function parseConflicts(jsonl: string): ConflictInfo[] {
  const conflicts: ConflictInfo[] = [];
  const lines = jsonl.split('\n');

  let inBlock = false;
  let side: 'ours' | 'theirs' = 'ours';
  let ours: string[] = [];
  let theirs: string[] = [];

  const flush = () => {
    const n = Math.max(ours.length, theirs.length);
    for (let i = 0; i < n; i++) {
      conflicts.push({
        ours: i < ours.length ? parseLine(ours[i]) : null,
        theirs: i < theirs.length ? parseLine(theirs[i]) : null,
      });
    }
    ours = [];
    theirs = [];
  };

  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      inBlock = true;
      side = 'ours';
      continue;
    }
    if (inBlock && line.startsWith('=======')) {
      side = 'theirs';
      continue;
    }
    if (inBlock && line.startsWith('>>>>>>>')) {
      flush();
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;
    if (line.length === 0) continue; // skip blank lines inside a block
    (side === 'ours' ? ours : theirs).push(line);
  }

  return conflicts;
}

/**
 * `spit merge <branch>` — merge `branchName` into the current branch's snapshot.
 *
 * Git does the real line-wise merge of the deterministic playlist.jsonl (D001);
 * duplicates and reorders are safe by construction (D002/D009). A clean merge
 * (fast-forward or a new merge commit) returns `merged: true` with no conflicts.
 * When both branches edit the same track region, git leaves conflict markers in
 * the working-tree playlist.jsonl; we parse those into a per-track ConflictInfo[]
 * so the CLI can report track NAMES, not raw JSON or line numbers (R006).
 *
 * Conflict RESOLUTION (`git merge --continue` / interactive editing) is out of
 * scope for S04 (research C5): on a conflict the user manually edits
 * playlist.jsonl, then `git add` + `git commit`. This helper only surfaces the
 * conflict; it does not resolve or abort it.
 *
 * Failure paths inherit S01's readable posture: not a spit repo → the same
 * "No spit snapshot found … Run `spit init` first." error used by commit.ts; a
 * genuine git failure → GitError carrying git's stderr (gitMerge treats a
 * conflict exit-1 as a signal, not a failure).
 */
export async function repoMerge(
  dir: string | undefined,
  branchName: string,
): Promise<MergeResult> {
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

  const { conflicts } = await gitMerge(repoDir, branchName);

  if (!conflicts) {
    return { repoDir, merged: true, playlistName: meta.name, conflicts: [] };
  }

  // Conflict markers land in the working-tree playlist.jsonl; parse them into a
  // per-track report. meta.name is read from the pre-merge meta.json above (the
  // conflict left playlist.jsonl unmerged, but meta.json may itself be a
  // conflict — we deliberately report the tracked name we already hold).
  const jsonl = await readFile(join(repoDir, 'playlist.jsonl'), 'utf8');
  return { repoDir, merged: false, playlistName: meta.name, conflicts: parseConflicts(jsonl) };
}
