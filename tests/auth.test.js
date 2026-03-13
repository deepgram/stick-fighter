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
