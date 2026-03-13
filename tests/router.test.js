import { describe, it, expect } from '@jest/globals';
import { parseRoute } from '../src/router.js';

describe('parseRoute', () => {
  it('returns home for root path', () => {
    expect(parseRoute('/')).toEqual({ type: 'home' });
  });

  it('returns home for empty path', () => {
    expect(parseRoute('')).toEqual({ type: 'home' });
  });

  it('parses 3-word room code from path', () => {
    expect(parseRoute('/room/red-tiger-paw')).toEqual({
      type: 'room',
      code: 'red-tiger-paw',
    });
  });

  it('parses single-word room code', () => {
    expect(parseRoute('/room/test')).toEqual({
      type: 'room',
      code: 'test',
    });
  });

  it('returns home for unknown paths', () => {
    expect(parseRoute('/unknown')).toEqual({ type: 'home' });
  });

  it('returns home for /room/ with no code', () => {
    expect(parseRoute('/room/')).toEqual({ type: 'home' });
  });

  it('parses leaderboard route', () => {
    expect(parseRoute('/leaderboard')).toEqual({ type: 'leaderboard' });
  });
});
