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
