import { Actions } from "./input.js";
import { Fighter } from "./fighter.js";
import { DG } from "./ui.js";

// ─────────────────────────────────────────────
// Stage — margins as percentage of canvas width
// ─────────────────────────────────────────────
const STAGE_MARGIN = 0.05;

// ─────────────────────────────────────────────
// SNES-style controller button layout
// ─────────────────────────────────────────────
const P1_CONTROLLER = {
  dpad: [
    { action: Actions.UP, label: "W", dx: 0, dy: -1 },
    { action: Actions.DOWN, label: "S", dx: 0, dy: 1 },
    { action: Actions.LEFT, label: "A", dx: -1, dy: 0 },
    { action: Actions.RIGHT, label: "D", dx: 1, dy: 0 },
  ],
  buttons: [
    { action: Actions.MEDIUM_PUNCH, label: "I", dx: 0, dy: -1 }, // top (X position on SNES)
    { action: Actions.LIGHT_KICK, label: "J", dx: -1, dy: 0 }, // left (Y position)
    { action: Actions.LIGHT_PUNCH, label: "U", dx: 1, dy: 0 }, // right (A position)
    { action: Actions.MEDIUM_KICK, label: "K", dx: 0, dy: 1 }, // bottom (B position)
  ],
  shoulders: [
    { action: Actions.HEAVY_KICK, label: "L", side: "left" },
    { action: Actions.HEAVY_PUNCH, label: "O", side: "right" },
  ],
};

const P2_CONTROLLER = {
  dpad: [
    { action: Actions.UP, label: "↑", dx: 0, dy: -1 },
    { action: Actions.DOWN, label: "↓", dx: 0, dy: 1 },
    { action: Actions.LEFT, label: "←", dx: -1, dy: 0 },
    { action: Actions.RIGHT, label: "→", dx: 1, dy: 0 },
  ],
  buttons: [
    { action: Actions.MEDIUM_PUNCH, label: "5", dx: 0, dy: -1 },
    { action: Actions.LIGHT_KICK, label: "1", dx: -1, dy: 0 },
    { action: Actions.LIGHT_PUNCH, label: "4", dx: 1, dy: 0 },
    { action: Actions.MEDIUM_KICK, label: "2", dx: 0, dy: 1 },
  ],
  shoulders: [
    { action: Actions.HEAVY_KICK, label: "3", side: "left" },
    { action: Actions.HEAVY_PUNCH, label: "6", side: "right" },
  ],
};

// ─────────────────────────────────────────────
// Game
// ─────────────────────────────────────────────
export class Game {
  constructor(
    canvas,
    p1Input,
    p2Input,
    sfx = null,
    { p1Label = "P1", p2Label = "P2" } = {},
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = window.devicePixelRatio || 1;
    this.p1Input = p1Input;
    this.p2Input = p2Input;
    this.sfx = sfx;
    this.p1Label = p1Label;
    this.p2Label = p2Label;

    // Game logic works in CSS pixel space
    const logicalW = canvas.width / this.dpr;
    const logicalH = canvas.height / this.dpr;

    const floorY = logicalH - 160;
    const stageLeft = logicalW * STAGE_MARGIN;
    const stageRight = logicalW * (1 - STAGE_MARGIN);
    const startOffset = (stageRight - stageLeft) * 0.25;

    this.p1 = new Fighter(stageLeft + startOffset, floorY, 1, DG.primary);
    this.p2 = new Fighter(stageRight - startOffset, floorY, -1, DG.secondary);

    this.lastTime = 0;
    this.running = false;
    this.roundOver = false;
    this.roundTimer = 99;
    this.hitSparks = [];
    this._lastClashKey = null;

    // Fight alert state
    this.fightAlert = 0; // countdown timer for "FIGHT!" display
    this.fightAlertDuration = 1.5; // seconds to show
    this.waitingForProviders = true; // true until all adapters signal ready

    // Damage log — recent combat events shown between controllers
    this.damageLog = []; // { text, color, side, time }

    // Live voice transcripts — set by VoiceAdapter / PhoneAdapter
    this.p1Transcript = null; // { segments: [{text, matched}], fade: 0-1 }
    this.p2Transcript = null;

    // Phone info — set by PhoneAdapter
    this.p1PhoneInfo = null; // { number: '+15551234567', connected: false }
    this.p2PhoneInfo = null;

    // Visual button latch — keeps buttons lit for a visible duration
    this._p1Latch = new Map(); // action → remaining seconds
    this._p2Latch = new Map();

    // Prediction manager — set by multiplayer code (null for single player)
    this.predictionManager = null;

    // LLM toast — set by LLMAdapter when AI is unavailable
    this.p1LlmToast = null; // { text, time }
    this.p2LlmToast = null;

    // LLM thinking — set by LLMAdapter while requesting a plan
    this.p1LlmThinking = false;
    this.p2LlmThinking = false;
  }

  /** Logical (CSS pixel) dimensions */
  get logicalW() {
    return this.canvas.width / this.dpr;
  }
  get logicalH() {
    return this.canvas.height / this.dpr;
  }
  get stageLeft() {
    return this.logicalW * STAGE_MARGIN;
  }
  get stageRight() {
    return this.logicalW * (1 - STAGE_MARGIN);
  }
  get floorY() {
    return this.logicalH - 160;
  }

  start() {
    this.running = true;
    this.lastTime = performance.now();
    this._loop(this.lastTime);
  }

  /** All providers ready — show "FIGHT!" alert then start the round */
  showFightAlert() {
    this.waitingForProviders = false;
    this.fightAlert = this.fightAlertDuration;
  }

  _loop(timestamp) {
    if (!this.running) return;

    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.05);
    this.lastTime = timestamp;

    // Update floor position on resize
    this.p1.floorY = this.floorY;
    this.p2.floorY = this.floorY;

    // Tick timed adapters (CommandAdapter holds)
    this.p1Input.update(dt);
    this.p2Input.update(dt);

    this._dt = dt;
    this._update(dt);
    if (this.predictionManager) this.predictionManager.updateSmoothing(dt);
    this._draw();

    this.p1Input.endFrame();
    this.p2Input.endFrame();

    requestAnimationFrame((t) => this._loop(t));
  }

  _update(dt) {
    // Waiting for providers or showing fight alert — no game logic
    if (this.waitingForProviders) return;
    if (this.fightAlert > 0) {
      this.fightAlert -= dt;
      return;
    }

    if (this.roundOver) return;

    this.roundTimer -= dt;
    if (this.roundTimer <= 0) {
      this.roundTimer = 0;
      this.roundOver = true;
      return;
    }

    // Update facing
    if (this.p1.x < this.p2.x) {
      this.p1.facing = 1;
      this.p2.facing = -1;
    } else {
      this.p1.facing = -1;
      this.p2.facing = 1;
    }

    // Update adapter facing for semantic commands (voice/LLM)
    for (const adapter of this.p1Input.adapters) {
      if (adapter.setFacing) adapter.setFacing(this.p1.facing);
    }
    for (const adapter of this.p2Input.adapters) {
      if (adapter.setFacing) adapter.setFacing(this.p2.facing);
    }

    const p1Actions = this.p1Input.getActions();
    const p1Pressed = this.p1Input.getJustPressed();
    const p2Actions = this.p2Input.getActions();
    const p2Pressed = this.p2Input.getJustPressed();

    this.p1.update(
      dt,
      p1Actions,
      p1Pressed,
      this.p2,
      this.stageLeft,
      this.stageRight,
    );
    this.p2.update(
      dt,
      p2Actions,
      p2Pressed,
      this.p1,
      this.stageLeft,
      this.stageRight,
    );

    // Dispatch fighter events → SFX
    if (this.sfx) {
      this._dispatchFighterSfx(this.p1);
      this._dispatchFighterSfx(this.p2);
    }

    // Check attack clash first — if both hitboxes collide, both take damage
    const clashed = this._checkClash(this.p1, this.p2);

    // Normal hit checks only if no clash occurred
    if (!clashed) {
      this._checkHit(this.p1, this.p2, p2Actions);
      this._checkHit(this.p2, this.p1, p1Actions);
    }

    // Track impact points for swept collision next frame
    this.p1.updateImpactTracking();
    this.p2.updateImpactTracking();

    this.hitSparks = this.hitSparks.filter((s) => {
      s.life -= dt;
      return s.life > 0;
    });

    this.damageLog = this.damageLog.filter((e) => {
      e.time -= dt;
      return e.time > 0;
    });

    // Tick down LLM toast timers
    if (this.p1LlmToast) {
      this.p1LlmToast.time -= dt;
      if (this.p1LlmToast.time <= 0) this.p1LlmToast = null;
    }
    if (this.p2LlmToast) {
      this.p2LlmToast.time -= dt;
      if (this.p2LlmToast.time <= 0) this.p2LlmToast = null;
    }

    if (this.p1.health <= 0 || this.p2.health <= 0) {
      this.roundOver = true;
    }
  }

  _checkClash(f1, f2) {
    const h1 = f1.getAttackHitbox();
    const h2 = f2.getAttackHitbox();
    if (!h1 || !h2) return false;

    // Prevent multi-clash on same attack frame pair
    const clashKey = `${f1.attackFrame},${f2.attackFrame}`;
    if (this._lastClashKey === clashKey) return false;

    // Check if the two attack hitboxes overlap
    if (
      !(
        h1.x < h2.x + h2.w &&
        h1.x + h1.w > h2.x &&
        h1.y < h2.y + h2.h &&
        h1.y + h1.h > h2.y
      )
    ) {
      return false;
    }

    this._lastClashKey = clashKey;

    // Both fighters take the other's attack damage at limb multiplier (0.5x)
    const d1 = f1.getAttackData();
    const d2 = f2.getAttackData();
    f1.attackHasHit = true;
    f2.attackHasHit = true;
    if (d1) f2.applyHit(d1, 0.5, f1.x);
    if (d2) f1.applyHit(d2, 0.5, f2.x);

    // Clash spark at midpoint
    const cx = (h1.x + h1.w / 2 + h2.x + h2.w / 2) / 2;
    const cy = (h1.y + h1.h / 2 + h2.y + h2.h / 2) / 2;
    this.hitSparks.push({
      x: cx,
      y: cy,
      life: 0.5,
      color: "#ffffff",
      text: "CLASH!",
    });
    this._logEvent("CLASH!", "#ffffff", "center");

    if (this.sfx) this.sfx.clash();

    this._injectVoiceContext(
      f1,
      this._buildContext(f1, f2, "CLASH! Both attacks collided mid-air!"),
    );
    this._injectVoiceContext(
      f2,
      this._buildContext(f2, f1, "CLASH! Both attacks collided mid-air!"),
    );

    return true;
  }

  _checkHit(attacker, defender, defenderActions) {
    // getAttackHit checks attackHasHit internally — returns null if already hit
    const result = attacker.getAttackHit(defender);
    if (!result) return;

    const { hitData, zone, multiplier } = result;
    // Grab hitbox position for spark BEFORE marking as hit
    const hitbox = attacker.getAttackHitbox();
    const sparkX = hitbox
      ? hitbox.x + hitbox.w / 2
      : (attacker.x + defender.x) / 2;
    const sparkY = hitbox ? hitbox.y + hitbox.h / 2 : defender.y - 70;

    // Mark this attack as having connected — prevents further hits
    attacker.attackHasHit = true;

    const atkSide = attacker === this.p1 ? "p1" : "p2";

    if (defender.isBlocking(defenderActions) && defender.grounded) {
      defender.applyBlock(hitData);
      this.hitSparks.push({
        x: sparkX,
        y: sparkY,
        life: 0.15,
        color: "#4488ff",
        text: "BLOCK",
      });
      this._logEvent("BLOCKED", "#4488ff", atkSide);
      if (this.sfx) this.sfx.block();
      this._injectVoiceContext(
        defender,
        this._buildContext(defender, attacker, "You BLOCKED an attack! Nice."),
      );
      this._injectVoiceContext(
        attacker,
        this._buildContext(
          attacker,
          defender,
          "Your attack was BLOCKED by the opponent.",
        ),
      );
    } else {
      defender.applyHit(hitData, multiplier, attacker.x);
      const totalDmg = Math.round(hitData.damage * multiplier * 10) / 10;
      let color = "#ffcc00";
      let text = `${totalDmg}`;
      let logText = `${totalDmg} dmg`;
      let hitDesc = `You got HIT for ${totalDmg} damage!`;
      let atkDesc = `You LANDED a hit for ${totalDmg} damage!`;
      if (zone === "head") {
        color = "#ff6600";
        text = `${totalDmg} HEAD!`;
        logText = `${totalDmg} HEAD`;
        if (this.sfx) this.sfx.headshot();
        hitDesc = `HEADSHOT! You took ${totalDmg} damage to the head!`;
        atkDesc = `HEADSHOT! You nailed them in the head for ${totalDmg}!`;
      } else if (zone === "crotch") {
        color = "#ff00ff";
        text = `${totalDmg} CROTCH!`;
        logText = `${totalDmg} CROTCH`;
        if (this.sfx) this.sfx.crotchshot();
        hitDesc = `CROTCH SHOT! You took ${totalDmg} damage below the belt!`;
        atkDesc = `LOW BLOW! You hit them in the crotch for ${totalDmg}!`;
      } else {
        if (zone === "arm" || zone === "leg") {
          color = "#88aaaa";
          logText = `${totalDmg} ${zone}`;
        }
        if (this.sfx) this.sfx.hit();
      }
      this.hitSparks.push({ x: sparkX, y: sparkY, life: 0.4, color, text });
      this._logEvent(logText, color, atkSide);
      this._injectVoiceContext(
        defender,
        this._buildContext(defender, attacker, hitDesc),
      );
      this._injectVoiceContext(
        attacker,
        this._buildContext(attacker, defender, atkDesc),
      );
    }
  }

  _logEvent(text, color, side) {
    this.damageLog.push({ text, color, side, time: 3.0 });
    if (this.damageLog.length > 8) this.damageLog.shift();
  }

  /** Build fight state context string for voice agent injection */
  _buildContext(fighter, opponent, event) {
    const side = fighter === this.p1 ? "P1" : "P2";
    const opSide = fighter === this.p1 ? "P2" : "P1";
    const dist = Math.abs(fighter.x - opponent.x);
    const facing = fighter.facing === 1 ? "right" : "left";
    const opFacing = opponent.facing === 1 ? "right" : "left";
    const airborne = !fighter.grounded ? ", airborne" : "";
    const opAirborne = !opponent.grounded ? ", airborne" : "";

    return `[FIGHT CONTEXT] ${event}
You (${side}): health=${fighter.health}/200, state=${fighter.state}${airborne}, facing ${facing}
Opponent (${opSide}): health=${opponent.health}/200, state=${opponent.state}${opAirborne}, facing ${opFacing}
Distance: ${Math.round(dist)}px | Timer: ${Math.ceil(this.roundTimer)}s`;
  }

  /** Send context to voice adapters for a specific fighter */
  _injectVoiceContext(fighter, context) {
    const input = fighter === this.p1 ? this.p1Input : this.p2Input;
    for (const adapter of input.adapters) {
      if (adapter.injectContext) {
        adapter.injectContext(context);
      }
    }
  }

  _dispatchFighterSfx(fighter) {
    for (const evt of fighter.events) {
      if (evt === "somersault") this.sfx.somersault();
      else if (evt === "dash") this.sfx.dash();
      else if (evt.startsWith("punch:")) this.sfx.whoosh();
      else if (evt.startsWith("kick:")) this.sfx.whoosh();
    }
  }

  // ─────────────────────────────────────────
  // Drawing
  // ─────────────────────────────────────────
  _draw() {
    const { ctx, canvas, dpr } = this;

    // Clear at physical resolution, then scale to CSS pixels
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = DG.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Scale context so all drawing is in CSS pixel space
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = this.logicalW;
    const h = this.logicalH;
    const floorY = this.floorY;

    // Floor line with subtle gradient
    const floorGrad = ctx.createLinearGradient(
      this.stageLeft,
      0,
      this.stageRight,
      0,
    );
    floorGrad.addColorStop(0, DG.gradStart);
    floorGrad.addColorStop(1, DG.gradEnd);
    ctx.strokeStyle = floorGrad;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(this.stageLeft, floorY);
    ctx.lineTo(this.stageRight, floorY);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Stage boundary markers
    ctx.strokeStyle = DG.border;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(this.stageLeft, floorY - 200);
    ctx.lineTo(this.stageLeft, floorY);
    ctx.moveTo(this.stageRight, floorY - 200);
    ctx.lineTo(this.stageRight, floorY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Fighters (with visual smoothing offsets for prediction corrections)
    const pm = this.predictionManager;
    if (pm) {
      this.p1.x += pm.smoothP1.dx;
      this.p1.y += pm.smoothP1.dy;
      this.p2.x += pm.smoothP2.dx;
      this.p2.y += pm.smoothP2.dy;
    }
    this.p1.draw(ctx);
    this.p2.draw(ctx);
    this.p1.drawHitboxes(ctx);
    this.p2.drawHitboxes(ctx);
    if (pm) {
      this.p1.x -= pm.smoothP1.dx;
      this.p1.y -= pm.smoothP1.dy;
      this.p2.x -= pm.smoothP2.dx;
      this.p2.y -= pm.smoothP2.dy;
    }

    // Hit sparks + damage text
    for (const spark of this.hitSparks) {
      const alpha = Math.min(1, spark.life / 0.2);
      const rise = (0.4 - spark.life) * 40;

      const size = 18 * alpha;
      ctx.fillStyle = spark.color;
      ctx.globalAlpha = alpha * 0.6;
      ctx.fillRect(spark.x - size / 2, spark.y - size / 2 - rise, size, size);

      if (spark.text) {
        ctx.globalAlpha = alpha;
        ctx.font = "bold 14px monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = spark.color;
        ctx.fillText(spark.text, spark.x, spark.y - 12 - rise);
      }

      ctx.globalAlpha = 1;
    }

    // HUD
    this._drawHUD();

    // Voice transcripts — just above the floor
    const txY = this.floorY + 16;
    this._drawTranscript(ctx, this.p1Transcript, w / 2, txY, DG.primary);
    this._drawTranscript(ctx, this.p2Transcript, w / 2, txY + 16, DG.secondary);

    // Controller overlays — merge held + justPressed, decompose compound actions
    const dt = this._dt || 0.016;
    const p1Visual = this._buildVisualActions(
      this.p1Input,
      this.p1.facing,
      this._p1Latch,
      dt,
    );
    const p2Visual = this._buildVisualActions(
      this.p2Input,
      this.p2.facing,
      this._p2Latch,
      dt,
    );
    const ctrlY = this.floorY + 24;
    this._drawController(ctx, P1_CONTROLLER, 30, ctrlY, p1Visual, DG.primary);
    this._drawController(
      ctx,
      P2_CONTROLLER,
      w - 200,
      ctrlY,
      p2Visual,
      DG.secondary,
    );

    // Damage log between controllers
    this._drawDamageLog(ctx, w, this.floorY + 160);

    // Phone number display — shown until call connects
    this._drawPhoneInfo(ctx, w, h);

    // LLM toast indicators
    this._drawLlmToast(ctx, this.p1LlmToast, 30 + 85, this.floorY + 16, DG.primary);
    this._drawLlmToast(ctx, this.p2LlmToast, w - 200 + 85, this.floorY + 16, DG.secondary);

    // LLM thinking indicators (shown when no error toast is active)
    if (this.p1LlmThinking && !this.p1LlmToast) {
      this._drawLlmThinking(ctx, 30 + 85, this.floorY + 16, DG.primary);
    }
    if (this.p2LlmThinking && !this.p2LlmToast) {
      this._drawLlmThinking(ctx, w - 200 + 85, this.floorY + 16, DG.secondary);
    }

    // "Waiting..." overlay
    if (this.waitingForProviders) {
      ctx.save();
      ctx.globalAlpha = 0.5 + Math.sin(performance.now() / 300) * 0.3;
      ctx.font = "bold 24px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = DG.slate;
      ctx.fillText("Connecting...", w / 2, this.floorY / 2);
      ctx.restore();
    }

    // "FIGHT!" alert overlay
    if (this.fightAlert > 0) {
      const progress = 1 - this.fightAlert / this.fightAlertDuration;
      const alpha =
        progress < 0.1
          ? progress / 0.1 // fade in
          : progress > 0.7
            ? (1 - progress) / 0.3 // fade out
            : 1;
      const scale = 1 + Math.sin(progress * Math.PI) * 0.15; // subtle pulse

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `bold ${Math.round(64 * scale)}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      // Gradient text effect
      const grad = ctx.createLinearGradient(w / 2 - 80, 0, w / 2 + 80, 0);
      grad.addColorStop(0, DG.gradStart);
      grad.addColorStop(1, DG.gradEnd);
      ctx.fillStyle = grad;
      ctx.fillText("FIGHT!", w / 2, h / 2);
      ctx.restore();
    }
  }

  _drawHUD() {
    const { ctx } = this;
    const w = this.logicalW;
    const maxHealth = 100;
    const timerWidth = 60;
    const margin = 40;
    const gap = 10;
    const barW = (w - margin * 2 - timerWidth - gap * 2) / 2;
    const barH = 20;

    const barY = 20;

    // P1 health — gradient fill
    const p1BarX = margin;
    ctx.fillStyle = DG.charcoal;
    ctx.fillRect(p1BarX, barY, barW, barH);
    const p1Pct = this.p1.health / maxHealth;
    if (p1Pct > 0.25) {
      const g1 = ctx.createLinearGradient(p1BarX, 0, p1BarX + barW, 0);
      g1.addColorStop(0, DG.gradStart);
      g1.addColorStop(1, DG.gradEnd);
      ctx.fillStyle = g1;
    } else {
      ctx.fillStyle = DG.danger;
    }
    ctx.fillRect(p1BarX, barY, barW * p1Pct, barH);
    ctx.strokeStyle = DG.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(p1BarX, barY, barW, barH);

    // P2 health — gradient fill (reversed)
    const p2BarX = w - margin - barW;
    ctx.fillStyle = DG.charcoal;
    ctx.fillRect(p2BarX, barY, barW, barH);
    const p2Pct = this.p2.health / maxHealth;
    if (p2Pct > 0.25) {
      const g2 = ctx.createLinearGradient(p2BarX, 0, p2BarX + barW, 0);
      g2.addColorStop(0, DG.gradEnd);
      g2.addColorStop(1, DG.gradStart);
      ctx.fillStyle = g2;
    } else {
      ctx.fillStyle = DG.danger;
    }
    const p2Fill = barW * p2Pct;
    ctx.fillRect(p2BarX + barW - p2Fill, barY, p2Fill, barH);
    ctx.strokeStyle = DG.border;
    ctx.strokeRect(p2BarX, barY, barW, barH);

    // Labels
    ctx.font = "bold 14px monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = DG.primary;
    ctx.fillText("P1", p1BarX, barY - 5);
    ctx.font = "11px monospace";
    ctx.fillStyle = DG.slate;
    ctx.fillText(this.p1Label, p1BarX + 26, barY - 5);

    ctx.font = "bold 14px monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = DG.secondary;
    ctx.fillText("P2", p2BarX + barW, barY - 5);
    ctx.font = "11px monospace";
    ctx.fillStyle = DG.slate;
    ctx.fillText(this.p2Label, p2BarX + barW - 26, barY - 5);

    // Timer
    ctx.fillStyle = DG.text;
    ctx.font = "bold 28px monospace";
    ctx.textAlign = "center";
    ctx.fillText(Math.ceil(this.roundTimer).toString(), w / 2, barY + barH - 2);

    // Round over text
    if (this.roundOver) {
      ctx.fillStyle = DG.text;
      ctx.font = "bold 48px monospace";
      ctx.textAlign = "center";
      let text = "TIME!";
      if (this.p1.health <= 0 && this.p2.health <= 0) text = "DOUBLE KO!";
      else if (this.p1.health <= 0) text = "P2 WINS!";
      else if (this.p2.health <= 0) text = "P1 WINS!";
      else if (this.p1.health > this.p2.health) text = "P1 WINS!";
      else if (this.p2.health > this.p1.health) text = "P2 WINS!";
      else text = "DRAW!";

      ctx.fillText(text, w / 2, this.logicalH / 2);

      ctx.font = "18px monospace";
      ctx.fillText("Press ENTER to restart", w / 2, this.logicalH / 2 + 40);
    }
  }

  // ─────────────────────────────────────────
  // Build visual action set for controller overlay
  // Merges held + justPressed, decomposes compound actions,
  // and latches edge-triggered actions so they stay lit visibly.
  // ─────────────────────────────────────────
  _buildVisualActions(input, facing, latch, dt) {
    const LATCH_TIME = 0.2; // seconds to keep button lit

    // Collect raw actions
    const raw = new Set(input.getActions());
    const pressed = input.getJustPressed();
    for (const a of pressed) raw.add(a);

    // Decompose compound actions into their visual button equivalents
    const decomposed = new Set();
    for (const a of raw) {
      decomposed.add(a);
      if (a === Actions.JUMP || a === Actions.SOMERSAULT) {
        decomposed.add(Actions.UP);
      } else if (a === Actions.DASH_FORWARD) {
        decomposed.add(facing === 1 ? Actions.RIGHT : Actions.LEFT);
      } else if (a === Actions.DASH_BACK) {
        decomposed.add(facing === 1 ? Actions.LEFT : Actions.RIGHT);
      } else if (a === Actions.DASH_LEFT) {
        decomposed.add(Actions.LEFT);
      } else if (a === Actions.DASH_RIGHT) {
        decomposed.add(Actions.RIGHT);
      }
    }

    // Latch newly active actions
    for (const a of decomposed) {
      latch.set(a, LATCH_TIME);
    }

    // Tick down and build final set
    const visual = new Set();
    for (const [action, remaining] of latch) {
      const next = remaining - dt;
      if (next > 0) {
        latch.set(action, next);
        visual.add(action);
      } else {
        latch.delete(action);
      }
    }

    // Always include currently held actions
    for (const a of raw) visual.add(a);

    return visual;
  }

  // ─────────────────────────────────────────
  // Voice transcript — ghosted text above the fight
  // ─────────────────────────────────────────
  _drawTranscript(ctx, transcript, cx, y, playerColor) {
    if (!transcript || !transcript.segments || transcript.segments.length === 0)
      return;

    const alpha = transcript.fade > 0 ? transcript.fade : 0.7;

    ctx.save();
    ctx.font = "12px monospace";
    ctx.textBaseline = "middle";

    // Measure total width to center
    const gap = 6;
    let totalW = 0;
    const widths = transcript.segments.map((seg) => {
      const w = ctx.measureText(seg.text).width;
      totalW += w + gap;
      return w;
    });
    totalW -= gap; // remove trailing gap

    let x = cx - totalW / 2;

    for (let i = 0; i < transcript.segments.length; i++) {
      const seg = transcript.segments[i];
      if (seg.matched) {
        // Matched action words — brighter, player color
        ctx.globalAlpha = alpha * 1.0;
        ctx.fillStyle = playerColor;
        ctx.font = "bold 12px monospace";
      } else {
        // Unmatched — softer but still readable
        ctx.globalAlpha = alpha * 0.6;
        ctx.fillStyle = DG.slate;
        ctx.font = "12px monospace";
      }
      ctx.textAlign = "left";
      ctx.fillText(seg.text, x, y);
      x += widths[i] + gap;
    }

    ctx.restore();
  }

  // ─────────────────────────────────────────
  // Damage log — rendered between the two controllers
  // ─────────────────────────────────────────
  _drawDamageLog(ctx, w, h) {
    if (this.damageLog.length === 0) return;

    ctx.save();
    ctx.font = "11px monospace";
    ctx.textBaseline = "top";

    const centerX = w / 2;
    const startY = h - 128;
    const lineH = 14;

    for (let i = 0; i < this.damageLog.length; i++) {
      const entry = this.damageLog[i];
      const alpha = Math.min(1, entry.time / 0.5); // fade out in last 0.5s
      ctx.globalAlpha = alpha * 0.7;
      ctx.fillStyle = entry.color;

      const y = startY + i * lineH;

      if (entry.side === "p1") {
        // P1 dealt damage — show with arrow: "P1 ► 6 dmg"
        ctx.textAlign = "center";
        ctx.fillText(`P1 \u25B8 ${entry.text}`, centerX, y);
      } else if (entry.side === "p2") {
        ctx.textAlign = "center";
        ctx.fillText(`${entry.text} \u25C2 P2`, centerX, y);
      } else {
        ctx.textAlign = "center";
        ctx.fillText(entry.text, centerX, y);
      }
    }

    ctx.restore();
  }

  // ─────────────────────────────────────────
  // Phone number HUD — shown until call connects
  // ─────────────────────────────────────────
  _drawLlmToast(ctx, toast, cx, y, color) {
    if (!toast) return;
    ctx.save();
    const alpha = Math.min(1, toast.time / 0.5); // fade out in last 0.5s
    ctx.globalAlpha = alpha * 0.85;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText(toast.text, cx, y);
    ctx.restore();
  }

  _drawLlmThinking(ctx, cx, y, color) {
    ctx.save();
    // Pulsing opacity for subtle "thinking" feel
    ctx.globalAlpha = 0.4 + 0.3 * Math.sin(performance.now() / 300);
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText('AI thinking...', cx, y);
    ctx.restore();
  }

  _drawPhoneInfo(ctx, w, h) {
    const infos = [
      { info: this.p1PhoneInfo, color: DG.primary, label: 'P1', x: w * 0.25 },
      { info: this.p2PhoneInfo, color: DG.secondary, label: 'P2', x: w * 0.75 },
    ];

    for (const { info, color, label, x } of infos) {
      if (!info) continue;

      ctx.save();
      const y = h / 2 + 30;

      if (info.connected) {
        ctx.globalAlpha = 0.5;
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = color;
        ctx.fillText('CONNECTED', x, y);
      } else {
        ctx.globalAlpha = 0.7 + Math.sin(performance.now() / 400) * 0.2;
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = DG.slate;
        ctx.fillText(`${label} CALL:`, x, y);
        ctx.font = 'bold 22px monospace';
        ctx.fillStyle = color;
        ctx.fillText(info.number || '...', x, y + 24);
      }

      ctx.restore();
    }
  }

  // ─────────────────────────────────────────
  // SNES-style controller overlay
  // ─────────────────────────────────────────
  _drawController(ctx, layout, x, y, activeActions, playerColor) {
    ctx.save();

    const btnSize = 18;
    const btnGap = 22;
    const dpadX = x + 30;
    const dpadY = y + 30;
    const faceX = x + 130;
    const faceY = y + 30;

    // Controller shell — SVG-based SNES outline, solid knockout background
    // SVG body path from svgrepo SNES controller (viewBox 0 0 76 76)
    // Left lobe center: (23.75, 39.58), Right lobe center: (50.67, 39.58)
    const svgLx = 23.75, svgRx = 50.6667, svgCy = 39.5833;
    const scale = (faceX - dpadX) / (svgRx - svgLx);
    const tx = dpadX - svgLx * scale;
    const ty = dpadY - svgCy * scale;

    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    const body = new Path2D(
      "M 23.75,49.0833C 18.5033,49.0833 14.25,44.83 14.25,39.5833" +
      "C 14.25,34.3366 18.5033,30.0833 23.75,30.0833L 50.6667,30.0833" +
      "C 55.9134,30.0833 60.1667,34.3366 60.1667,39.5833" +
      "C 60.1667,44.83 55.9134,49.0833 50.6667,49.0833" +
      "C 47.8531,49.0833 45.3252,47.8602 43.5857,45.9167" +
      "L 30.831,45.9167C 29.0915,47.8602 26.5636,49.0833 23.75,49.0833Z",
    );

    // Solid knockout fill — completely covers background
    ctx.globalAlpha = 1;
    ctx.fillStyle = DG.bg;
    ctx.fill(body);

    // Tinted overlay on top
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = DG.charcoal;
    ctx.fill(body);

    // Border
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = playerColor;
    ctx.lineWidth = 1 / scale;
    ctx.stroke(body);

    // D-pad recess circle
    const recess = new Path2D(
      "M 23.75,33.25C 20.2522,33.25 17.4166,36.0856 17.4166,39.5834" +
      "C 17.4166,43.0812 20.2522,45.9167 23.75,45.9167" +
      "C 27.2478,45.9167 30.0833,43.0812 30.0833,39.5834" +
      "C 30.0833,36.0856 27.2478,33.25 23.75,33.25Z",
    );
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = playerColor;
    ctx.fill(recess);

    // Face button recess circle
    ctx.save();
    ctx.translate(svgRx - svgLx, 0);
    ctx.fill(recess);
    ctx.restore();

    ctx.restore(); // undo scale+translate

    // D-pad — solid knockout per button
    for (const btn of layout.dpad) {
      const bx = dpadX + btn.dx * btnGap;
      const by = dpadY + btn.dy * btnGap;
      const active = activeActions.has(btn.action);

      // Solid knockout + button face
      ctx.globalAlpha = 1;
      ctx.fillStyle = DG.bg;
      ctx.fillRect(bx - btnSize / 2, by - btnSize / 2, btnSize, btnSize);
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = DG.charcoal;
      ctx.fillRect(bx - btnSize / 2, by - btnSize / 2, btnSize, btnSize);

      // Border — highlights on active
      ctx.strokeStyle = active ? playerColor : DG.pebble;
      ctx.lineWidth = active ? 2 : 1;
      ctx.globalAlpha = active ? 0.8 : 0.3;
      ctx.strokeRect(bx - btnSize / 2, by - btnSize / 2, btnSize, btnSize);

      // Label
      ctx.globalAlpha = active ? 0.9 : 0.5;
      ctx.fillStyle = active ? DG.text : DG.slate;
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(btn.label, bx, by);
    }

    // Face buttons — solid knockout per button
    for (const btn of layout.buttons) {
      const bx = faceX + btn.dx * btnGap;
      const by = faceY + btn.dy * btnGap;
      const active = activeActions.has(btn.action);
      const r = btnSize / 2;

      // Solid knockout + button face
      ctx.globalAlpha = 1;
      ctx.fillStyle = DG.bg;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = DG.charcoal;
      ctx.fill();

      // Border — highlights on active
      ctx.strokeStyle = active ? playerColor : DG.pebble;
      ctx.lineWidth = active ? 2 : 1;
      ctx.globalAlpha = active ? 0.8 : 0.3;
      ctx.stroke();

      // Label
      ctx.globalAlpha = active ? 0.9 : 0.5;
      ctx.fillStyle = active ? DG.text : DG.slate;
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(btn.label, bx, by);
    }

    // Shoulder buttons — solid knockout
    for (const btn of layout.shoulders) {
      const sx = btn.side === "left" ? dpadX - 20 : faceX - 20;
      const sy = y - 14;
      const sw = 40;
      const sh = 14;
      const active = activeActions.has(btn.action);

      // Solid knockout + button face
      ctx.globalAlpha = 1;
      ctx.fillStyle = DG.bg;
      ctx.beginPath();
      ctx.roundRect(sx, sy, sw, sh, 4);
      ctx.fill();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = DG.charcoal;
      ctx.fill();

      // Border — highlights on active
      ctx.strokeStyle = active ? playerColor : DG.pebble;
      ctx.lineWidth = active ? 2 : 1;
      ctx.globalAlpha = active ? 0.8 : 0.3;
      ctx.stroke();

      // Label
      ctx.globalAlpha = active ? 0.9 : 0.5;
      ctx.fillStyle = active ? DG.text : DG.slate;
      ctx.font = "9px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(btn.label, sx + sw / 2, sy + sh / 2);
    }

    ctx.restore();
  }
}
