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
  gitBranch,
  gitCheckout,
  gitMerge,
  gitRevert,
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

// gitBranch creates a branch that is subsequently checkout-able — proof the
// branch ref exists (a nonexistent branch would make gitCheckout throw).
test('gitBranch creates a branch that can be checked out', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"t1"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'Initial snapshot');

    await gitBranch(dir, 'feature');
    // If the branch ref is real, checking it out exits 0 (no throw).
    await gitCheckout(dir, 'feature');
    const log = await gitLog(dir);
    assert.match(log, /Initial snapshot/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Negative path: branching onto a name that already exists fails loudly.
test('gitBranch of a duplicate name raises GitError', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"t1"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'Initial snapshot');

    await gitBranch(dir, 'feature');
    await assert.rejects(() => gitBranch(dir, 'feature'), GitError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// gitCheckout switches the working tree between refs: content committed on each
// branch must reappear when that ref is checked out.
test('gitCheckout switches the working tree to the checked-out ref', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"base"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'Base');
    const baseRef = (await gitLog(dir)).split(' ')[0]; // short hash of base

    await gitBranch(dir, 'feature');
    await gitCheckout(dir, 'feature');
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"feature"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'Feature commit');

    // Feature ref has the feature content.
    assert.equal(await gitShow(dir, 'HEAD', 'playlist.jsonl'), '{"id":"feature"}\n');

    // Back to the base commit → the working tree reverts to the base content.
    await gitCheckout(dir, baseRef);
    assert.equal(await gitShow(dir, 'HEAD', 'playlist.jsonl'), '{"id":"base"}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Negative path: checking out a ref that doesn't exist fails loudly.
test('gitCheckout of an invalid ref raises GitError', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"t1"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'Initial snapshot');

    await assert.rejects(() => gitCheckout(dir, 'no-such-ref'), GitError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Fast-forward merge: feature is strictly ahead of main, so merging it just
// advances HEAD (no merge commit, no identity needed) and reports no conflict.
test('gitMerge fast-forwards a strictly-ahead branch without conflict', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"c1"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'C1');
    const main = (await gitLog(dir)).split(' ')[0];

    await gitBranch(dir, 'feature');
    await gitCheckout(dir, 'feature');
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"c1"}\n{"id":"c2"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'C2');

    await gitCheckout(dir, main); // detached at main's commit
    const before = (await gitLog(dir)).trim().split('\n').length;

    const result = await gitMerge(dir, 'feature');
    assert.equal(result.conflicts, false, 'fast-forward should not conflict');

    const after = (await gitLog(dir)).trim().split('\n').length;
    assert.ok(after > before, 'HEAD should advance past the merged commit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Conflicting merge: both sides rewrote line 1 from a common base. gitMerge must
// SIGNAL the conflict ({ conflicts: true }) rather than throw, and leave conflict
// markers in the working-tree file.
test('gitMerge signals conflicts (no throw) and writes conflict markers', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"base"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'Base');

    await gitBranch(dir, 'feature'); // feature ref pinned at Base
    // Diverge main.
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"main-edit"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'Main edit');
    const main = (await gitLog(dir)).split(' ')[0]; // hash of the main-edit tip

    // Diverge feature from the same base.
    await gitCheckout(dir, 'feature');
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"feature-edit"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'Feature edit');

    await gitCheckout(dir, main);
    const result = await gitMerge(dir, 'feature');
    assert.equal(result.conflicts, true, 'divergent edits must conflict');

    const { readFile } = await import('node:fs/promises');
    const content = await readFile(join(dir, 'playlist.jsonl'), 'utf8');
    assert.match(content, /<<<<<<< HEAD/, 'working tree should carry conflict markers');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// gitRevert creates an inverse commit (history grows by one) and restores the
// file content to its pre-reverted state.
test('gitRevert adds an inverse commit and restores prior content', async () => {
  const dir = await scratch();
  try {
    await gitInit(dir);
    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"c1"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'C1');

    await writeFile(join(dir, 'playlist.jsonl'), '{"id":"c1"}\n{"id":"c2"}\n', 'utf8');
    await gitAdd(dir, ['playlist.jsonl']);
    await gitCommit(dir, 'C2');

    const before = (await gitLog(dir)).trim().split('\n').length;
    await gitRevert(dir, 'HEAD');
    const after = (await gitLog(dir)).trim().split('\n').length;
    assert.equal(after, before + 1, 'revert should add exactly one commit');

    // Reverting C2 restores the C1 content.
    assert.equal(await gitShow(dir, 'HEAD', 'playlist.jsonl'), '{"id":"c1"}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
