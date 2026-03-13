import { Actions } from "./input.js";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const GRAVITY = 1800;
const JUMP_VELOCITY = -620;
const WALK_SPEED = 200;
const GROUND_Y = 0; // set relative to stage floor
const DASH_SPEED = 600;
const DASH_DURATION = 0.15; // seconds

const ATTACK_DATA = {
  [Actions.LIGHT_PUNCH]: {
    damage: 3,
    startup: 2,
    active: 2,
    recovery: 3,
    range: 40,
    hitstun: 8,
    blockstun: 5,
    type: "high",
  },
  [Actions.MEDIUM_PUNCH]: {
    damage: 6,
    startup: 3,
    active: 2,
    recovery: 5,
    range: 50,
    hitstun: 12,
    blockstun: 7,
    type: "high",
  },
  [Actions.HEAVY_PUNCH]: {
    damage: 10,
    startup: 5,
    active: 3,
    recovery: 8,
    range: 55,
    hitstun: 16,
    blockstun: 10,
    type: "high",
  },
  [Actions.LIGHT_KICK]: {
    damage: 3,
    startup: 2,
    active: 2,
    recovery: 4,
    range: 50,
    hitstun: 8,
    blockstun: 5,
    type: "low",
  },
  [Actions.MEDIUM_KICK]: {
    damage: 7,
    startup: 4,
    active: 2,
    recovery: 6,
    range: 60,
    hitstun: 12,
    blockstun: 7,
    type: "mid",
  },
  [Actions.HEAVY_KICK]: {
    damage: 11,
    startup: 6,
    active: 3,
    recovery: 10,
    range: 65,
    hitstun: 16,
    blockstun: 10,
    type: "low",
  },
};

const ATTACK_ACTIONS = new Set(Object.keys(ATTACK_DATA));

// ─────────────────────────────────────────────
// Fighter
// ─────────────────────────────────────────────
export class Fighter {
  constructor(x, floorY, facing, color) {
    // Position / physics
    this.x = x;
    this.y = floorY;
    this.floorY = floorY;
    this.vx = 0;
    this.vy = 0;
    this.facing = facing; // 1 = right, -1 = left

    // Dimensions (stick figure bounding)
    this.width = 40;
    this.height = 120;

    // State
    this.state = "idle"; // idle | walk | jump | crouch | attack | hitstun | blockstun
    this.health = 100;
    this.color = color;

    // Attack state
    this.currentAttack = null;
    this.attackFrame = 0;
    this.attackContext = "stand"; // 'stand' | 'crouch' | 'air'
    this.attackHasHit = false; // true once this attack connects
    this.stunFrames = 0;

    // Previous frame impact point for sweep detection
    this._prevImpact = null; // [wx, wy] or null

    // Animation helpers
    this.animTimer = 0;

    // Double jump
    this.jumpCount = 0;
    this.maxJumps = 2;
    this.flipAngle = 0; // radians, for somersault
    this.isFlipping = false;
    this.flipCount = 0;
    this.maxFlips = 2;

    // Dash
    this.dashTimer = 0; // time remaining in dash
    this.dashDir = 0; // -1 or 1

    // Per-frame events for SFX (consumed by Game each frame)
    this.events = new Set();
  }

  get grounded() {
    return this.y >= this.floorY;
  }

  /** Serialize all simulation state to a plain object (server snapshot format). */
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

  /** Restore simulation state from a snapshot (server format, snake_case keys). */
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

  get centerX() {
    return this.x;
  }

  get hurtboxLeft() {
    return this.x - this.width / 2;
  }

  get hurtboxRight() {
    return this.x + this.width / 2;
  }

  update(dt, actions, justPressed, opponent, stageLeft, stageRight) {
    this.events.clear();
    const frames = dt * 60; // convert to ~60fps frame units
    this.animTimer += dt;

    // Progress somersault
    if (this.isFlipping && !this.grounded) {
      this.flipAngle += dt * Math.PI * 4; // full rotation in ~0.5s
      if (this.flipAngle >= Math.PI * 2) {
        this.flipAngle = 0;
        this.isFlipping = false;
      }
    }

    // --- Stun states ---
    if (this.state === "hitstun" || this.state === "blockstun") {
      this.stunFrames -= frames;
      if (this.stunFrames <= 0) {
        this.stunFrames = 0;
        this.state = "idle";
      }
      this._applyPhysics(dt, stageLeft, stageRight, opponent);
      return;
    }

    // --- Attack state (still allows movement) ---
    if (this.state === "attack") {
      this.attackFrame += frames;
      const data = ATTACK_DATA[this.currentAttack];
      const totalFrames = data.startup + data.active + data.recovery;
      if (this.attackFrame >= totalFrames) {
        if (!this.grounded) this.state = "jump";
        else if (actions.has(Actions.DOWN)) this.state = "crouch";
        else this.state = "idle";
        this.currentAttack = null;
      }
      // Movement during attack
      this.vx = 0;
      if (actions.has(Actions.LEFT)) this.vx = -WALK_SPEED;
      if (actions.has(Actions.RIGHT)) this.vx = WALK_SPEED;
      this._applyPhysics(dt, stageLeft, stageRight, opponent);
      return;
    }

    // --- Dash (from compound actions) ---
    // Directional dashes (from keyboard: always left/right)
    if (justPressed.has(Actions.DASH_LEFT) && this.dashTimer <= 0) {
      this.dashTimer = DASH_DURATION;
      this.dashDir = -1;
      this.events.add("dash");
    }
    if (justPressed.has(Actions.DASH_RIGHT) && this.dashTimer <= 0) {
      this.dashTimer = DASH_DURATION;
      this.dashDir = 1;
      this.events.add("dash");
    }
    // Semantic dashes (from voice/LLM: relative to facing)
    if (justPressed.has(Actions.DASH_FORWARD) && this.dashTimer <= 0) {
      this.dashTimer = DASH_DURATION;
      this.dashDir = this.facing;
      this.events.add("dash");
    }
    if (justPressed.has(Actions.DASH_BACK) && this.dashTimer <= 0) {
      this.dashTimer = DASH_DURATION;
      this.dashDir = -this.facing;
      this.events.add("dash");
    }

    // --- Movement ---
    this.vx = 0;

    if (this.dashTimer > 0) {
      this.dashTimer -= dt;
      this.vx = this.dashDir * DASH_SPEED;
    } else {
      if (actions.has(Actions.LEFT)) this.vx = -WALK_SPEED;
      if (actions.has(Actions.RIGHT)) this.vx = WALK_SPEED;
    }

    if (actions.has(Actions.DOWN) && this.grounded) {
      this.state = "crouch";
      this.vx = 0;
      this.dashTimer = 0;
    } else if (!this.grounded) {
      this.state = "jump";
    } else if (this.vx !== 0) {
      this.state = "walk";
    } else {
      this.state = "idle";
    }

    // Reset jump count on landing
    if (this.grounded) {
      this.jumpCount = 0;
      this.flipCount = 0;
      this.isFlipping = false;
      this.flipAngle = 0;
    }

    // Jump (from compound action)
    if (justPressed.has(Actions.JUMP) && this.jumpCount < this.maxJumps) {
      this.vy = JUMP_VELOCITY;
      if (this.grounded) this.y -= 1;
      this.jumpCount++;
      this.state = "jump";
    }

    // Somersault (from compound action)
    if (
      justPressed.has(Actions.SOMERSAULT) &&
      !this.grounded &&
      this.flipCount < this.maxFlips
    ) {
      this.vy = JUMP_VELOCITY * 0.85;
      this.jumpCount = this.maxJumps; // consume remaining jumps
      this.flipCount++;
      this.isFlipping = true;
      this.flipAngle = 0;
      this.events.add("somersault");
    }

    // Attack input (edge-triggered) — allowed from any non-attack, non-stun state
    for (const action of justPressed) {
      if (ATTACK_ACTIONS.has(action) && this.state !== "attack") {
        // Track context for skeleton poses
        if (!this.grounded) this.attackContext = "air";
        else if (this.state === "crouch") this.attackContext = "crouch";
        else this.attackContext = "stand";

        this.state = "attack";
        this.currentAttack = action;
        this.attackFrame = 0;
        this.attackHasHit = false;
        const atkData = ATTACK_DATA[action];
        const isPunch = action.includes("Punch");
        this.events.add(
          isPunch ? `punch:${atkData.damage}` : `kick:${atkData.damage}`,
        );
        break;
      }
    }

    this._applyPhysics(dt, stageLeft, stageRight, opponent);
  }

  _applyPhysics(dt, stageLeft, stageRight, opponent) {
    // Gravity
    if (!this.grounded || this.vy < 0) {
      this.vy += GRAVITY * dt;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Floor clamp
    if (this.y >= this.floorY) {
      this.y = this.floorY;
      this.vy = 0;
    }

    // Stage bounds
    if (this.x - this.width / 2 < stageLeft)
      this.x = stageLeft + this.width / 2;
    if (this.x + this.width / 2 > stageRight)
      this.x = stageRight - this.width / 2;

    // Push apart (no overlapping)
    if (opponent) {
      const overlap = this._getOverlap(opponent);
      if (overlap > 0) {
        const push = overlap / 2;
        if (this.x < opponent.x) {
          this.x -= push;
          opponent.x += push;
        } else {
          this.x += push;
          opponent.x -= push;
        }
      }
    }
  }

  _getOverlap(other) {
    const myLeft = this.hurtboxLeft;
    const myRight = this.hurtboxRight;
    const otherLeft = other.hurtboxLeft;
    const otherRight = other.hurtboxRight;
    return Math.max(
      0,
      Math.min(myRight, otherRight) - Math.max(myLeft, otherLeft),
    );
  }

  // ─────────────────────────────────────────
  // Hitbox / Hurtbox system
  // ─────────────────────────────────────────

  /** Rotate a local skeleton point through flip angle, return world coords */
  _localToWorld(lx, ly) {
    if (this.isFlipping) {
      const pivotY = -55;
      const rx = lx;
      const ry = ly - pivotY;
      const angle = this.flipAngle * this.facing;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rotX = rx * cos - ry * sin;
      const rotY = rx * sin + ry * cos;
      return [this.x + rotX, this.y + rotY + pivotY];
    }
    return [this.x + lx, this.y + ly];
  }

  /**
   * Build a hurtbox for a limb segment from world-space endpoints.
   * Ensures minimum thickness so boxes don't collapse on any axis,
   * keeping them snug around the limb geometry.
   */
  _limbBox(zone, _localA, _localB, worldA, worldB, thickness, multiplier) {
    const cx = (worldA[0] + worldB[0]) / 2;
    const cy = (worldA[1] + worldB[1]) / 2;
    const spanX = Math.abs(worldA[0] - worldB[0]);
    const spanY = Math.abs(worldA[1] - worldB[1]);
    const w = Math.max(spanX + 4, thickness);
    const h = Math.max(spanY + 4, thickness);
    return { zone, x: cx - w / 2, y: cy - h / 2, w, h, multiplier };
  }

  /** Returns hurtboxes for every limb, in world coords */
  getHurtboxes() {
    const s = this._buildSkeleton();

    // World-space joints
    const head = this._localToWorld(s.head[0], s.head[1]);
    const shoulder = this._localToWorld(s.shoulder[0], s.shoulder[1]);
    const hip = this._localToWorld(s.hip[0], s.hip[1]);
    const kneeBack = this._localToWorld(s.kneeBack[0], s.kneeBack[1]);
    const kneeFront = this._localToWorld(s.kneeFront[0], s.kneeFront[1]);
    const footBack = this._localToWorld(s.footBack[0], s.footBack[1]);
    const footFront = this._localToWorld(s.footFront[0], s.footFront[1]);
    const elbowBack = this._localToWorld(s.elbowBack[0], s.elbowBack[1]);
    const elbowFront = this._localToWorld(s.elbowFront[0], s.elbowFront[1]);
    const handBack = this._localToWorld(s.handBack[0], s.handBack[1]);
    const handFront = this._localToWorld(s.handFront[0], s.handFront[1]);

    const LIMB_PAD = 4;
    const TORSO_PAD = 6;

    return [
      // Head — small fixed-size precision target (2x)
      {
        zone: "head",
        x: head[0] - 7,
        y: head[1] - 7,
        w: 14,
        h: 14,
        multiplier: 2,
      },
      // Crotch — tiny precision target (3x)
      {
        zone: "crotch",
        x: hip[0] - 2,
        y: hip[1] - 2,
        w: 4,
        h: 4,
        multiplier: 3,
      },
      // Torso (1x)
      this._limbBox("body", s.shoulder, s.hip, shoulder, hip, TORSO_PAD, 1),
      // Arms (0.5x)
      this._limbBox(
        "arm",
        s.shoulder,
        s.elbowBack,
        shoulder,
        elbowBack,
        LIMB_PAD,
        0.5,
      ),
      this._limbBox(
        "arm",
        s.elbowBack,
        s.handBack,
        elbowBack,
        handBack,
        LIMB_PAD,
        0.5,
      ),
      this._limbBox(
        "arm",
        s.shoulder,
        s.elbowFront,
        shoulder,
        elbowFront,
        LIMB_PAD,
        0.5,
      ),
      this._limbBox(
        "arm",
        s.elbowFront,
        s.handFront,
        elbowFront,
        handFront,
        LIMB_PAD,
        0.5,
      ),
      // Legs (0.5x)
      this._limbBox("leg", s.hip, s.kneeBack, hip, kneeBack, LIMB_PAD, 0.5),
      this._limbBox(
        "leg",
        s.kneeBack,
        s.footBack,
        kneeBack,
        footBack,
        LIMB_PAD,
        0.5,
      ),
      this._limbBox("leg", s.hip, s.kneeFront, hip, kneeFront, LIMB_PAD, 0.5),
      this._limbBox(
        "leg",
        s.kneeFront,
        s.footFront,
        kneeFront,
        footFront,
        LIMB_PAD,
        0.5,
      ),
    ];
  }

  /** Returns the current attack impact point in world coords, or null */
  _getImpactPoint() {
    if (this.state !== "attack" || !this.currentAttack) return null;
    const skeleton = this._buildSkeleton();
    const isPunch = this.currentAttack.includes("Punch");
    const joint = isPunch ? skeleton.handFront : skeleton.footFront;
    return this._localToWorld(joint[0], joint[1]);
  }

  /** Returns the attack hitbox rect in world coords, or null if not in active frames or already hit */
  getAttackHitbox() {
    if (this.state !== "attack" || !this.currentAttack || this.attackHasHit)
      return null;
    const data = ATTACK_DATA[this.currentAttack];
    if (
      this.attackFrame < data.startup ||
      this.attackFrame >= data.startup + data.active
    ) {
      return null;
    }

    const impact = this._getImpactPoint();
    if (!impact) return null;
    const pad = 4;

    // If we have a previous impact point, build a swept box covering the path
    if (this._prevImpact) {
      const minX = Math.min(impact[0], this._prevImpact[0]) - pad;
      const minY = Math.min(impact[1], this._prevImpact[1]) - pad;
      const maxX = Math.max(impact[0], this._prevImpact[0]) + pad;
      const maxY = Math.max(impact[1], this._prevImpact[1]) + pad;
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    return {
      x: impact[0] - pad,
      y: impact[1] - pad,
      w: pad * 2,
      h: pad * 2,
    };
  }

  /** Store current impact point for next frame's sweep. Call at end of update. */
  updateImpactTracking() {
    if (this.state === "attack" && this.currentAttack) {
      const data = ATTACK_DATA[this.currentAttack];
      // Track during startup AND active frames so the sweep covers
      // the snap from wind-up to full extension on the first active frame
      if (this.attackFrame < data.startup + data.active) {
        this._prevImpact = this._getImpactPoint();
        return;
      }
    }
    this._prevImpact = null;
  }

  /** Returns the current attack's data, or null */
  getAttackData() {
    return this.currentAttack ? ATTACK_DATA[this.currentAttack] : null;
  }

  /** Check if current attack hits opponent. Returns { hitData, zone, multiplier } or null */
  getAttackHit(opponent) {
    const hitbox = this.getAttackHitbox();
    if (!hitbox) return null;

    const hurtboxes = opponent.getHurtboxes();

    // Check each zone — return highest multiplier hit
    let bestHit = null;
    for (const hurtbox of hurtboxes) {
      if (this._rectsOverlap(hitbox, hurtbox)) {
        if (!bestHit || hurtbox.multiplier > bestHit.multiplier) {
          bestHit = {
            hitData: ATTACK_DATA[this.currentAttack],
            zone: hurtbox.zone,
            multiplier: hurtbox.multiplier,
          };
        }
      }
    }
    return bestHit;
  }

  _rectsOverlap(a, b) {
    return (
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
    );
  }

  applyHit(hitData, multiplier, attackerX) {
    const totalDamage = hitData.damage * multiplier;
    this.health = Math.max(0, this.health - totalDamage);
    this.state = "hitstun";
    this.stunFrames = hitData.hitstun;
    // Knockback scales with multiplier
    const dir = this.x > attackerX ? 1 : -1;
    this.vx = dir * (100 + multiplier * 50);
    this.currentAttack = null;
  }

  applyBlock(hitData) {
    this.state = "blockstun";
    this.stunFrames = hitData.blockstun;
    this.vx = 0;
    this.currentAttack = null;
  }

  isBlocking(actions) {
    // Blocking = holding back (away from opponent)
    if (this.facing === 1 && actions.has(Actions.LEFT)) return true;
    if (this.facing === -1 && actions.has(Actions.RIGHT)) return true;
    return false;
  }

  // ─────────────────────────────────────────
  // Rendering — stick figure, anchored at feet
  // ─────────────────────────────────────────

  // All positions built UPWARD from feet (0,0 = ground contact)
  // Skeleton: feet → knees → hips → torso → shoulders → head
  //           shoulders → elbows → hands

  draw(ctx) {
    ctx.save();
    // Translate to foot position (this.y = ground level when grounded)
    ctx.translate(this.x, this.y);

    // Somersault rotation — rotate around the body center
    if (this.isFlipping) {
      const pivotY = -55; // roughly center of body
      ctx.translate(0, pivotY);
      ctx.rotate(this.flipAngle * this.facing);
      ctx.translate(0, -pivotY);
    }

    ctx.strokeStyle = this.color;
    ctx.fillStyle = this.color;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (this.state === "hitstun") {
      ctx.strokeStyle = "#ff4444";
      ctx.fillStyle = "#ff4444";
    } else if (this.state === "blockstun") {
      ctx.strokeStyle = "#4488ff";
      ctx.fillStyle = "#4488ff";
    }

    const f = this.facing;
    const skeleton = this._buildSkeleton();

    // Draw limbs (lines between joints)
    this._drawLimb(ctx, skeleton.footBack, skeleton.kneeBack);
    this._drawLimb(ctx, skeleton.kneeBack, skeleton.hip);
    this._drawLimb(ctx, skeleton.footFront, skeleton.kneeFront);
    this._drawLimb(ctx, skeleton.kneeFront, skeleton.hip);
    this._drawLimb(ctx, skeleton.hip, skeleton.shoulder);
    this._drawLimb(ctx, skeleton.shoulder, skeleton.elbowBack);
    this._drawLimb(ctx, skeleton.elbowBack, skeleton.handBack);
    this._drawLimb(ctx, skeleton.shoulder, skeleton.elbowFront);
    this._drawLimb(ctx, skeleton.elbowFront, skeleton.handFront);

    // Head
    ctx.beginPath();
    ctx.arc(skeleton.head[0], skeleton.head[1], 10, 0, Math.PI * 2);
    ctx.stroke();

    // Fist/foot impact indicator during active attack frames
    if (this.state === "attack" && this.currentAttack) {
      const data = ATTACK_DATA[this.currentAttack];
      if (
        this.attackFrame >= data.startup &&
        this.attackFrame < data.startup + data.active
      ) {
        const isPunch = this.currentAttack.includes("Punch");
        const impactPoint = isPunch ? skeleton.handFront : skeleton.footFront;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(impactPoint[0], impactPoint[1], 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  /** Draw hitboxes and hurtboxes (call from game with world-space ctx) */
  drawHitboxes(ctx) {
    ctx.save();
    ctx.globalAlpha = 0.2;

    const hurtboxes = this.getHurtboxes();
    const zoneColors = {
      head: "#ff0", // yellow — 2x
      crotch: "#f0f", // magenta — 3x
      body: "#0f0", // green — 1x
      arm: "#0aa", // teal — 0.5x
      leg: "#0aa", // teal — 0.5x
    };
    for (const box of hurtboxes) {
      ctx.fillStyle = zoneColors[box.zone] || "#0f0";
      ctx.fillRect(box.x, box.y, box.w, box.h);
    }

    // Attack hitbox
    const hitbox = this.getAttackHitbox();
    if (hitbox) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = "#f00";
      ctx.fillRect(hitbox.x, hitbox.y, hitbox.w, hitbox.h);
    }

    ctx.restore();
  }

  _drawLimb(ctx, from, to) {
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.lineTo(to[0], to[1]);
    ctx.stroke();
  }

  _buildSkeleton() {
    const f = this.facing;

    // Base measurements
    const legLen = 32;
    const thighLen = 30;
    const torsoLen = 40;
    const upperArm = 22;
    const forearm = 20;
    const headRadius = 10;

    switch (this.state) {
      case "idle":
        return this._skeletonIdle(
          f,
          legLen,
          thighLen,
          torsoLen,
          upperArm,
          forearm,
          headRadius,
        );
      case "walk":
        return this._skeletonWalk(
          f,
          legLen,
          thighLen,
          torsoLen,
          upperArm,
          forearm,
          headRadius,
        );
      case "jump":
        return this._skeletonJump(
          f,
          legLen,
          thighLen,
          torsoLen,
          upperArm,
          forearm,
          headRadius,
        );
      case "crouch":
        return this._skeletonCrouch(
          f,
          legLen,
          thighLen,
          torsoLen,
          upperArm,
          forearm,
          headRadius,
        );
      case "attack":
        return this._skeletonAttack(
          f,
          legLen,
          thighLen,
          torsoLen,
          upperArm,
          forearm,
          headRadius,
        );
      case "hitstun":
        return this._skeletonHitstun(
          f,
          legLen,
          thighLen,
          torsoLen,
          upperArm,
          forearm,
          headRadius,
        );
      case "blockstun":
        return this._skeletonBlock(
          f,
          legLen,
          thighLen,
          torsoLen,
          upperArm,
          forearm,
          headRadius,
        );
      default:
        return this._skeletonIdle(
          f,
          legLen,
          thighLen,
          torsoLen,
          upperArm,
          forearm,
          headRadius,
        );
    }
  }

  _skeletonIdle(f, legLen, thighLen, torsoLen, upperArm, forearm, headRadius) {
    // Subtle idle breathing — bob the shoulders slightly
    const breathe = Math.sin(this.animTimer * 3) * 1.5;

    const footBack = [-f * 8, 0];
    const footFront = [f * 8, 0];
    const kneeBack = [-f * 4, -legLen];
    const kneeFront = [f * 4, -legLen];
    const hip = [0, -(legLen + thighLen * 0.3)];
    const shoulder = [0, -(legLen + thighLen + torsoLen) + breathe];
    const head = [
      0,
      -(legLen + thighLen + torsoLen + headRadius + 2) + breathe,
    ];
    // Fighter stance — guard up
    const elbowFront = [f * 15, shoulder[1] + 12];
    const handFront = [f * 10, shoulder[1] - 2];
    const elbowBack = [-f * 8, shoulder[1] + 15];
    const handBack = [-f * 4, shoulder[1] + 5];

    return {
      footBack,
      footFront,
      kneeBack,
      kneeFront,
      hip,
      shoulder,
      head,
      elbowFront,
      handFront,
      elbowBack,
      handBack,
    };
  }

  _skeletonWalk(f, legLen, thighLen, torsoLen, upperArm, forearm, headRadius) {
    const cycle = Math.sin(this.animTimer * 10);
    const stride = cycle * 12;

    const footBack = [-f * 8 - stride * 0.5, 0];
    const footFront = [f * 8 + stride * 0.5, 0];
    const kneeBack = [-f * 4 - stride * 0.3, -legLen + Math.abs(cycle) * 3];
    const kneeFront = [f * 4 + stride * 0.3, -legLen + Math.abs(cycle) * 3];
    const hip = [stride * 0.1, -(legLen + thighLen * 0.3)];
    const shoulder = [stride * 0.05, -(legLen + thighLen + torsoLen)];
    const head = [
      stride * 0.05,
      -(legLen + thighLen + torsoLen + headRadius + 2),
    ];
    // Arms swing opposite to legs
    const armSwing = -cycle * 8;
    const elbowFront = [f * 14 + armSwing, shoulder[1] + 14];
    const handFront = [f * 10 + armSwing * 0.5, shoulder[1] + 2];
    const elbowBack = [-f * 8 - armSwing, shoulder[1] + 14];
    const handBack = [-f * 5 - armSwing * 0.5, shoulder[1] + 2];

    return {
      footBack,
      footFront,
      kneeBack,
      kneeFront,
      hip,
      shoulder,
      head,
      elbowFront,
      handFront,
      elbowBack,
      handBack,
    };
  }

  _skeletonJump(f, legLen, thighLen, torsoLen, upperArm, forearm, headRadius) {
    // Tuck legs when rising, extend when falling
    const airPhase = this.vy < 0 ? "rising" : "falling";
    const tuck = airPhase === "rising" ? 0.6 : 0.2;
    const spread = airPhase === "rising" ? 0.3 : 0.8;

    const totalLeg = legLen + thighLen;
    const legDrop = totalLeg * spread;

    const footBack = [-f * 10, -totalLeg * tuck];
    const footFront = [f * 6, -totalLeg * tuck + 5];
    const kneeBack = [-f * 12, -totalLeg * tuck - legLen * 0.4];
    const kneeFront = [f * 10, -totalLeg * tuck - legLen * 0.3];
    const hip = [0, -(legLen + thighLen * 0.3)];
    const shoulder = [f * 2, -(legLen + thighLen + torsoLen)];
    const head = [f * 3, -(legLen + thighLen + torsoLen + headRadius + 2)];
    // Arms up when rising, down when falling
    const armLift = airPhase === "rising" ? -15 : 8;
    const elbowFront = [f * 18, shoulder[1] + armLift];
    const handFront = [f * 25, shoulder[1] + armLift - 8];
    const elbowBack = [-f * 15, shoulder[1] + armLift + 5];
    const handBack = [-f * 22, shoulder[1] + armLift];

    return {
      footBack,
      footFront,
      kneeBack,
      kneeFront,
      hip,
      shoulder,
      head,
      elbowFront,
      handFront,
      elbowBack,
      handBack,
    };
  }

  _skeletonCrouch(
    f,
    legLen,
    thighLen,
    torsoLen,
    upperArm,
    forearm,
    headRadius,
  ) {
    // Feet stay planted, knees bend out, body drops
    const crouchDepth = 25;

    const footBack = [-f * 12, 0];
    const footFront = [f * 12, 0];
    const kneeBack = [-f * 16, -legLen + crouchDepth];
    const kneeFront = [f * 16, -legLen + crouchDepth];
    const hip = [0, -(legLen + thighLen * 0.3) + crouchDepth];
    const shoulder = [
      f * 2,
      -(legLen + thighLen + torsoLen) + crouchDepth + 10,
    ];
    const head = [
      f * 3,
      -(legLen + thighLen + torsoLen + headRadius + 2) + crouchDepth + 10,
    ];
    // Guard up while crouching
    const elbowFront = [f * 14, shoulder[1] + 8];
    const handFront = [f * 12, shoulder[1] - 4];
    const elbowBack = [-f * 6, shoulder[1] + 10];
    const handBack = [-f * 4, shoulder[1] + 2];

    return {
      footBack,
      footFront,
      kneeBack,
      kneeFront,
      hip,
      shoulder,
      head,
      elbowFront,
      handFront,
      elbowBack,
      handBack,
    };
  }

  _skeletonAttack(
    f,
    legLen,
    thighLen,
    torsoLen,
    upperArm,
    forearm,
    headRadius,
  ) {
    if (!this.currentAttack)
      return this._skeletonIdle(
        f,
        legLen,
        thighLen,
        torsoLen,
        upperArm,
        forearm,
        headRadius,
      );

    const data = ATTACK_DATA[this.currentAttack];
    const isPunch = this.currentAttack.includes("Punch");
    const strength = data.damage;

    // Phase: 0=startup, 1=active, 2=recovery
    let phase, phaseT;
    if (this.attackFrame < data.startup) {
      phase = 0;
      phaseT = this.attackFrame / data.startup;
    } else if (this.attackFrame < data.startup + data.active) {
      phase = 1;
      phaseT = (this.attackFrame - data.startup) / data.active;
    } else {
      phase = 2;
      phaseT = (this.attackFrame - data.startup - data.active) / data.recovery;
    }

    // Build base stance from attack context
    let footBack, footFront, kneeBack, kneeFront, hip, shoulder, head;
    const crouchDepth = 25;

    if (this.attackContext === "crouch") {
      footBack = [-f * 12, 0];
      footFront = [f * 12, 0];
      kneeBack = [-f * 16, -legLen + crouchDepth];
      kneeFront = [f * 14, -legLen + crouchDepth];
      hip = [0, -(legLen + thighLen * 0.3) + crouchDepth];
      shoulder = [0, -(legLen + thighLen + torsoLen) + crouchDepth + 10];
      head = [0, -(legLen + thighLen + torsoLen + 10 + 2) + crouchDepth + 10];
    } else if (this.attackContext === "air") {
      const tuck = 0.5;
      const totalLeg = legLen + thighLen;
      footBack = [-f * 8, -totalLeg * tuck];
      footFront = [f * 6, -totalLeg * tuck + 5];
      kneeBack = [-f * 10, -totalLeg * tuck - legLen * 0.4];
      kneeFront = [f * 8, -totalLeg * tuck - legLen * 0.3];
      hip = [0, -(legLen + thighLen * 0.3)];
      shoulder = [0, -(legLen + thighLen + torsoLen)];
      head = [0, -(legLen + thighLen + torsoLen + 10 + 2)];
    } else {
      footBack = [-f * 10, 0];
      footFront = [f * 10, 0];
      kneeBack = [-f * 6, -legLen];
      kneeFront = [f * 8, -legLen];
      hip = [0, -(legLen + thighLen * 0.3)];
      shoulder = [0, -(legLen + thighLen + torsoLen)];
      head = [0, -(legLen + thighLen + torsoLen + 10 + 2)];
    }

    if (isPunch) {
      const leanForward =
        phase === 0 ? -3 * phaseT : phase === 1 ? f * 8 : f * 8 * (1 - phaseT);
      shoulder[0] += leanForward;
      head[0] += leanForward;

      const reach =
        (upperArm + forearm) * (strength > 7 ? 1.6 : strength > 4 ? 1.3 : 1.0);

      // Punch targets upper-torso (1/3 down from shoulder toward hip)
      const punchY = shoulder[1] + (hip[1] - shoulder[1]) * 0.3;

      let elbowFront, handFront;
      if (phase === 0) {
        elbowFront = [-f * 5, shoulder[1] + 5];
        handFront = [-f * 10 * phaseT, punchY + 5 * (1 - phaseT)];
      } else if (phase === 1) {
        elbowFront = [f * reach * 0.5, punchY - 3];
        handFront = [f * reach, punchY];
      } else {
        const retract = 1 - phaseT;
        elbowFront = [f * reach * 0.5 * retract, punchY + 5 * phaseT];
        handFront = [f * reach * retract, punchY + 10 * phaseT];
      }

      const elbowBack = [-f * 10, shoulder[1] + 12];
      const handBack = [-f * 8, shoulder[1] + 5];

      return {
        footBack,
        footFront,
        kneeBack,
        kneeFront,
        hip,
        shoulder,
        head,
        elbowFront,
        handFront,
        elbowBack,
        handBack,
      };
    } else {
      const reach =
        (legLen + thighLen) * (strength > 7 ? 1.4 : strength > 4 ? 1.2 : 1.0);
      // Kick heights: standing targets mid-body, crouch goes low, air angles down
      let kickHeight;
      if (this.attackContext === "crouch") {
        // Crouch kicks sweep low — can hit legs, might catch crotch
        kickHeight = data.type === "low" ? 20 : data.type === "mid" ? 10 : -5;
      } else if (this.attackContext === "air") {
        // Air kicks angle downward
        kickHeight = data.type === "low" ? 15 : data.type === "mid" ? 5 : -15;
      } else {
        // Standing kicks — all above the hip to avoid crotch zone
        kickHeight =
          data.type === "low" ? -10 : data.type === "mid" ? -22 : -35;
      }

      // Chamber starts at the kick's target height so the sweep
      // never passes through the crotch zone
      const chamberY = hip[1] + kickHeight;

      let kickFoot, kickKnee;
      if (phase === 0) {
        // Chamber — pull knee up to target height
        kickKnee = [f * 8, hip[1] - 10 * phaseT];
        kickFoot = [f * 5, chamberY + 5 * (1 - phaseT)];
      } else if (phase === 1) {
        // Snap out at target height
        kickKnee = [f * reach * 0.4, hip[1] + kickHeight * 0.5];
        kickFoot = [f * reach, hip[1] + kickHeight];
      } else {
        // Retract back to chamber position
        const retract = 1 - phaseT;
        kickKnee = [
          f * reach * 0.4 * retract + f * 5 * (1 - retract),
          hip[1] + kickHeight * 0.5 * retract,
        ];
        kickFoot = [
          f * reach * retract + f * 8 * (1 - retract),
          chamberY + 5 * (1 - retract),
        ];
      }

      const leanBack =
        phase === 1
          ? -f * 6
          : phase === 0
            ? -f * 3 * phaseT
            : -f * 6 * (1 - phaseT);
      shoulder[0] += leanBack;
      head[0] += leanBack;

      const elbowFront = [f * 12 + leanBack, shoulder[1] + 10];
      const handFront = [f * 8 + leanBack, shoulder[1] - 2];
      const elbowBack = [-f * 8 + leanBack, shoulder[1] + 12];
      const handBack = [-f * 6 + leanBack, shoulder[1] + 4];

      return {
        footBack,
        footFront: kickFoot,
        kneeBack,
        kneeFront: kickKnee,
        hip,
        shoulder,
        head,
        elbowFront,
        handFront,
        elbowBack,
        handBack,
      };
    }
  }

  _skeletonHitstun(
    f,
    legLen,
    thighLen,
    torsoLen,
    upperArm,
    forearm,
    headRadius,
  ) {
    // Reel back
    const shake = Math.sin(this.stunFrames * 2) * 3;

    const footBack = [-f * 12, 0];
    const footFront = [f * 5, 0];
    const kneeBack = [-f * 8, -legLen + 5];
    const kneeFront = [f * 2, -legLen + 3];
    const hip = [-f * 5 + shake, -(legLen + thighLen * 0.3)];
    const shoulder = [-f * 10 + shake, -(legLen + thighLen + torsoLen) + 5];
    const head = [
      -f * 12 + shake,
      -(legLen + thighLen + torsoLen + headRadius + 2) + 5,
    ];
    const elbowFront = [f * 2 + shake, shoulder[1] + 15];
    const handFront = [f * 8 + shake, shoulder[1] + 20];
    const elbowBack = [-f * 15 + shake, shoulder[1] + 10];
    const handBack = [-f * 12 + shake, shoulder[1] + 18];

    return {
      footBack,
      footFront,
      kneeBack,
      kneeFront,
      hip,
      shoulder,
      head,
      elbowFront,
      handFront,
      elbowBack,
      handBack,
    };
  }

  _skeletonBlock(f, legLen, thighLen, torsoLen, upperArm, forearm, headRadius) {
    const push = Math.sin(this.stunFrames * 3) * 2;

    const footBack = [-f * 12, 0];
    const footFront = [f * 6, 0];
    const kneeBack = [-f * 10, -legLen + 3];
    const kneeFront = [f * 4, -legLen + 2];
    const hip = [-f * 3 + push, -(legLen + thighLen * 0.3)];
    const shoulder = [-f * 2 + push, -(legLen + thighLen + torsoLen)];
    const head = [
      -f * 2 + push,
      -(legLen + thighLen + torsoLen + headRadius + 2),
    ];
    // Arms crossed in front for guard
    const elbowFront = [f * 8, shoulder[1] + 3];
    const handFront = [f * 4, shoulder[1] - 12];
    const elbowBack = [f * 3, shoulder[1] + 8];
    const handBack = [f * 6, shoulder[1] - 5];

    return {
      footBack,
      footFront,
      kneeBack,
      kneeFront,
      hip,
      shoulder,
      head,
      elbowFront,
      handFront,
      elbowBack,
      handBack,
    };
  }
}
