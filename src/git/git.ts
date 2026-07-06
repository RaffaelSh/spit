import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Fallback commit identity, used ONLY when the ambient git config has no
 * user.name / user.email (fresh CI checkouts, throwaway snapshot repos). When
 * the user has a real global identity it wins — we never clobber it.
 */
const FALLBACK_IDENTITY = ['-c', 'user.name=spit', '-c', 'user.email=spit@localhost'];

/** Non-zero `git` exit (or a missing binary) surfaced with stderr attached. */
export class GitError extends Error {
  readonly exitCode: number | string | null;
  readonly stderr: string;
  constructor(args: string[], exitCode: number | string | null, stderr: string) {
    super(`git ${args.join(' ')} failed (exit ${exitCode ?? 'null'}): ${stderr.trim()}`);
    this.name = 'GitError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Run the real `git` binary (D001 — never reimplement git). Args are passed as
 * an array to execFile, so nothing is shell-interpolated; a playlist name in a
 * commit message can never break out into a shell. Non-zero exits and a missing
 * binary both raise GitError with git's own stderr for diagnosability.
 */
async function git(dir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: dir,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { code?: number | string; stderr?: string | Buffer; message?: string };
    const stderr = e.stderr != null ? e.stderr.toString() : (e.message ?? '');
    throw new GitError(args, e.code ?? null, stderr);
  }
}

/** `git init` in `dir` (dir must already exist). */
export function gitInit(dir: string): Promise<string> {
  return git(dir, ['init']);
}

/** Stage the given paths. `--` terminates options so odd paths are never flags. */
export function gitAdd(dir: string, paths: string[]): Promise<string> {
  return git(dir, ['add', '--', ...paths]);
}

/**
 * Commit staged changes with `message`. If git has no configured identity,
 * retry once with a fallback identity rather than failing outright — this keeps
 * `spit init` working on machines that have never run `git config`.
 */
export async function gitCommit(dir: string, message: string): Promise<string> {
  try {
    return await git(dir, ['commit', '-m', message]);
  } catch (err) {
    if (
      err instanceof GitError &&
      /identity unknown|Please tell me who you are|unable to auto-detect email|empty ident/i.test(
        err.stderr,
      )
    ) {
      return git(dir, [...FALLBACK_IDENTITY, 'commit', '-m', message]);
    }
    throw err;
  }
}

/** Porcelain working-tree status (stable, machine-readable output). */
export function gitStatus(dir: string): Promise<string> {
  return git(dir, ['status', '--porcelain']);
}

/** One-line-per-commit history (most recent first). */
export function gitLog(dir: string): Promise<string> {
  return git(dir, ['log', '--oneline']);
}

/**
 * True when there are staged (index vs HEAD) changes, false when the index is
 * clean — the signal that decides "commit" vs "no-op snapshot".
 *
 * Deliberately NOT routed through the private `git()` helper: `git diff
 * --cached --quiet` communicates its answer through the exit code (0 = no
 * staged changes, 1 = staged changes exist), and `git()` would misread the
 * normal exit-1 as a GitError. We inspect `.code` ourselves and only raise
 * GitError on a genuine failure (exit ≥ 2, or a missing binary).
 */
export async function gitHasStagedChanges(dir: string): Promise<boolean> {
  const args = ['diff', '--cached', '--quiet'];
  try {
    await execFileAsync('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    return false; // exit 0 ⇒ no staged changes
  } catch (err) {
    const e = err as { code?: number | string; stderr?: string | Buffer; message?: string };
    if (e.code === 1) return true; // exit 1 ⇒ staged changes exist
    const stderr = e.stderr != null ? e.stderr.toString() : (e.message ?? '');
    throw new GitError(args, e.code ?? null, stderr);
  }
}

/** Short (abbreviated) hash of HEAD — a clean commit id for CLI output. */
export async function gitShortHead(dir: string): Promise<string> {
  const stdout = await git(dir, ['rev-parse', '--short', 'HEAD']);
  return stdout.trim();
}

/**
 * Read a file's content at a revision (`git show <rev>:<file>`) — used by spit
 * diff to compare two snapshots. Returned stdout is NOT trimmed: playlist.jsonl
 * is newline-significant and the diff parser splits on '\n'. A missing revision
 * or file makes git exit non-zero, which `git()` already turns into a GitError
 * carrying git's stderr.
 */
export function gitShow(dir: string, rev: string, file: string): Promise<string> {
  return git(dir, ['show', `${rev}:${file}`]);
}

/** stderr signatures git emits when it has no configured author identity. */
const IDENTITY_RE =
  /identity unknown|Please tell me who you are|unable to auto-detect email|empty ident/i;

/**
 * Create a branch (`git branch <name>`). A duplicate name exits non-zero, which
 * `git()` turns into a GitError carrying git's stderr — the caller decides how to
 * report it. Return stdout (git branch is normally silent on success).
 */
export function gitBranch(dir: string, branchName: string): Promise<string> {
  return git(dir, ['branch', branchName]);
}

/**
 * Switch the working tree to `ref` (`git checkout <ref>`). An invalid ref exits
 * non-zero → GitError. Checking out a bare commit detaches HEAD: git prints an
 * advisory to stderr but exits 0, so that is a normal (non-error) return here;
 * surfacing the advisory is the repo layer's job, not this primitive's.
 */
export function gitCheckout(dir: string, ref: string): Promise<string> {
  return git(dir, ['checkout', ref]);
}

/**
 * Current branch name via `git rev-parse --abbrev-ref HEAD`, trimmed. Returns the
 * literal string `HEAD` when the working tree is in detached-HEAD state (e.g.
 * after checking out a bare commit) — the repo layer uses that to raise the
 * detached-HEAD advisory.
 */
export async function gitCurrentBranch(dir: string): Promise<string> {
  const stdout = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
}

/**
 * Merge `branchName` into the current branch. Deliberately NOT routed through the
 * private `git()` helper: a merge conflict exits 1, and `git()` would misread
 * that normal outcome as a GitError. We inspect `.code` ourselves:
 *   exit 0 → clean merge (fast-forward or a new merge commit)
 *   exit 1 → conflicts in the working tree (a signal, NOT a failure — no throw)
 *   other  → a genuine failure (GitError)
 *
 * A clean divergent merge writes a merge commit, which can hit "Author identity
 * unknown" on a config-less CI checkout; we detect that stderr signature and
 * retry once with a fallback identity (same shape as gitCommit), then re-apply
 * the same exit-0/exit-1 logic.
 */
export async function gitMerge(
  dir: string,
  branchName: string,
): Promise<{ conflicts: boolean; output: string }> {
  const run = (args: string[]) =>
    execFileAsync('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 });

  const classify = (err: unknown): { conflicts: boolean; output: string } => {
    const e = err as {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    if (e.code === 1) {
      const out = (e.stdout != null ? e.stdout.toString() : '') +
        (e.stderr != null ? e.stderr.toString() : '');
      return { conflicts: true, output: out };
    }
    throw err;
  };

  try {
    const { stdout } = await run(['merge', branchName]);
    return { conflicts: false, output: stdout };
  } catch (err) {
    const e = err as { code?: number | string; stderr?: string | Buffer; message?: string };
    const stderr = e.stderr != null ? e.stderr.toString() : (e.message ?? '');
    // No configured identity for the merge commit → retry once with a fallback.
    if (IDENTITY_RE.test(stderr)) {
      try {
        const { stdout } = await run([...FALLBACK_IDENTITY, 'merge', branchName]);
        return { conflicts: false, output: stdout };
      } catch (retryErr) {
        try {
          return classify(retryErr);
        } catch (fatal) {
          const r = fatal as { code?: number | string; stderr?: string | Buffer; message?: string };
          throw new GitError(
            ['merge', branchName],
            r.code ?? null,
            r.stderr != null ? r.stderr.toString() : (r.message ?? ''),
          );
        }
      }
    }
    try {
      return classify(err);
    } catch {
      throw new GitError(['merge', branchName], e.code ?? null, stderr);
    }
  }
}

/**
 * Revert `ref` by creating an inverse commit. `--no-edit` keeps git from opening
 * an editor for the auto-generated message. Because it commits, it can hit the
 * config-less "Author identity unknown" case, so — like gitCommit — retry once
 * with a fallback identity when git's stderr matches the identity signature.
 */
export async function gitRevert(dir: string, ref: string): Promise<string> {
  try {
    return await git(dir, ['revert', '--no-edit', ref]);
  } catch (err) {
    if (err instanceof GitError && IDENTITY_RE.test(err.stderr)) {
      return git(dir, [...FALLBACK_IDENTITY, 'revert', '--no-edit', ref]);
    }
    throw err;
  }
}
