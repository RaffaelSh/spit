import { SpotifyApiError, SpotifyNetworkError } from './client.js';
import { ReauthRequiredError } from '../auth/token-store.js';

/**
 * Process exit codes spit uses so a caller (script/CI) can branch on the *class*
 * of failure, not just success/failure. Kept small and stable; 1 is the catch-all.
 */
export const ExitCode = {
  GENERAL: 1,
  AUTH: 3, // not logged in / session expired → spit login
  FORBIDDEN: 4, // missing scope, app in dev mode, or not the owner
  NOT_FOUND: 5, // playlist id/URL wrong or not visible to this account
  RATE_LIMIT: 6, // 429 persisted after backoff
  NETWORK: 7, // request never reached Spotify
} as const;

export interface Diagnosis {
  message: string;
  exitCode: number;
}

/**
 * Map any error a command can throw to an actionable one-line message plus a
 * class-specific exit code. Pure and total: unknown errors fall back to their
 * own message with the general exit code, so nothing is ever swallowed.
 *
 * This is the single seam the CLI uses to report failures; it is deliberately
 * richer than push.ts's describePushError (which produces short fragments spliced
 * into a PushError sentence).
 */
export function describeSpotifyError(err: unknown): Diagnosis {
  if (err instanceof ReauthRequiredError) {
    return { message: err.message, exitCode: ExitCode.AUTH };
  }

  if (err instanceof SpotifyNetworkError) {
    return {
      message: `${err.message}. Check your internet connection and try again.`,
      exitCode: ExitCode.NETWORK,
    };
  }

  if (err instanceof SpotifyApiError) {
    switch (err.status) {
      case 401:
        return {
          message: 'Spotify rejected your credentials (401). Run `spit login` to re-authenticate.',
          exitCode: ExitCode.AUTH,
        };
      case 403:
        return {
          message:
            'Spotify refused this request (403). Likely causes: your login is missing playlist ' +
            'write scopes (run `spit login` again to re-consent), the app is in development mode ' +
            'and this account is not added as a user, or you are not the playlist owner.',
          exitCode: ExitCode.FORBIDDEN,
        };
      case 404:
        return {
          message:
            'Spotify could not find that resource (404). Check the playlist id/URL is correct ' +
            'and that your account can see it (private playlists need the owning account).',
          exitCode: ExitCode.NOT_FOUND,
        };
      case 429:
        return {
          message: 'Spotify rate limit hit and retries were exhausted (429). Wait a bit and retry.',
          exitCode: ExitCode.RATE_LIMIT,
        };
      default:
        if (err.status >= 500) {
          return {
            message: `Spotify server error (${err.status}). This is usually transient; retry shortly.`,
            exitCode: ExitCode.GENERAL,
          };
        }
        return { message: err.message, exitCode: ExitCode.GENERAL };
    }
  }

  return {
    message: err instanceof Error ? err.message : String(err),
    exitCode: ExitCode.GENERAL,
  };
}
