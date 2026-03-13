import { describe, test, expect, beforeEach } from '@jest/globals';

// ── Minimal Fighter mock that supports toSnapshot/fromSnapshot ──

class MockFighter {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.facing = 1;
    this.state = 'idle';
    this.health = 100;
    this.currentAttack = null;
    this.attackFrame = 0;
    this.attackContext = 'stand';
    this.attackHasHit = false;
    this.stunFrames = 0;
    this.dashTimer = 0;
    this.dashDir = 0;
    this.isFlipping = false;
    this.flipAngle = 0;
    this.jumpCount = 0;
    this.flipCount = 0;
    this.floorY = 240;
    this.width = 40;
    this.events = new Set();
    this._prevImpact = null;
  }

  get grounded() { return this.y >= this.floorY; }

  toSnapshot() {
    return {
      x: this.x, y: this.y, vx: this.vx, vy: this.vy,
      facing: this.facing, state: this.state, health: this.health,
      current_attack: this.currentAttack,
      attack_frame: this.attackFrame,
      attack_context: this.attackContext,
      attack_has_hit: this.attackHasHit,
      stun_frames: this.stunFrames,
      dash_timer: this.dashTimer,
      dash_dir: this.dashDir,
      is_flipping: this.isFlipping,
      flip_angle: this.flipAngle,
      jump_count: this.jumpCount,
      flip_count: this.flipCount,
    };
  }

  fromSnapshot(s) {
    this.x = s.x;
    this.y = s.y;
    this.vx = s.vx;
    this.vy = s.vy;
    this.facing = s.facing;
    this.state = s.state;
    this.health = s.health;
    this.currentAttack = s.current_attack;
    this.attackFrame = s.attack_frame;
    this.attackContext = s.attack_context;
    this.attackHasHit = s.attack_has_hit;
    this.stunFrames = s.stun_frames;
    this.dashTimer = s.dash_timer;
    this.dashDir = s.dash_dir;
    this.isFlipping = s.is_flipping;
    this.flipAngle = s.flip_angle;
    this.jumpCount = s.jump_count;
    this.flipCount = s.flip_count;
    this._prevImpact = null;
  }

  update(_dt, _actions, _pressed, _opponent, _stageLeft, _stageRight) {
    // Simple mock: just apply velocity
    this.events.clear();
    this.x += this.vx * _dt;
    this.y += this.vy * _dt;
  }

  updateImpactTracking() {
    this._prevImpact = null;
  }
}

// ── Mock Game ──

function createMockGame() {
  const game = {
    p1: new MockFighter(200, 240),
    p2: new MockFighter(600, 240),
    stageLeft: 40,
    stageRight: 760,
    roundTimer: 99,
    roundOver: false,
    waitingForProviders: false,
    fightAlert: 0,
    predictionManager: null,
    _dt: 0.016,
  };
  return game;
}

// ── Build a server snapshot matching current game state ──

function buildSnapshot(game, tick, p1InputSeq = 0, p2InputSeq = 0) {
  return {
    type: 'state',
    tick,
    round_timer: game.roundTimer,
    round_over: game.roundOver,
    p1: game.p1.toSnapshot(),
    p2: game.p2.toSnapshot(),
    p1_input_seq: p1InputSeq,
    p2_input_seq: p2InputSeq,
  };
}

// ── Import the module under test ──

const { PredictionManager } = await import('../src/prediction.js');

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('PredictionManager', () => {
  let game;
  let pm;

  beforeEach(() => {
    game = createMockGame();
    pm = new PredictionManager(game, 1);
  });

  describe('constructor', () => {
    test('initializes state correctly', () => {
      expect(pm.game).toBe(game);
      expect(pm.playerNum).toBe(1);
      expect(pm.inputBuffer).toEqual([]);
      expect(pm.inputSeq).toBe(0);
      expect(pm.lastConfirmedSeq).toBe(-1);
      expect(pm.smoothP1).toEqual({ dx: 0, dy: 0 });
      expect(pm.smoothP2).toEqual({ dx: 0, dy: 0 });
      expect(pm.rollbackCount).toBe(0);
    });
  });

  describe('nextSeq', () => {
    test('returns incrementing sequence numbers', () => {
      expect(pm.nextSeq()).toBe(1);
      expect(pm.nextSeq()).toBe(2);
      expect(pm.nextSeq()).toBe(3);
    });
  });

  describe('bufferInput', () => {
    test('stores input with seq and dt', () => {
      const actions = new Set(['left']);
      const pressed = new Set(['lightPunch']);
      pm.bufferInput(1, actions, pressed, 0.016);

      expect(pm.inputBuffer).toHaveLength(1);
      expect(pm.inputBuffer[0].seq).toBe(1);
      expect(pm.inputBuffer[0].actions).toEqual(new Set(['left']));
      expect(pm.inputBuffer[0].pressed).toEqual(new Set(['lightPunch']));
      expect(pm.inputBuffer[0].dt).toBe(0.016);
    });

    test('creates new Set copies (not references)', () => {
      const actions = new Set(['left']);
      pm.bufferInput(1, actions, new Set(), 0.016);
      actions.add('right');
      expect(pm.inputBuffer[0].actions).toEqual(new Set(['left']));
    });

    test('trims buffer at max size', () => {
      for (let i = 0; i < 65; i++) {
        pm.bufferInput(i + 1, new Set(), new Set(), 0.016);
      }
      expect(pm.inputBuffer).toHaveLength(60);
      expect(pm.inputBuffer[0].seq).toBe(6); // first 5 trimmed
    });

    test('defaults dt to 0.016 when falsy', () => {
      pm.bufferInput(1, new Set(), new Set(), 0);
      expect(pm.inputBuffer[0].dt).toBe(0.016);
    });
  });

  describe('applyServerState — authoritative values', () => {
    test('applies health from server', () => {
      game.p1.health = 95;
      game.p2.health = 88;
      const snap = buildSnapshot(game, 1, 0, 0);
      snap.p1.health = 90;
      snap.p2.health = 80;

      pm.applyServerState(snap);

      expect(game.p1.health).toBe(90);
      expect(game.p2.health).toBe(80);
    });

    test('applies round timer from server', () => {
      game.roundTimer = 95;
      const snap = buildSnapshot(game, 1);
      snap.round_timer = 92.5;

      pm.applyServerState(snap);

      expect(game.roundTimer).toBe(92.5);
    });

    test('applies round over from server', () => {
      const snap = buildSnapshot(game, 1);
      snap.round_over = true;

      pm.applyServerState(snap);

      expect(game.roundOver).toBe(true);
    });

    test('ignores snapshots during waitingForProviders', () => {
      game.waitingForProviders = true;
      game.p1.health = 100;
      const snap = buildSnapshot(game, 1);
      snap.p1.health = 50;

      pm.applyServerState(snap);

      expect(game.p1.health).toBe(100); // unchanged
    });

    test('ignores snapshots during fight alert', () => {
      game.fightAlert = 1.0;
      game.p1.health = 100;
      const snap = buildSnapshot(game, 1);
      snap.p1.health = 50;

      pm.applyServerState(snap);

      expect(game.p1.health).toBe(100); // unchanged
    });
  });

  describe('applyServerState — stale snapshot rejection', () => {
    test('ignores snapshot with older confirmed seq', () => {
      const snap1 = buildSnapshot(game, 1, 5, 0);
      pm.applyServerState(snap1);
      expect(pm.lastConfirmedSeq).toBe(5);

      game.p1.health = 100;
      const snap2 = buildSnapshot(game, 2, 3, 0);
      snap2.p1.health = 50;
      pm.applyServerState(snap2);

      expect(game.p1.health).toBe(100); // stale — ignored
    });
  });

  describe('applyServerState — input buffer trimming', () => {
    test('trims confirmed inputs from buffer', () => {
      pm.bufferInput(1, new Set(), new Set(), 0.016);
      pm.bufferInput(2, new Set(), new Set(), 0.016);
      pm.bufferInput(3, new Set(), new Set(), 0.016);
      pm.bufferInput(4, new Set(), new Set(), 0.016);

      const snap = buildSnapshot(game, 1, 2, 0);
      pm.applyServerState(snap);

      expect(pm.inputBuffer).toHaveLength(2);
      expect(pm.inputBuffer[0].seq).toBe(3);
      expect(pm.inputBuffer[1].seq).toBe(4);
    });
  });

  describe('_needsRollback', () => {
    test('returns false when states match', () => {
      const snap = buildSnapshot(game, 1);
      expect(pm._needsRollback(snap)).toBe(false);
    });

    test('detects p1 x position mismatch', () => {
      const snap = buildSnapshot(game, 1);
      snap.p1.x = game.p1.x + 10; // > POS_THRESHOLD
      expect(pm._needsRollback(snap)).toBe(true);
    });

    test('detects p2 y position mismatch', () => {
      const snap = buildSnapshot(game, 1);
      snap.p2.y = game.p2.y + 5;
      expect(pm._needsRollback(snap)).toBe(true);
    });

    test('detects state mismatch', () => {
      const snap = buildSnapshot(game, 1);
      snap.p1.state = 'hitstun';
      expect(pm._needsRollback(snap)).toBe(true);
    });

    test('detects health mismatch', () => {
      const snap = buildSnapshot(game, 1);
      snap.p1.health = game.p1.health - 5;
      expect(pm._needsRollback(snap)).toBe(true);
    });

    test('ignores small position difference within threshold', () => {
      const snap = buildSnapshot(game, 1);
      snap.p1.x = game.p1.x + 2; // within 3px threshold
      snap.p2.x = game.p2.x - 1;
      expect(pm._needsRollback(snap)).toBe(false);
    });
  });

  describe('_rollbackAndReplay', () => {
    test('restores server state', () => {
      const snap = buildSnapshot(game, 1, 0, 0);
      snap.p1.x = 300;
      snap.p1.y = 200;
      snap.p2.x = 500;

      pm._rollbackAndReplay(snap, 0);

      expect(game.p1.x).toBe(300);
      expect(game.p1.y).toBe(200);
      expect(game.p2.x).toBe(500);
    });

    test('replays unconfirmed inputs after restore', () => {
      // Buffer some inputs
      pm.bufferInput(1, new Set(['right']), new Set(), 0.05);
      pm.bufferInput(2, new Set(['right']), new Set(), 0.05);

      // Server state: p1 at x=100 with vx=200 (walking right)
      const snap = buildSnapshot(game, 1, 0, 0);
      snap.p1.x = 100;
      snap.p1.vx = 200;

      pm._rollbackAndReplay(snap, 0);

      // After replay: p1 advances from 100 by vx*dt per input
      // 100 + 200*0.05 + 200*0.05 = 120
      expect(game.p1.x).toBe(120);
    });

    test('only replays inputs after confirmed seq', () => {
      pm.bufferInput(1, new Set(), new Set(), 0.016);
      pm.bufferInput(2, new Set(), new Set(), 0.016);
      pm.bufferInput(3, new Set(), new Set(), 0.016);

      const snap = buildSnapshot(game, 1, 2, 0);
      snap.p1.x = 300;

      // Track replay count via update calls
      let replayCount = 0;
      const origUpdate = game.p1.update;
      game.p1.update = (...args) => { replayCount++; origUpdate.call(game.p1, ...args); };

      pm._rollbackAndReplay(snap, 2);

      // Only seq 3 should be replayed (seq > 2)
      expect(replayCount).toBe(1);
    });

    test('sets smoothing offsets', () => {
      game.p1.x = 200;
      game.p2.x = 600;

      const snap = buildSnapshot(game, 1, 0, 0);
      snap.p1.x = 210;
      snap.p2.x = 590;

      pm._rollbackAndReplay(snap, 0);

      // Offset = old position - new position
      expect(pm.smoothP1.dx).toBe(-10); // 200 - 210
      expect(pm.smoothP2.dx).toBe(10);  // 600 - 590
    });

    test('increments rollback count', () => {
      const snap = buildSnapshot(game, 1, 0, 0);
      pm._rollbackAndReplay(snap, 0);
      pm._rollbackAndReplay(snap, 0);
      expect(pm.rollbackCount).toBe(2);
    });
  });

  describe('updateSmoothing', () => {
    test('decays offsets toward zero', () => {
      pm.smoothP1.dx = 10;
      pm.smoothP1.dy = -8;
      pm.smoothP2.dx = -5;

      pm.updateSmoothing(0.016);

      expect(Math.abs(pm.smoothP1.dx)).toBeLessThan(10);
      expect(Math.abs(pm.smoothP1.dy)).toBeLessThan(8);
      expect(Math.abs(pm.smoothP2.dx)).toBeLessThan(5);
    });

    test('zeroes out sub-pixel offsets', () => {
      pm.smoothP1.dx = 0.3;
      pm.smoothP1.dy = -0.2;

      pm.updateSmoothing(0.016);

      expect(pm.smoothP1.dx).toBe(0);
      expect(pm.smoothP1.dy).toBe(0);
    });

    test('large offset decays over multiple frames', () => {
      pm.smoothP1.dx = 20;

      // Simulate 10 frames at 60fps
      for (let i = 0; i < 10; i++) {
        pm.updateSmoothing(0.016);
      }

      // Should be significantly reduced but may not be zero
      expect(Math.abs(pm.smoothP1.dx)).toBeLessThan(10);
    });
  });

  describe('full reconciliation flow', () => {
    test('applies state + detects mismatch + rolls back', () => {
      // Buffer some local inputs
      pm.bufferInput(1, new Set(['right']), new Set(), 0.016);
      pm.bufferInput(2, new Set(['right']), new Set(), 0.016);

      // Simulate client predicting ahead: p1 moved to 220
      game.p1.x = 220;

      // Server says p1 is at 210 (slightly different)
      const snap = buildSnapshot(game, 1, 1, 0);
      snap.p1.x = 210;
      snap.p1.health = 95;

      pm.applyServerState(snap);

      // Health was applied authoritatively
      expect(game.p1.health).toBe(95);
      // Rollback happened (position mismatch > 3px)
      expect(pm.rollbackCount).toBe(1);
      // Buffer trimmed to only unconfirmed inputs (seq > 1)
      expect(pm.inputBuffer).toHaveLength(1);
      expect(pm.inputBuffer[0].seq).toBe(2);
    });

    test('no rollback when states match', () => {
      pm.bufferInput(1, new Set(), new Set(), 0.016);

      const snap = buildSnapshot(game, 1, 1, 0);
      pm.applyServerState(snap);

      expect(pm.rollbackCount).toBe(0);
    });
  });

  describe('Player 2 perspective', () => {
    test('uses p2_input_seq for confirmation', () => {
      const pm2 = new PredictionManager(game, 2);
      pm2.bufferInput(1, new Set(), new Set(), 0.016);
      pm2.bufferInput(2, new Set(), new Set(), 0.016);

      const snap = buildSnapshot(game, 1, 0, 1);
      pm2.applyServerState(snap);

      // P2 uses p2_input_seq: confirmed seq 1, keep seq 2
      expect(pm2.lastConfirmedSeq).toBe(1);
      expect(pm2.inputBuffer).toHaveLength(1);
      expect(pm2.inputBuffer[0].seq).toBe(2);
    });
  });
});

// ─────────────────────────────────────────────
// Fighter toSnapshot / fromSnapshot tests
// ─────────────────────────────────────────────

describe('Fighter snapshot roundtrip', () => {
  test('toSnapshot captures all simulation state', () => {
    const f = new MockFighter(150, 200);
    f.vx = 100;
    f.vy = -50;
    f.facing = -1;
    f.state = 'attack';
    f.health = 75;
    f.currentAttack = 'lightPunch';
    f.attackFrame = 3.5;
    f.attackContext = 'air';
    f.attackHasHit = true;
    f.stunFrames = 5;
    f.dashTimer = 0.1;
    f.dashDir = 1;
    f.isFlipping = true;
    f.flipAngle = 1.57;
    f.jumpCount = 2;
    f.flipCount = 1;

    const snap = f.toSnapshot();

    expect(snap.x).toBe(150);
    expect(snap.y).toBe(200);
    expect(snap.vx).toBe(100);
    expect(snap.vy).toBe(-50);
    expect(snap.facing).toBe(-1);
    expect(snap.state).toBe('attack');
    expect(snap.health).toBe(75);
    expect(snap.current_attack).toBe('lightPunch');
    expect(snap.attack_frame).toBe(3.5);
    expect(snap.attack_context).toBe('air');
    expect(snap.attack_has_hit).toBe(true);
    expect(snap.stun_frames).toBe(5);
    expect(snap.dash_timer).toBe(0.1);
    expect(snap.dash_dir).toBe(1);
    expect(snap.is_flipping).toBe(true);
    expect(snap.flip_angle).toBe(1.57);
    expect(snap.jump_count).toBe(2);
    expect(snap.flip_count).toBe(1);
  });

  test('fromSnapshot restores all simulation state', () => {
    const f = new MockFighter(0, 0);
    const snap = {
      x: 300, y: 180, vx: -200, vy: 50,
      facing: -1, state: 'hitstun', health: 40,
      current_attack: 'heavyKick',
      attack_frame: 7,
      attack_context: 'crouch',
      attack_has_hit: false,
      stun_frames: 12,
      dash_timer: 0.05,
      dash_dir: -1,
      is_flipping: false,
      flip_angle: 0,
      jump_count: 1,
      flip_count: 0,
    };

    f.fromSnapshot(snap);

    expect(f.x).toBe(300);
    expect(f.y).toBe(180);
    expect(f.vx).toBe(-200);
    expect(f.vy).toBe(50);
    expect(f.facing).toBe(-1);
    expect(f.state).toBe('hitstun');
    expect(f.health).toBe(40);
    expect(f.currentAttack).toBe('heavyKick');
    expect(f.attackFrame).toBe(7);
    expect(f.attackContext).toBe('crouch');
    expect(f.attackHasHit).toBe(false);
    expect(f.stunFrames).toBe(12);
    expect(f.dashTimer).toBe(0.05);
    expect(f.dashDir).toBe(-1);
    expect(f.isFlipping).toBe(false);
    expect(f.flipAngle).toBe(0);
    expect(f.jumpCount).toBe(1);
    expect(f.flipCount).toBe(0);
    expect(f._prevImpact).toBeNull();
  });

  test('roundtrip preserves state', () => {
    const f1 = new MockFighter(250, 220);
    f1.state = 'jump';
    f1.vy = -300;
    f1.jumpCount = 1;

    const snap = f1.toSnapshot();
    const f2 = new MockFighter(0, 0);
    f2.fromSnapshot(snap);

    expect(f2.x).toBe(f1.x);
    expect(f2.y).toBe(f1.y);
    expect(f2.vy).toBe(f1.vy);
    expect(f2.state).toBe(f1.state);
    expect(f2.jumpCount).toBe(f1.jumpCount);
  });
});
