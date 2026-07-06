import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Environment variable that overrides the persisted client id. */
export const SPOTIFY_CLIENT_ID_ENV = 'SPOTIFY_CLIENT_ID';

/**
 * Global spit config dir (~/.spit) and file (~/.spit/config.json).
 * Resolved at call time (not import time) so tests can point HOME at a temp dir.
 * This is the *global* config — distinct from the per-repo <repoDir>/.spit/config.json
 * that gates write-back (see src/repo/write-config.ts). They may share a path only
 * if a repo is initialised directly in $HOME; persistClientId merges rather than
 * clobbers, so writeMode there survives.
 */
export function spitDir(): string {
  return join(homedir(), '.spit');
}

export function configPath(): string {
  return join(spitDir(), 'config.json');
}

/** Fields spit persists in the global config. Open shape — unknown keys are preserved. */
export interface SpitConfig {
  clientId?: string;
  [key: string]: unknown;
}

/** Read ~/.spit/config.json, or an empty object if it is missing/unreadable/malformed. */
export function readConfig(): SpitConfig {
  try {
    const raw = readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SpitConfig) : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the Spotify client id: the SPOTIFY_CLIENT_ID env var wins, else the
 * persisted config. Returns null when neither is set. Never throws — callers
 * that need a value use requireClientId() for the actionable error.
 */
export function resolveClientId(): string | null {
  const env = process.env[SPOTIFY_CLIENT_ID_ENV];
  if (env && env.trim() !== '') return env.trim();
  const fromConfig = readConfig().clientId;
  if (typeof fromConfig === 'string' && fromConfig.trim() !== '') return fromConfig.trim();
  return null;
}

/**
 * Persist the client id to ~/.spit/config.json (dir 0700, file 0600), merging
 * rather than clobbering any other keys already there. No-op when the stored
 * value is already identical. This is what makes token refresh survive a shell
 * that no longer exports SPOTIFY_CLIENT_ID.
 */
export function persistClientId(clientId: string): void {
  const id = clientId.trim();
  const current = readConfig();
  if (current.clientId === id) return;
  const next: SpitConfig = { ...current, clientId: id };
  mkdirSync(spitDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
}
