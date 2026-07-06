#!/usr/bin/env node
import { Command } from 'commander';

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

// Stub subcommands. Real implementations land in downstream tasks:
//   login  -> T02 (Spotify PKCE auth)
//   init   -> T04 (repo init)
//   status -> T04 (live read)
program
  .command('login')
  .description('Authenticate with Spotify (PKCE)')
  .action(() => {
    console.log('spit login: not yet implemented');
  });

program
  .command('init')
  .description('Initialize a spit repository in the current directory')
  .action(() => {
    console.log('spit init: not yet implemented');
  });

program
  .command('status')
  .description('Show live playback / sync status')
  .action(() => {
    console.log('spit status: not yet implemented');
  });

program.parse();
