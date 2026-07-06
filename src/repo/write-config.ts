import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Actionable message shown when a push is attempted on a repo that has not
 * opted into write-back. T04/T05 reuse this verbatim so the display-only gate
 * speaks with one voice (R009 — write-back is opt-in, default display-only).
 */
export const WRITE_DISABLED_MESSAGE =
  'Write-back is disabled for this repo (display-only). Enable it once with: spit push --enable-writes';

/**
 * Fail-closed read of the per-repo write-mode gate (R009, D011). Reads the
 * un-versioned `<repoDir>/.spit/config.json` and returns `true` ONLY when it
 * parses and `writeMode === true`. Every other outcome — file missing,
 * unreadable, malformed JSON, or `writeMode` absent/false — returns `false`
 * (display-only). This never throws: absence is the default, not an error, so a
 * fresh repo with no config is display-only and a corrupt config cannot flip
 * the gate open.
 */
export async function readWriteMode(repoDir: string): Promise<boolean> {
  try {
    const raw = await readFile(join(repoDir, '.spit', 'config.json'), 'utf8');
    const config = JSON.parse(raw) as { writeMode?: unknown };
    return config.writeMode === true;
  } catch {
    return false;
  }
}

/**
 * Ensure `.gitignore` in `repoDir` contains every entry in `entries`, appending
 * only the ones that are missing (idempotent). Existing, unrelated lines are
 * preserved. Written back with a trailing newline. A missing `.gitignore` is
 * created from just the required entries.
 */
async function ensureGitignoreEntries(repoDir: string, entries: string[]): Promise<void> {
  const gitignorePath = join(repoDir, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf8');
  } catch {
    existing = '';
  }

  const present = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = entries.filter((e) => !present.has(e));
  if (missing.length === 0 && existing !== '') return;

  const base = existing === '' ? '' : existing.replace(/\n+$/, '') + '\n';
  const addition = missing.join('\n');
  const next = base + (addition === '' ? '' : addition + '\n');
  await writeFile(gitignorePath, next, 'utf8');
}

/**
 * One-time, visible opt-in to write-back (R009, D011). Writes
 * `<repoDir>/.spit/config.json` with `{ writeMode: true }` and ensures
 * `.gitignore` ignores BOTH `.spit/` and `.gitignore` itself (self-ignoring),
 * so the config file and the ignore file both stay untracked and `git status`
 * stays clean. Idempotent: re-running does not duplicate `.gitignore` lines or
 * clobber unrelated content.
 */
export async function enableWrites(repoDir: string): Promise<void> {
  await mkdir(join(repoDir, '.spit'), { recursive: true });
  await writeFile(
    join(repoDir, '.spit', 'config.json'),
    JSON.stringify({ writeMode: true }, null, 2) + '\n',
    'utf8',
  );
  await ensureGitignoreEntries(repoDir, ['.spit/', '.gitignore']);
}
