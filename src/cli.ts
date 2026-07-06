#!/usr/bin/env node
import { Command } from 'commander';
import { runOAuthFlow, requireClientId } from './auth/oauth.js';
import { saveTokens, TOKEN_PATH } from './auth/token-store.js';
import { initRepo } from './repo/init.js';
import { repoStatus } from './repo/status.js';

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

program.parse();
