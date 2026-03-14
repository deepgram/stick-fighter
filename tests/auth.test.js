import { describe, it, expect } from '@jest/globals';
import { parseRoute } from '../src/router.js';

// ─── Router: auth-callback route ──────────────────

describe('parseRoute — auth callback', () => {
  it('detects /auth/callback as auth-callback type', () => {
    const route = parseRoute('/auth/callback');
    expect(route.type).toBe('auth-callback');
  });

  it('still detects /room/:code routes', () => {
    const route = parseRoute('/room/red-tiger-paw');
    expect(route.type).toBe('room');
    expect(route.code).toBe('red-tiger-paw');
  });

  it('returns home for /', () => {
    const route = parseRoute('/');
    expect(route.type).toBe('home');
  });

  it('returns home for /auth (no /callback)', () => {
    const route = parseRoute('/auth');
    expect(route.type).toBe('home');
  });

  it('returns home for /auth/callback/extra', () => {
    const route = parseRoute('/auth/callback/extra');
    expect(route.type).toBe('home');
  });
});

// ─── Router: multiplayer route ──────────────────

describe('parseRoute — multiplayer', () => {
  it('detects /multiplayer as multiplayer type', () => {
    const route = parseRoute('/multiplayer');
    expect(route.type).toBe('multiplayer');
  });

  it('returns home for /multiplayer/extra', () => {
    const route = parseRoute('/multiplayer/extra');
    expect(route.type).toBe('home');
  });
});

// ─── PKCE helpers ──────────────────────────────

describe('PKCE code verifier and challenge', () => {
  // We need crypto.subtle and crypto.getRandomValues for these tests.
  // Node 18+ provides them via globalThis.crypto.

  it('_generateCodeVerifier returns 64-char hex string', async () => {
    const { _generateCodeVerifier } = await import('../src/auth.js');
    const verifier = _generateCodeVerifier();
    expect(verifier).toHaveLength(64);
    expect(verifier).toMatch(/^[0-9a-f]{64}$/);
  });

  it('_generateCodeVerifier returns different values each call', async () => {
    const { _generateCodeVerifier } = await import('../src/auth.js');
    const v1 = _generateCodeVerifier();
    const v2 = _generateCodeVerifier();
    expect(v1).not.toBe(v2);
  });

  it('_computeCodeChallenge returns base64url string without padding', async () => {
    const { _computeCodeChallenge } = await import('../src/auth.js');
    const challenge = await _computeCodeChallenge('test-verifier-12345');
    // base64url: no +, /, or = characters
    expect(challenge).not.toMatch(/[+/=]/);
    // Should be non-empty
    expect(challenge.length).toBeGreaterThan(0);
  });

  it('_computeCodeChallenge is deterministic for same input', async () => {
    const { _computeCodeChallenge } = await import('../src/auth.js');
    const c1 = await _computeCodeChallenge('same-verifier');
    const c2 = await _computeCodeChallenge('same-verifier');
    expect(c1).toBe(c2);
  });

  it('_computeCodeChallenge differs for different inputs', async () => {
    const { _computeCodeChallenge } = await import('../src/auth.js');
    const c1 = await _computeCodeChallenge('verifier-a');
    const c2 = await _computeCodeChallenge('verifier-b');
    expect(c1).not.toBe(c2);
  });
});
