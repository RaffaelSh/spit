#!/usr/bin/env node
import { Command } from 'commander';
import { runOAuthFlow, requireClientId } from './auth/oauth.js';
import { saveTokens, TOKEN_PATH } from './auth/token-store.js';
import { initRepo } from './repo/init.js';
import { commitSnapshot } from './repo/commit.js';
import { repoStatus } from './repo/status.js';
import { repoLog } from './repo/log.js';
import { repoDiff } from './repo/diff.js';
import { repoBranch } from './repo/branch.js';
import { repoMerge } from './repo/merge.js';
import { repoCheckout } from './repo/checkout.js';
import { repoRevert } from './repo/revert.js';
import { repoPull } from './repo/pull.js';
import { pushSnapshot, PushError } from './repo/push.js';
import type { ChangeSummary } from './repo/push.js';
import type { TrackRecord } from './spotify/playlists.js';

/** Render a track by name, falling back to uri / id / a "(local track)" marker. */
const trackLabel = (t: TrackRecord): string =>
  t.name ?? t.uri ?? t.id ?? '(local track)';

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// --- Spotify auth assumptions (consumed by T02) ---
// The registered Spotify redirect URI defaults to http://127.0.0.1:8888/callback.
// The Spotify Client ID is supplied via the SPOTIFY_CLIENT_ID environment variable.
// PKCE is used, so no client secret is required.
export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8888/callback';
export const SPOTIFY_CLIENT_ID_ENV = 'SPOTIFY_CLIENT_ID';

const program = new Command();

program
  .name('spit')
  .description('Spotify playlist-in-terminal CLI')
  .version('0.1.0');

program
  .command('login')
  .description('Authenticate with Spotify (PKCE)')
  .action(async () => {
    try {
      const clientId = requireClientId();
      const tokens = await runOAuthFlow(clientId);
      await saveTokens(tokens);
      console.log(`\nLogin successful. Token cached at ${TOKEN_PATH} (0600).`);
    } catch (err) {
      console.error(`\nlogin failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('init')
  .description('Snapshot a Spotify playlist into a new spit (git) repo')
  .argument('<playlistId>', 'Spotify playlist id, spotify: URI, or open.spotify.com URL')
  .argument('[dir]', 'target directory (default: the playlist name)')
  .action(async (playlistId: string, dir: string | undefined) => {
    try {
      const res = await initRepo(playlistId, dir);
      console.log(`\nInitialized spit repo for "${res.playlistName}"`);
      console.log(`  path:   ${res.repoDir}`);
      console.log(`  tracks: ${res.trackCount}`);
      console.log(`  commit: ${res.commit}`);
    } catch (err) {
      console.error(`\ninit failed: ${errMsg(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('commit')
  .description('Re-snapshot the tracked playlist and record a new revision if it changed')
  .argument('[dir]', 'repo directory (default: current directory)')
  .requiredOption('-m, --message <message>', 'commit message')
  .action(async (dir: string | undefined, opts: { message: string }) => {
    try {
      const res = await commitSnapshot(dir, { message: opts.message });
      if (!res.changed) {
        console.log('No changes since last snapshot.');
        return;
      }
      console.log(`\nCommitted new snapshot for "${res.playlistName}"`);
      console.log(`  path:   ${res.repoDir}`);
      console.log(`  tracks: ${res.trackCount}`);
      console.log(`  commit: ${res.commit}`);
    } catch (err) {
      console.error(`\ncommit failed: ${errMsg(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('pull')
  .description('Re-read the live Spotify playlist into the working tree (no commit)')
  .argument('[dir]', 'repo directory (default: current directory)')
  .action(async (dir: string | undefined) => {
    try {
      const res = await repoPull(dir);
      if (!res.changed) {
        console.log(`Already up to date with "${res.playlistName}" (${res.trackCount} tracks).`);
        return;
      }
      console.log(`\nPulled live state of "${res.playlistName}" into the working tree.`);
      console.log(`  path:   ${res.repoDir}`);
      console.log(`  tracks: ${res.trackCount}`);
      console.log('  next:   review with `spit diff` / `spit status`, then `spit commit -m ...`.');
    } catch (err) {
      console.error(`pull failed: ${errMsg(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('status')
  .description('Show the local snapshot + git state of a spit repo')
  .argument('[dir]', 'repo directory (default: current directory)')
  .action(async (dir: string | undefined) => {
    try {
      const res = await repoStatus(dir);
      console.log(`playlist: ${res.meta.name} (${res.meta.id})`);
      console.log(`tracks:   ${res.trackCount}`);
      console.log(`repo:     ${res.repoDir}`);
      if (res.clean) {
        console.log('git:      clean (working tree matches the last snapshot)');
      } else {
        console.log('git:      dirty — uncommitted changes:');
        for (const line of res.porcelain.trimEnd().split('\n')) {
          console.log(`  ${line}`);
        }
      }
    } catch (err) {
      console.error(`status failed: ${errMsg(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('log')
  .description('Show the snapshot commit chain (most recent first)')
  .argument('[dir]', 'repo directory (default: current directory)')
  .action(async (dir: string | undefined) => {
    try {
      const res = await repoLog(dir);
      if (res.entries.length === 0) {
        console.log('No commits yet.');
        return;
      }
      for (const entry of res.entries) {
        console.log(`${entry.hash}  ${entry.message}`);
      }
    } catch (err) {
      console.error(`log failed: ${errMsg(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('diff')
  .description('Show added/removed/moved tracks between two snapshots')
  .argument('[dir]', 'repo directory (default: current directory)')
  .argument('[rev1]', 'base revision (default: HEAD~1)')
  .argument('[rev2]', 'compare revision (default: HEAD)')
  .action(async (dir: string | undefined, rev1: string | undefined, rev2: string | undefined) => {
    try {
      const res = await repoDiff(dir, rev1, rev2);
      if (res.metaOnly) {
        console.log('No track changes (metadata may differ).');
        return;
      }
      for (const t of res.removed) {
        console.log(`- ${trackLabel(t)}`);
      }
      for (const t of res.added) {
        console.log(`+ ${trackLabel(t)}`);
      }
      for (const m of res.moved) {
        console.log(`~ ${trackLabel(m.track)} (${m.fromIndex}→${m.toIndex})`);
      }
    } catch (err) {
      console.error(`diff failed: ${errMsg(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('branch')
  .description('Create a new branch pointing at the current snapshot (not checked out)')
  .argument('<name>', 'new branch name')
  .argument('[dir]', 'repo directory (default: current directory)')
  .action(async (name: string, dir: string | undefined) => {
    try {
      const res = await repoBranch(dir, name);
      console.log(`Created branch "${res.branch}" in "${res.playlistName}"`);
    } catch (err) {
      console.error(`branch failed: ${errMsg(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('merge')
  .description('Merge a branch into the current snapshot (git-driven, no auto-resolve)')
  .argument('<branch>', 'branch to merge into the current branch')
  .argument('[dir]', 'repo directory (default: current directory)')
  .action(async (branch: string, dir: string | undefined) => {
    try {
      const res = await repoMerge(dir, branch);
      if (res.merged) {
        console.log(`Merged ${branch} cleanly.`);
        return;
      }
      console.error('Merge produced conflicts — resolve playlist.jsonl, then git add + git commit:');
      for (const c of res.conflicts) {
        const ours = c.ours ? trackLabel(c.ours) : '(missing)';
        const theirs = c.theirs ? trackLabel(c.theirs) : '(missing)';
        console.error(`  <<< ours: ${ours}  |  theirs: ${theirs} >>>`);
      }
      process.exitCode = 1;
    } catch (err) {
      console.error(`merge failed: ${errMsg(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('checkout')
  .description('Restore an earlier snapshot into the local working tree')
  .argument('<ref>', 'branch, tag, or commit to check out')
  .argument('[dir]', 'repo directory (default: current directory)')
  .action(async (ref: string, dir: string | undefined) => {
    try {
      const res = await repoCheckout(dir, ref);
      console.log(`Checked out ${res.ref} (${res.commit})`);
      console.log(`  playlist: ${res.playlistName}`);
      console.log(`  tracks:   ${res.trackCount}`);
      if (res.detached) {
        console.log(`  warning:  HEAD is detached at ${res.commit}`);
      }
    } catch (err) {
      console.error(`checkout failed: ${errMsg(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('revert')
  .description('Undo a revision by creating its inverse commit (local snapshot only)')
  .argument('<ref>', 'revision to revert')
  .argument('[dir]', 'repo directory (default: current directory)')
  .action(async (ref: string, dir: string | undefined) => {
    try {
      const res = await repoRevert(dir, ref);
      console.log(`Reverted ${res.ref} → new commit ${res.commit}`);
      console.log(`  playlist: ${res.playlistName}`);
      console.log(`  tracks:   ${res.trackCount}`);
      console.log('  note:     restored the local snapshot only — Spotify unchanged until `spit push`.');
    } catch (err) {
      console.error(`revert failed: ${errMsg(err)}`);
      process.exitCode = 1;
    }
  });

/** Read one line from stdin, resolving true only for an exact 'y'/'Y'. */
const promptYes = (question: string): Promise<boolean> =>
  new Promise((resolvePrompt) => {
    // Local import keeps readline off the hot path for every non-push command.
    import('node:readline').then(({ createInterface }) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        const a = answer.trim();
        resolvePrompt(a === 'y' || a === 'Y');
      });
    });
  });

/** Render the R008 pre-warning: "This push will change N tracks: +A added, -R removed, ~M moved to "<name>". Continue? [y/N] " */
const pushWarning = (s: ChangeSummary, playlistName: string): string => {
  const n = s.added + s.removed + s.moved;
  return (
    `This push will change ${n} tracks: ` +
    `+${s.added} added, -${s.removed} removed, ~${s.moved} moved ` +
    `to "${playlistName}". Continue? [y/N] `
  );
};

program
  .command('push')
  .description('Write a committed snapshot back to the live Spotify playlist (opt-in, display-only by default)')
  .argument('[dir]', 'repo directory (default: current directory)')
  .option('--commit <hash>', 'commit to push (default: HEAD)')
  .option('--enable-writes', 'one-time opt-in: enable write-back for this repo')
  .option('--yes', 'skip the confirmation prompt (for CI)')
  .action(
    async (
      dir: string | undefined,
      opts: { commit?: string; enableWrites?: boolean; yes?: boolean },
    ) => {
      try {
        const res = await pushSnapshot(dir, {
          commit: opts.commit,
          enableWrites: opts.enableWrites,
          force: opts.yes,
          confirm: (summary, playlistName) => promptYes(pushWarning(summary, playlistName)),
        });
        console.log(
          `Pushed ${res.trackCount} tracks to "${res.playlistName}" (${res.batches} batch(es)).`,
        );
      } catch (err) {
        if (err instanceof PushError) {
          console.error(`push failed: ${err.message}`);
        } else {
          console.error(`push failed: ${errMsg(err)}`);
        }
        process.exitCode = 1;
      }
    },
  );

program.parse();
