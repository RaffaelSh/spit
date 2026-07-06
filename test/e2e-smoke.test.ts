import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serializeTrackLine } from '../src/snapshot/serialize.js';
import { WRITE_DISABLED_MESSAGE } from '../src/repo/write-config.js';
import type { TrackRecord } from '../src/spotify/playlists.js';

// Offline end-to-end smoke over the BUILT binary (dist/cli.js, not tsx). Every
// git-side subcommand is green per-unit; this proves they compose over one real
// git history through the shipped CLI. Zero network: we never run
// login/init/commit/push-with-writes against Spotify — the two managed files are
// hand-seeded at repo ROOT and committed with the real `git` binary directly,
// because spit's own `commit` re-reads the live playlist (MEM010) and cannot run
// offline. The live Spotify legs (R013) are deferred to human UAT.

const CLI = resolve(process.cwd(), 'dist/cli.js');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Drive the built CLI in `cwd`. Resolves (never rejects) with the exit code so
 *  assertions can check non-zero exits explicitly. */
function spit(args: string[], cwd: string): Promise<Run> {
  return new Promise((resolvePromise) => {
    execFile('node', [CLI, ...args], { cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as { code?: unknown }).code === 'number'
          ? ((err as { code: number }).code)
          : err
            ? 1
            : 0;
      resolvePromise({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/** Run the real `git` binary directly (seed commits, identity, ref capture). */
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed: ${stderr || (err as Error).message}`));
      else resolvePromise(stdout ?? '');
    });
  });
}

// Base tracks A, B, C plus the per-line replacements used to drive diff/merge.
// Each name is distinct (and no name is a line-anchored prefix of another) so
// the `- ` / `+ ` diff lines and the restored snapshots are unambiguous.
const A: TrackRecord = { id: 'a', uri: 'spotify:track:a', name: 'Alpha', artists: ['ArtistA'], album: 'AlbumA', duration_ms: 180000 };
const A2: TrackRecord = { id: 'a2', uri: 'spotify:track:a2', name: 'AlphaTwo', artists: ['ArtistA2'], album: 'AlbumA2', duration_ms: 181000 };
const A3: TrackRecord = { id: 'a3', uri: 'spotify:track:a3', name: 'AlphaThree', artists: ['ArtistA3'], album: 'AlbumA3', duration_ms: 182000 };
const B: TrackRecord = { id: 'b', uri: 'spotify:track:b', name: 'Bravo', artists: ['ArtistB'], album: 'AlbumB', duration_ms: 200000 };
const C: TrackRecord = { id: 'c', uri: 'spotify:track:c', name: 'Charlie', artists: ['ArtistC'], album: 'AlbumC', duration_ms: 220000 };
const C2: TrackRecord = { id: 'c2', uri: 'spotify:track:c2', name: 'CharlieTwo', artists: ['ArtistC2'], album: 'AlbumC2', duration_ms: 221000 };
const D: TrackRecord = { id: 'd', uri: 'spotify:track:d', name: 'Delta', artists: ['ArtistD'], album: 'AlbumD', duration_ms: 240000 };

const META = { id: 'pl1', name: 'Smoke', description: '' };

/** Write playlist.jsonl at repo ROOT using the canonical per-track line form —
 *  the exact bytes serializeTrackLine emits, each newline-terminated. */
async function writePlaylist(dir: string, tracks: TrackRecord[]): Promise<void> {
  const jsonl = tracks.map((t) => serializeTrackLine(t) + '\n').join('');
  await writeFile(join(dir, 'playlist.jsonl'), jsonl, 'utf8');
}

async function commitAll(dir: string, message: string): Promise<void> {
  await git(['add', '-A'], dir);
  await git(['commit', '-m', message], dir);
}

test('offline E2E: git-side subcommands compose over one real history via dist/cli.js', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spit-e2e-'));
  try {
    // 1-2. Scratch repo with a committed identity + the first snapshot [A, B, C].
    await git(['init'], dir);
    await git(['config', 'user.email', 'smoke@spit.local'], dir);
    await git(['config', 'user.name', 'Spit Smoke'], dir);

    await writeFile(join(dir, 'meta.json'), JSON.stringify(META), 'utf8');
    await writePlaylist(dir, [A, B, C]);
    await commitAll(dir, 'first snapshot');
    // Capture the branch name after the first commit — a fresh repo has an
    // unborn HEAD that `rev-parse --abbrev-ref HEAD` cannot resolve.
    const baseBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim();
    const firstCommit = (await git(['rev-parse', 'HEAD'], dir)).trim();

    // 3. Second commit changes the FIRST line only (A → A2); B and C untouched.
    await writePlaylist(dir, [A2, B, C]);
    await commitAll(dir, 'change first track');

    // spit log → exactly two entries, each "<hash>  <message>", exit 0.
    const log = await spit(['log'], dir);
    assert.strictEqual(log.code, 0, 'spit log exits 0');
    const logLines = log.stdout.split('\n').filter((l) => l.length > 0);
    assert.strictEqual(logLines.length, 2, 'two commits in the chain');
    assert.match(log.stdout, /change first track/, 'newest commit message present');
    assert.match(log.stdout, /first snapshot/, 'oldest commit message present');

    // spit diff (HEAD~1..HEAD) → the first-track change: - Alpha / + AlphaTwo.
    const diff = await spit(['diff'], dir);
    assert.strictEqual(diff.code, 0, 'spit diff exits 0');
    assert.match(diff.stdout, /^- Alpha$/m, 'removed line for the old first track');
    assert.match(diff.stdout, /^\+ AlphaTwo$/m, 'added line for the new first track');

    // 4. Branch + divergent history engineered for a DETERMINISTIC clean merge:
    // experiment edits the LAST line, base edits the FIRST line, and the MIDDLE
    // line (B) stays unchanged between them so the edited regions never overlap.
    const branch = await spit(['branch', 'experiment'], dir);
    assert.strictEqual(branch.code, 0, 'spit branch exits 0');
    assert.match(branch.stdout, /Created branch/, 'branch creation reported');

    const coExp = await spit(['checkout', 'experiment'], dir);
    assert.strictEqual(coExp.code, 0, 'spit checkout experiment exits 0');
    assert.doesNotMatch(coExp.stdout, /detached/, 'a branch checkout stays attached');

    await writePlaylist(dir, [A2, B, C2]); // experiment: LAST line C → C2
    await commitAll(dir, 'experiment: change last track');

    const coBase = await spit(['checkout', baseBranch], dir);
    assert.strictEqual(coBase.code, 0, 'spit checkout base exits 0');

    await writePlaylist(dir, [A3, B, C]); // base: FIRST line A2 → A3
    await commitAll(dir, 'base: change first track again');

    const merge = await spit(['merge', 'experiment'], dir);
    assert.strictEqual(merge.code, 0, 'clean merge exits 0');
    assert.match(merge.stdout, /^Merged experiment cleanly\.$/m, 'clean-merge message');

    // 5. Checkout a bare earlier commit → detached HEAD, 3-track snapshot restored.
    const coCommit = await spit(['checkout', firstCommit], dir);
    assert.strictEqual(coCommit.code, 0, 'checkout of a bare commit exits 0');
    assert.match(coCommit.stdout, /tracks:\s+3/, 'restored snapshot reports 3 tracks');
    assert.match(coCommit.stdout, /HEAD is detached/, 'bare-commit checkout warns HEAD detached');
    // Reattach to the base branch before continuing.
    const reattach = await spit(['checkout', baseBranch], dir);
    assert.strictEqual(reattach.code, 0, 'reattach to base exits 0');

    // 6. Revert. gitRevert issues `git revert --no-edit <ref>` with no -m, so a
    // merge commit cannot be reverted; add one plain commit first, then revert
    // that non-merge HEAD (its exact inverse — always a clean revert).
    await writePlaylist(dir, [A3, B, C2, D]); // append a 4th track
    await commitAll(dir, 'append delta');
    const revert = await spit(['revert', 'HEAD'], dir);
    assert.strictEqual(revert.code, 0, 'spit revert HEAD exits 0');
    assert.match(revert.stdout, /Reverted/, 'revert reports the reverted ref');
    assert.match(revert.stdout, /new commit/, 'revert reports the new inverse commit');

    // 7. push gate (NO network, NO --enable-writes): a display-only repo rejects
    // the write BEFORE any git/Spotify read (push.ts checks readWriteMode first).
    const push = await spit(['push', '--yes'], dir);
    assert.strictEqual(push.code, 1, 'display-only push --yes exits 1');
    assert.ok(
      push.stderr.includes(WRITE_DISABLED_MESSAGE),
      `push rejection prints the write-disabled message; got: ${push.stderr}`,
    );
    const pushHelp = await spit(['push', '--help'], dir);
    assert.strictEqual(pushHelp.code, 0, 'spit push --help exits 0');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
