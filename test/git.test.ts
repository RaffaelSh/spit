import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gitInit,
  gitAdd,
  gitCommit,
  gitStatus,
  gitLog,
  gitHasStagedChanges,
  gitShortHead,
  gitShow,
  GitError,
} from '../src/git/git.js';

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spit-git-'));
}

test('init → add → commit yields a clean tree and a visible commit', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"t1"}\n', 'utf8');
    await writeFile(join(dir, 'meta.json'), '{"id":"p1"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl', 'meta.json']);
    await gitCommit(dir, 'Initial snapshot: Test Playlist');

    const log = await gitLog(dir);
    assert.match(log, /Initial snapshot: Test Playlist/);

    // After committing everything, the working tree is clean (porcelain empty).
    const status = await gitStatus(dir);
    assert.equal(status.trim(), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('gitStatus reports an untracked file (dirty tree)', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeFile(join(dir, 'meta.json'), '{}', 'utf8');
    const status = await gitStatus(dir);
    assert.ok(status.trim().length > 0, 'untracked file should make the tree dirty');
    assert.match(status, /meta\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Negative path: a failing git invocation must surface a readable GitError with
// git's own stderr attached (diagnosability), not a bare rejection.
test('a failing git invocation raises GitError carrying stderr', async () => {
  const dir = await scratch(); // not a git repo
  try {
    await assert.rejects(
      () => gitLog(dir),
      (err: unknown) => {
        assert.ok(err instanceof GitError, 'expected a GitError');
        assert.ok(err.stderr.length > 0, 'GitError should carry git stderr');
        assert.match(err.message, /git log .*failed/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Negative path: staging a nonexistent pathspec fails loudly (init would catch
// this if a snapshot file were missing before add).
test('gitAdd of a nonexistent path raises GitError', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await assert.rejects(() => gitAdd(dir, ['does-not-exist.jsonl']), GitError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// gitHasStagedChanges must read the exit-1 "has changes" case as `true`, not as
// a failure, and flip back to `false` once those changes are committed.
test('gitHasStagedChanges is true when staged, false after commit', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"t1"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    assert.equal(await gitHasStagedChanges(dir), true, 'staged file should register');

    await gitCommit(dir, 'Initial snapshot');
    assert.equal(await gitHasStagedChanges(dir), false, 'clean index after commit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// gitShortHead returns a clean abbreviated hash for CLI output.
test('gitShortHead returns an abbreviated commit hash', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeFile(join(dir, 'meta.json'), '{"id":"p1"}\n', 'utf8');
    await gitAdd(dir, ['meta.json']);
    await gitCommit(dir, 'Initial snapshot');

    const short = await gitShortHead(dir);
    assert.match(short, /^[0-9a-f]{7,}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// gitShow reads a file's content at a revision — the primitive spit diff needs
// to compare two snapshots without touching the working tree.
test('gitShow returns file content at HEAD after a commit', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"t1"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'Initial snapshot');

    const content = await gitShow(dir, 'HEAD', 'playlist.jsonl');
    // Raw (untrimmed) content — the trailing newline is significant.
    assert.equal(content, '{"id":"t1"}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// gitShow reads history, not the working tree: HEAD~1 must return the OLDER
// content even after a second commit rewrote the file.
test('gitShow reads the older content at HEAD~1 after a second commit', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"t1"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'First snapshot');

    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"t1"}\n{"id":"t2"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'Second snapshot');

    assert.equal(await gitShow(dir, 'HEAD', 'playlist.jsonl'), '{"id":"t1"}\n{"id":"t2"}\n');
    assert.equal(await gitShow(dir, 'HEAD~1', 'playlist.jsonl'), '{"id":"t1"}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Negative path: a non-existent revision fails loudly with a GitError rather
// than silently returning an empty string.
test('gitShow of a non-existent revision raises GitError', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"t1"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'Initial snapshot');

    await assert.rejects(
      () => gitShow(dir, 'deadbeef', 'playlist.jsonl'),
      (err: unknown) => {
        assert.ok(err instanceof GitError, 'expected a GitError');
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
