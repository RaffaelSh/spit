import { randomBytes, createHash } from 'node:crypto';

/**
 * PKCE (RFC 7636) helpers for the Spotify Authorization Code + PKCE flow.
 *
 * base64url = standard base64 with `+`->`-`, `/`->`_`, and `=` padding stripped.
 */

/** Encode a buffer as base64url (no padding), per RFC 4648 §5. */
export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a PKCE code verifier: a high-entropy base64url string.
 * 32 random bytes -> 43 base64url chars, well within the RFC's 43–128 range.
 */
export function generateVerifier(): string {
  return base64url(randomBytes(32));
}

/**
 * Derive the S256 code challenge from a verifier: base64url(sha256(verifier)).
 * The verifier is hashed as ASCII, matching the spec and Spotify's expectation.
 */
export function challengeFromVerifier(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** Generate an opaque anti-CSRF state token for the /authorize round-trip. */
export function generateState(): string {
  return base64url(randomBytes(16));
}
