// ─────────────────────────────────────────────
// Client-side prediction with rollback reconciliation
// ─────────────────────────────────────────────
// The client runs the full game loop locally for immediate input feedback.
// The server sends authoritative state snapshots at 20Hz. When the client
// detects a mismatch, it rolls back to the server state and replays
// buffered local inputs to bring the prediction up to date.
//
// Visual smoothing prevents jarring snaps — position offsets decay over
// several frames so corrections look natural.

const INPUT_BUFFER_SIZE = 60;    // ~1 second at 60fps
const POS_THRESHOLD = 3;         // pixels — trigger rollback
const HEALTH_THRESHOLD = 0.1;    // HP — trigger rollback
const SMOOTHING_FACTOR = 0.15;   // per-frame decay rate for visual offsets

export class PredictionManager {
  /**
   * @param {import('./game.js').Game} game — the live game instance
   * @param {number} playerNum — 1 or 2 (which player we are)
   */
  constructor(game, playerNum) {
    this.game = game;
    this.playerNum = playerNum;

    // Rolling window of local player inputs for replay
    // Each entry: { seq, actions: Set, pressed: Set, dt: number }
    this.inputBuffer = [];
    this.inputSeq = 0;

    // Last confirmed input sequence the server processed for us
    this.lastConfirmedSeq = -1;

    // Visual smoothing offsets (pixels, decayed each frame)
    this.smoothP1 = { dx: 0, dy: 0 };
    this.smoothP2 = { dx: 0, dy: 0 };

    // Stats
    this.rollbackCount = 0;
  }

  /** Get the next input sequence number. */
  nextSeq() {
    return ++this.inputSeq;
  }

  /**
   * Buffer a local input frame for potential replay.
   * Called in endFrame() after the game loop has consumed the inputs.
   */
  bufferInput(seq, actions, pressed, dt) {
    this.inputBuffer.push({
      seq,
      actions: new Set(actions),
      pressed: new Set(pressed),
      dt: dt || 0.016,
    });

    if (this.inputBuffer.length > INPUT_BUFFER_SIZE) {
      this.inputBuffer.shift();
    }
  }

  /**
   * Process an authoritative server state snapshot.
   * Applies health/timer authoritatively, detects mismatches,
   * and performs rollback + replay when needed.
   */
  applyServerState(snapshot) {
    // Don't process during pre-fight phases
    if (this.game.waitingForProviders || this.game.fightAlert > 0) return;

    const confirmedSeq = this.playerNum === 1
      ? (snapshot.p1_input_seq || 0)
      : (snapshot.p2_input_seq || 0);

    // Ignore stale snapshots
    if (confirmedSeq > 0 && confirmedSeq <= this.lastConfirmedSeq) return;
    if (confirmedSeq > 0) this.lastConfirmedSeq = confirmedSeq;

    // Always apply authoritative values
    this.game.p1.health = snapshot.p1.health;
    this.game.p2.health = snapshot.p2.health;
    this.game.roundTimer = snapshot.round_timer;
    if (snapshot.round_over) this.game.roundOver = true;

    // Sync projectiles from server state
    if (snapshot.projectiles) {
      this.game.projectiles = snapshot.projectiles.map(p => ({
        x: p.x, y: p.y, vx: p.vx, owner: p.owner, active: p.active, animTimer: 0,
      }));
    }

    // Check if rollback is needed
    if (this._needsRollback(snapshot)) {
      this._rollbackAndReplay(snapshot, confirmedSeq);
    }

    // Trim inputs the server has confirmed
    if (confirmedSeq > 0) {
      this.inputBuffer = this.inputBuffer.filter(i => i.seq > confirmedSeq);
    }
  }

  /**
   * Decay visual smoothing offsets. Call each frame with frame dt.
   * Offsets shrink exponentially, giving a smooth correction over ~5-8 frames.
   */
  updateSmoothing(dt) {
    const decay = Math.pow(1 - SMOOTHING_FACTOR, dt * 60);
    this.smoothP1.dx *= decay;
    this.smoothP1.dy *= decay;
    this.smoothP2.dx *= decay;
    this.smoothP2.dy *= decay;

    // Zero out sub-pixel offsets
    if (Math.abs(this.smoothP1.dx) < 0.5) this.smoothP1.dx = 0;
    if (Math.abs(this.smoothP1.dy) < 0.5) this.smoothP1.dy = 0;
    if (Math.abs(this.smoothP2.dx) < 0.5) this.smoothP2.dx = 0;
    if (Math.abs(this.smoothP2.dy) < 0.5) this.smoothP2.dy = 0;
  }

  /** Check if the local state diverges enough from the server to warrant rollback. */
  _needsRollback(snapshot) {
    const p1 = this.game.p1;
    const p2 = this.game.p2;

    return (
      Math.abs(p1.x - snapshot.p1.x) > POS_THRESHOLD ||
      Math.abs(p1.y - snapshot.p1.y) > POS_THRESHOLD ||
      Math.abs(p2.x - snapshot.p2.x) > POS_THRESHOLD ||
      Math.abs(p2.y - snapshot.p2.y) > POS_THRESHOLD ||
      p1.state !== snapshot.p1.state ||
      p2.state !== snapshot.p2.state ||
      Math.abs(p1.health - snapshot.p1.health) > HEALTH_THRESHOLD ||
      Math.abs(p2.health - snapshot.p2.health) > HEALTH_THRESHOLD
    );
  }

  /**
   * Rollback to server state and replay unconfirmed local inputs.
   * Visual smoothing offsets hide the correction from the player.
   */
  _rollbackAndReplay(snapshot, confirmedSeq) {
    // Save pre-rollback display positions for smoothing
    const prevP1X = this.game.p1.x;
    const prevP1Y = this.game.p1.y;
    const prevP2X = this.game.p2.x;
    const prevP2Y = this.game.p2.y;

    // Rewind: restore both fighters to authoritative server state
    this.game.p1.fromSnapshot(snapshot.p1);
    this.game.p2.fromSnapshot(snapshot.p2);

    // Replay: re-apply unconfirmed local inputs
    const unconfirmed = confirmedSeq > 0
      ? this.inputBuffer.filter(i => i.seq > confirmedSeq)
      : this.inputBuffer;

    for (const input of unconfirmed) {
      this._replayTick(input);
    }

    // Set visual smoothing offsets (old display position - new predicted position)
    this.smoothP1.dx += prevP1X - this.game.p1.x;
    this.smoothP1.dy += prevP1Y - this.game.p1.y;
    this.smoothP2.dx += prevP2X - this.game.p2.x;
    this.smoothP2.dy += prevP2Y - this.game.p2.y;

    this.rollbackCount++;
  }

  /**
   * Replay one frame of local inputs without visual side effects.
   * The remote player gets empty inputs (their state came from the server).
   */
  _replayTick(input) {
    const { p1, p2 } = this.game;
    const dt = input.dt;

    // Update facing
    if (p1.x < p2.x) { p1.facing = 1; p2.facing = -1; }
    else { p1.facing = -1; p2.facing = 1; }

    // Clear per-frame events (prevent stale accumulation)
    p1.events.clear();
    p2.events.clear();

    // Build input sets: local player gets buffered inputs, remote gets nothing
    const emptySet = new Set();
    const [p1Actions, p1Pressed, p2Actions, p2Pressed] = this.playerNum === 1
      ? [input.actions, input.pressed, emptySet, emptySet]
      : [emptySet, emptySet, input.actions, input.pressed];

    // Advance both fighters
    p1.update(dt, p1Actions, p1Pressed, p2, this.game.stageLeft, this.game.stageRight);
    p2.update(dt, p2Actions, p2Pressed, p1, this.game.stageLeft, this.game.stageRight);

    // Maintain impact tracking for hitbox accuracy
    p1.updateImpactTracking();
    p2.updateImpactTracking();
  }
}
