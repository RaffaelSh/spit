#!/usr/bin/env node
import { Command } from 'commander';
import { runOAuthFlow, requireClientId } from './auth/oauth.js';
import {
  persistClientId,
  resolveClientId,
  readConfig,
  configPath,
  SPOTIFY_CLIENT_ID_ENV,
} from './auth/config.js';
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
import { repoTag } from './repo/tag.js';
import { repoStash } from './repo/stash.js';
import { repoRebase } from './repo/rebase.js';
import { repoPull } from './repo/pull.js';
import { pushSnapshot } from './repo/push.js';
import type { ChangeSummary } from './repo/push.js';
import type { TrackRecord } from './spotify/playlists.js';
import { describeSpotifyError } from './spotify/errors.js';

/** Render a track by name, falling back to uri / id / a "(local track)" marker. */
const trackLabel = (t: TrackRecord): string =>
  t.name ?? t.uri ?? t.id ?? '(local track)';

/**
 * Print an actionable one-line failure for `err` and set the class-specific exit
 * code (auth/forbidden/not-found/rate-limit/network/general). The single failure
 * seam every command's catch routes through.
 */
const reportError = (prefix: string, err: unknown): void => {
  const { message, exitCode } = describeSpotifyError(err);
  console.error(`${prefix}: ${message}`);
  process.exitCode = exitCode;
};

// --- Spotify auth assumptions ---
// The registered Spotify redirect URI defaults to http://127.0.0.1:8888/callback.
// The client id comes from the SPOTIFY_CLIENT_ID env var or the persisted
// ~/.spit/config.json (see src/auth/config.ts). PKCE is used, so no secret.
export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8888/callback';

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
      // Persist so a later token refresh works even if this shell no longer
      // exports SPOTIFY_CLIENT_ID (the durability fix — token outlives the env).
      persistClientId(clientId);
      const tokens = await runOAuthFlow(clientId);
      await saveTokens(tokens);
      console.log(`\nLogin successful. Token cached at ${TOKEN_PATH} (0600).`);
      console.log(`Client id remembered in ${configPath()} for future refreshes.`);
    } catch (err) {
      reportError('login failed', err);
    }
  });

const configCmd = program
  .command('config')
  .description('Inspect or set persistent spit configuration (~/.spit/config.json)');

configCmd
  .command('set-client-id')
  .description('Persist your Spotify app client id so login and refresh survive without env vars')
  .argument('<id>', 'Spotify application client id')
  .action((id: string) => {
    const trimmed = id.trim();
    if (trimmed === '') {
      console.error('config failed: client id must not be empty.');
      process.exitCode = 1;
      return;
    }
    persistClientId(trimmed);
    console.log(`Saved client id to ${configPath()} (0600).`);
  });

configCmd
  .command('show')
  .description('Show the resolved client id and where it comes from')
  .action(() => {
    const env = process.env[SPOTIFY_CLIENT_ID_ENV];
    const stored = readConfig().clientId;
    const resolved = resolveClientId();
    const mask = (v: string): string => (v.length <= 6 ? '***' : `${v.slice(0, 4)}…${v.slice(-2)}`);
    console.log(`config file: ${configPath()}`);
    console.log(`env ${SPOTIFY_CLIENT_ID_ENV}: ${env && env.trim() !== '' ? mask(env.trim()) : '(unset)'}`);
    console.log(`stored client id: ${typeof stored === 'string' && stored !== '' ? mask(stored) : '(none)'}`);
    if (resolved) {
      const source = env && env.trim() !== '' ? 'env' : 'config file';
      console.log(`resolved: ${mask(resolved)} (from ${source})`);
    } else {
      console.log('resolved: (none) — run `spit config set-client-id <id>` or set the env var.');
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
      reportError('init failed', err);
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
      reportError('commit failed', err);
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
      reportError('pull failed', err);
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
      reportError('status failed', err);
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
      reportError('log failed', err);
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
      reportError('diff failed', err);
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
      reportError('branch failed', err);
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
      reportError('merge failed', err);
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
      reportError('checkout failed', err);
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
      reportError('revert failed', err);
    }
  });

program
  .command('tag')
  .description('Tag the current snapshot, or list tags when no name is given')
  .argument('[name]', 'tag name to create (omit to list existing tags)')
  .argument('[dir]', 'repo directory (default: current directory)')
  .action(async (name: string | undefined, dir: string | undefined) => {
    try {
      const res = await repoTag(dir, name);
      if (res.created) {
        console.log(`Tagged current snapshot as "${res.created}" in "${res.playlistName}".`);
      }
      if (res.tags.length === 0) {
        console.log('No tags yet.');
      } else {
        console.log(res.created ? 'All tags:' : 'Tags:');
        for (const t of res.tags) console.log(`  ${t}`);
      }
    } catch (err) {
      reportError('tag failed', err);
    }
  });

const stashCmd = program
  .command('stash')
  .description('Shelve uncommitted snapshot edits; `spit stash` saves, `spit stash pop` restores')
  .argument('[dir]', 'repo directory (default: current directory)')
  .action(async (dir: string | undefined) => {
    try {
      const res = await repoStash(dir, 'save');
      if (res.noOp) {
        console.log('Nothing to stash — the working tree is clean.');
        return;
      }
      console.log(
        `Stashed uncommitted changes in "${res.playlistName}". Restore with \`spit stash pop\`.`,
      );
    } catch (err) {
      reportError('stash failed', err);
    }
  });

stashCmd
  .command('pop')
  .description('Restore the most recently stashed snapshot edits')
  .argument('[dir]', 'repo directory (default: current directory)')
  .action(async (dir: string | undefined) => {
    try {
      const res = await repoStash(dir, 'pop');
      console.log(`Restored stashed changes into "${res.playlistName}".`);
    } catch (err) {
      reportError('stash pop failed', err);
    }
  });

program
  .command('rebase')
  .description('Replay the current branch onto another ref (git rebase; no auto-resolve)')
  .argument('<upstream>', 'branch, tag, or commit to rebase onto')
  .argument('[dir]', 'repo directory (default: current directory)')
  .action(async (upstream: string, dir: string | undefined) => {
    try {
      const res = await repoRebase(dir, upstream);
      console.log(`Rebased "${res.playlistName}" onto ${upstream} (HEAD now ${res.commit}).`);
    } catch (err) {
      reportError('rebase failed', err);
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
        reportError('push failed', err);
      }
    },
  );

program.parse();
