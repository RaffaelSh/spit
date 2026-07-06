import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateVerifier,
  challengeFromVerifier,
  base64url,
  generateState,
} from '../src/auth/pkce.js';

// RFC 7636 Appendix B canonical PKCE test vector.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const BASE64URL_ONLY = /^[A-Za-z0-9\-_]+$/;

test('challengeFromVerifier matches RFC 7636 Appendix B S256 vector', () => {
  assert.equal(challengeFromVerifier(RFC_VERIFIER), RFC_CHALLENGE);
});

test('challengeFromVerifier output is base64url with no padding', () => {
  const challenge = challengeFromVerifier(RFC_VERIFIER);
  assert.match(challenge, BASE64URL_ONLY);
  assert.equal(challenge.length, 43); // sha256 = 32 bytes -> 43 base64url chars
});

test('generateVerifier length is within RFC 43–128 range', () => {
  for (let i = 0; i < 100; i++) {
    const v = generateVerifier();
    assert.ok(v.length >= 43 && v.length <= 128, `length out of range: ${v.length}`);
  }
});

test('generateVerifier output is base64url-charset only', () => {
  for (let i = 0; i < 100; i++) {
    assert.match(generateVerifier(), BASE64URL_ONLY);
  }
});

test('generateVerifier is high-entropy (no collisions across a batch)', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(generateVerifier());
  assert.equal(seen.size, 1000);
});

test('base64url strips padding and maps + / to - _', () => {
  // 0xFB 0xFF -> base64 "+/8=", base64url "-_8"
  assert.equal(base64url(Buffer.from([0xfb, 0xff])), '-_8');
});

test('generateState returns a non-empty base64url token', () => {
  const s = generateState();
  assert.match(s, BASE64URL_ONLY);
  assert.ok(s.length >= 16);
});
