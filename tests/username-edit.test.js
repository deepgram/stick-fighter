import { describe, it, expect } from '@jest/globals';

// ─── Username validation (mirrors server-side regex) ──────────────

const USERNAME_PATTERN = /^[a-zA-Z0-9-]{2,30}$/;

describe('Username validation pattern', () => {
  it('accepts valid alphanumeric-hyphen names', () => {
    expect(USERNAME_PATTERN.test('cool-ninja')).toBe(true);
    expect(USERNAME_PATTERN.test('Fighter99')).toBe(true);
    expect(USERNAME_PATTERN.test('ab')).toBe(true);
    expect(USERNAME_PATTERN.test('a'.repeat(30))).toBe(true);
  });

  it('rejects single character', () => {
    expect(USERNAME_PATTERN.test('x')).toBe(false);
  });

  it('rejects names over 30 characters', () => {
    expect(USERNAME_PATTERN.test('a'.repeat(31))).toBe(false);
  });

  it('rejects spaces and special characters', () => {
    expect(USERNAME_PATTERN.test('bad name')).toBe(false);
    expect(USERNAME_PATTERN.test('hello!')).toBe(false);
    expect(USERNAME_PATTERN.test('user@name')).toBe(false);
    expect(USERNAME_PATTERN.test('under_score')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(USERNAME_PATTERN.test('')).toBe(false);
  });
});

// ─── updateUsername API function ───────────────────────────────

describe('updateUsername function', () => {
  // Mock localStorage and fetch for auth module
  const mockStorage = {};
  beforeAll(() => {
    globalThis.localStorage = {
      getItem: (k) => mockStorage[k] ?? null,
      setItem: (k, v) => { mockStorage[k] = v; },
      removeItem: (k) => { delete mockStorage[k]; },
    };
  });

  afterEach(() => {
    Object.keys(mockStorage).forEach(k => delete mockStorage[k]);
    delete globalThis.fetch;
  });

  it('returns error when not logged in', async () => {
    const { updateUsername } = await import('../src/auth.js');
    // No access token in storage
    const result = await updateUsername('new-name');
    expect(result.error).toBeDefined();
  });

  it('sends correct request to server', async () => {
    mockStorage['sf_auth_access_token'] = 'test-token';
    mockStorage['sf_auth_user'] = JSON.stringify({ id: 'u1', name: 'old' });

    let capturedReq = null;
    globalThis.fetch = async (url, opts) => {
      capturedReq = { url, opts };
      return {
        ok: true,
        json: async () => ({ name: 'new-name' }),
      };
    };

    const { updateUsername } = await import('../src/auth.js');
    const result = await updateUsername('new-name');

    expect(result.name).toBe('new-name');
    expect(capturedReq.url).toBe('/api/auth/username');
    expect(capturedReq.opts.method).toBe('POST');
    expect(capturedReq.opts.headers['Authorization']).toBe('Bearer test-token');
    const body = JSON.parse(capturedReq.opts.body);
    expect(body.name).toBe('new-name');
  });

  it('updates stored user on success', async () => {
    mockStorage['sf_auth_access_token'] = 'test-token';
    mockStorage['sf_auth_user'] = JSON.stringify({ id: 'u1', name: 'old-name' });

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ name: 'updated-name' }),
    });

    const { updateUsername } = await import('../src/auth.js');
    await updateUsername('updated-name');

    const stored = JSON.parse(mockStorage['sf_auth_user']);
    expect(stored.name).toBe('updated-name');
  });

  it('returns error on server rejection', async () => {
    mockStorage['sf_auth_access_token'] = 'test-token';

    globalThis.fetch = async () => ({
      ok: false,
      status: 409,
      json: async () => ({ detail: 'Username is already taken' }),
    });

    const { updateUsername } = await import('../src/auth.js');
    const result = await updateUsername('taken');
    expect(result.error).toContain('already taken');
  });

  it('returns error on network failure', async () => {
    mockStorage['sf_auth_access_token'] = 'test-token';

    globalThis.fetch = async () => { throw new Error('Network failed'); };

    const { updateUsername } = await import('../src/auth.js');
    const result = await updateUsername('any');
    expect(result.error).toBe('Network error');
  });
});
