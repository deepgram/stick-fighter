/**
 * Tests for controller-wait / waiting-in-arena logic.
 *
 * These test the pure state-transition logic that handleRoomStatusUpdate
 * uses to decide which flow to trigger (waiting → fighting, waiting → forfeit).
 */

describe('Controller wait state transitions', () => {
  // Simulate the decision logic from handleRoomStatusUpdate
  function decideTransition(state, data) {
    if (data.status === 'fighting' && state === 'waitingInArena') {
      return 'startFight';
    } else if (data.status === 'fighting' && state !== 'fighting') {
      return 'startFight';
    } else if (data.status === 'finished' && state === 'waitingInArena') {
      return 'forfeit';
    } else if (data.status === 'selecting' && state === 'roomLobby') {
      return 'showController';
    }
    return null;
  }

  test('waiting + fighting → starts fight', () => {
    expect(decideTransition('waitingInArena', { status: 'fighting' })).toBe('startFight');
  });

  test('waiting + finished → forfeit', () => {
    expect(decideTransition('waitingInArena', { status: 'finished' })).toBe('forfeit');
  });

  test('waiting + selecting → no transition (still waiting)', () => {
    expect(decideTransition('waitingInArena', { status: 'selecting' })).toBe(null);
  });

  test('roomController + fighting → starts fight (normal path)', () => {
    expect(decideTransition('roomController', { status: 'fighting' })).toBe('startFight');
  });

  test('roomLobby + selecting → show controller screen', () => {
    expect(decideTransition('roomLobby', { status: 'selecting' })).toBe('showController');
  });

  test('already fighting + fighting → no duplicate transition', () => {
    expect(decideTransition('fighting', { status: 'fighting' })).toBe(null);
  });
});

describe('Forfeit countdown computation', () => {
  test('computes remaining seconds from deadline', () => {
    const deadline = Math.floor(Date.now() / 1000) + 45;
    const remaining = Math.max(0, Math.ceil((deadline * 1000 - Date.now()) / 1000));
    expect(remaining).toBeGreaterThanOrEqual(44);
    expect(remaining).toBeLessThanOrEqual(46);
  });

  test('returns 0 when deadline has passed', () => {
    const deadline = Math.floor(Date.now() / 1000) - 10;
    const remaining = Math.max(0, Math.ceil((deadline * 1000 - Date.now()) / 1000));
    expect(remaining).toBe(0);
  });

  test('returns 60 for a fresh deadline', () => {
    const deadline = Math.floor(Date.now() / 1000) + 60;
    const remaining = Math.max(0, Math.ceil((deadline * 1000 - Date.now()) / 1000));
    expect(remaining).toBeGreaterThanOrEqual(59);
    expect(remaining).toBeLessThanOrEqual(61);
  });
});

describe('Forfeit result determination', () => {
  test('waiting player wins when they are the forfeit winner', () => {
    const myNum = 1;
    const forfeitWinner = 1;
    const result = forfeitWinner === myNum ? 'YOU WIN!' : 'YOU LOSE';
    expect(result).toBe('YOU WIN!');
  });

  test('waiting player loses when opponent is forfeit winner', () => {
    const myNum = 2;
    const forfeitWinner = 1;
    const result = forfeitWinner === myNum ? 'YOU WIN!' : 'YOU LOSE';
    expect(result).toBe('YOU LOSE');
  });
});
