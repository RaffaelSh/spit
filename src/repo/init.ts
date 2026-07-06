import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getPlaylist, getPlaylistTracks } from '../spotify/playlists.js';
import { serializePlaylist } from '../snapshot/serialize.js';
import { gitInit, gitAdd, gitCommit, gitLog } from '../git/git.js';

/** Structured outcome of `spit init`, printed by the CLI layer. */
export interface InitResult {
  repoDir: string;
  playlistName: string;
  trackCount: number;
  commit: string;
}

/**
 * Accept a bare playlist id, a `spotify:playlist:<id>` URI, or an
 * `open.spotify.com/playlist/<id>` URL and return the bare id. Anything else is
 * returned trimmed and left for the Spotify API to reject with a clear error.
 */
export function normalizePlaylistId(input: string): string {
  const uri = input.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uri) return uri[1];
  const url = input.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/);
  if (url) return url[1];
  return input.trim();
}

/** Strip path separators / filesystem-hostile chars so a playlist name is dir-safe. */
function sanitizeDirName(name: string): string {
  return name
    .trim()
    .replace(/[/\\<>:"|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-');
}

/**
 * `spit init <playlistId> [dir]` — the grundeinheit: one playlist == one repo.
 *
 * Reads the live Spotify state (getPlaylist + getPlaylistTracks, T03),
 * serializes a deterministic snapshot into the target dir, then `git init` →
 * `git add` → `git commit`. A spit repo is a real git repo (D001).
 *
 * Failure paths bubble as readable errors: not logged in →
 * ReauthRequiredError from getAccessToken ("Run `spit login`"); an invalid id →
 * SpotifyApiError with Spotify's own message; git failures → GitError + stderr.
 */
export async function initRepo(playlistIdInput: string, dir?: string): Promise<InitResult> {
  const playlistId = normalizePlaylistId(playlistIdInput);

  const meta = await getPlaylist(playlistId);
  const tracks = await getPlaylistTracks(playlistId);

  const repoDir = resolve(dir ?? (sanitizeDirName(meta.name) || meta.id));
  await mkdir(repoDir, { recursive: true });

  await serializePlaylist(meta, tracks, repoDir);

  await gitInit(repoDir);
  await gitAdd(repoDir, ['playlist.jsonl', 'meta.json']);
  await gitCommit(repoDir, `Initial snapshot: ${meta.name}`);

  const commit = (await gitLog(repoDir)).split('\n')[0]?.trim() ?? '';

  return { repoDir, playlistName: meta.name, trackCount: tracks.length, commit };
}
