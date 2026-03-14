"""Fighter class — server-side port of src/fighter.js physics, state machine, and hitboxes."""

from __future__ import annotations

import math
from dataclasses import dataclass

from game_engine.actions import Actions, AttackData, ATTACK_DATA, ATTACK_ACTIONS, HADOUKEN_DATA, HADOUKEN_COOLDOWN

# ─────────────────────────────────────────────
# Constants (match src/fighter.js exactly)
# ─────────────────────────────────────────────
GRAVITY = 1800.0
JUMP_VELOCITY = -620.0
WALK_SPEED = 200.0
DASH_SPEED = 600.0
DASH_DURATION = 0.15


# ─────────────────────────────────────────────
# Data types
# ─────────────────────────────────────────────
@dataclass
class Rect:
    x: float
    y: float
    w: float
    h: float


@dataclass
class Hurtbox:
    zone: str
    x: float
    y: float
    w: float
    h: float
    multiplier: float


@dataclass
class HitResult:
    hit_data: AttackData
    zone: str
    multiplier: float


# Joint = [x, y] in local space; Skeleton = dict of named joints
Skeleton = dict[str, list[float]]


def _rects_overlap(a: Rect, b: Rect) -> bool:
    return a.x < b.x + b.w and a.x + a.w > b.x and a.y < b.y + b.h and a.y + a.h > b.y


# ─────────────────────────────────────────────
# Fighter
# ─────────────────────────────────────────────
class Fighter:
    def __init__(self, x: float, floor_y: float, facing: int, color: str = "") -> None:
        # Position / physics
        self.x = x
        self.y = floor_y
        self.floor_y = floor_y
        self.vx = 0.0
        self.vy = 0.0
        self.facing = facing  # 1 = right, -1 = left

        # Dimensions
        self.width = 40.0
        self.height = 120.0

        # State
        self.state = "idle"
        self.health = 100.0
        self.color = color

        # Attack state
        self.current_attack: str | None = None
        self.attack_frame = 0.0
        self.attack_context = "stand"  # "stand" | "crouch" | "air"
        self.attack_has_hit = False
        self.stun_frames = 0.0

        # Previous frame impact point for sweep detection
        self._prev_impact: list[float] | None = None

        # Animation helpers
        self.anim_timer = 0.0

        # Double jump
        self.jump_count = 0
        self.max_jumps = 2
        self.flip_angle = 0.0
        self.is_flipping = False
        self.flip_count = 0
        self.max_flips = 2

        # Dash
        self.dash_timer = 0.0
        self.dash_dir = 0

        # Hadouken cooldown
        self.hadouken_cooldown = 0.0

        # Per-frame events (consumed by game each frame)
        self.events: set[str] = set()

    @property
    def grounded(self) -> bool:
        return self.y >= self.floor_y

    @property
    def center_x(self) -> float:
        return self.x

    @property
    def hurtbox_left(self) -> float:
        return self.x - self.width / 2

    @property
    def hurtbox_right(self) -> float:
        return self.x + self.width / 2

    # ─────────────────────────────────────────
    # Update
    # ─────────────────────────────────────────
    def update(
        self,
        dt: float,
        actions: set[str],
        just_pressed: set[str],
        opponent: Fighter | None,
        stage_left: float,
        stage_right: float,
    ) -> None:
        self.events.clear()
        frames = dt * 60  # convert to ~60fps frame units
        self.anim_timer += dt

        # Tick hadouken cooldown
        if self.hadouken_cooldown > 0:
            self.hadouken_cooldown -= dt

        # Progress somersault
        if self.is_flipping and not self.grounded:
            self.flip_angle += dt * math.pi * 4
            if self.flip_angle >= math.pi * 2:
                self.flip_angle = 0.0
                self.is_flipping = False

        # --- Stun states ---
        if self.state in ("hitstun", "blockstun"):
            self.stun_frames -= frames
            if self.stun_frames <= 0:
                self.stun_frames = 0.0
                self.state = "idle"
            self._apply_physics(dt, stage_left, stage_right, opponent)
            return

        # --- Attack state (still allows movement) ---
        if self.state == "attack":
            prev_attack_frame = self.attack_frame
            self.attack_frame += frames
            if self.current_attack is not None:
                data = HADOUKEN_DATA if self.current_attack == Actions.HADOUKEN else ATTACK_DATA[self.current_attack]

                # Hadouken: emit fire event when entering active frames
                if (
                    self.current_attack == Actions.HADOUKEN
                    and prev_attack_frame < data.startup
                    and self.attack_frame >= data.startup
                ):
                    self.events.add("hadouken:fire")
                    self.hadouken_cooldown = HADOUKEN_COOLDOWN

                total_frames = data.startup + data.active + data.recovery
                if self.attack_frame >= total_frames:
                    if not self.grounded:
                        self.state = "jump"
                    elif Actions.DOWN in actions:
                        self.state = "crouch"
                    else:
                        self.state = "idle"
                    self.current_attack = None
            # Movement during attack
            self.vx = 0.0
            if Actions.LEFT in actions:
                self.vx = -WALK_SPEED
            if Actions.RIGHT in actions:
                self.vx = WALK_SPEED
            self._apply_physics(dt, stage_left, stage_right, opponent)
            return

        # --- Dash (from compound actions) ---
        if Actions.DASH_LEFT in just_pressed and self.dash_timer <= 0:
            self.dash_timer = DASH_DURATION
            self.dash_dir = -1
            self.events.add("dash")
        if Actions.DASH_RIGHT in just_pressed and self.dash_timer <= 0:
            self.dash_timer = DASH_DURATION
            self.dash_dir = 1
            self.events.add("dash")
        if Actions.DASH_FORWARD in just_pressed and self.dash_timer <= 0:
            self.dash_timer = DASH_DURATION
            self.dash_dir = self.facing
            self.events.add("dash")
        if Actions.DASH_BACK in just_pressed and self.dash_timer <= 0:
            self.dash_timer = DASH_DURATION
            self.dash_dir = -self.facing
            self.events.add("dash")

        # --- Movement ---
        self.vx = 0.0

        if self.dash_timer > 0:
            self.dash_timer -= dt
            self.vx = self.dash_dir * DASH_SPEED
        else:
            if Actions.LEFT in actions:
                self.vx = -WALK_SPEED
            if Actions.RIGHT in actions:
                self.vx = WALK_SPEED

        if Actions.DOWN in actions and self.grounded:
            self.state = "crouch"
            self.vx = 0.0
            self.dash_timer = 0.0
        elif not self.grounded:
            self.state = "jump"
        elif self.vx != 0:
            self.state = "walk"
        else:
            self.state = "idle"

        # Reset jump count on landing
        if self.grounded:
            self.jump_count = 0
            self.flip_count = 0
            self.is_flipping = False
            self.flip_angle = 0.0

        # Jump (from compound action)
        if Actions.JUMP in just_pressed and self.jump_count < self.max_jumps:
            self.vy = JUMP_VELOCITY
            if self.grounded:
                self.y -= 1
            self.jump_count += 1
            self.state = "jump"

        # Somersault (from compound action)
        if (
            Actions.SOMERSAULT in just_pressed
            and not self.grounded
            and self.flip_count < self.max_flips
        ):
            self.vy = JUMP_VELOCITY * 0.85
            self.jump_count = self.max_jumps
            self.flip_count += 1
            self.is_flipping = True
            self.flip_angle = 0.0
            self.events.add("somersault")

        # Hadouken input (check before normal attacks — takes priority)
        if (
            Actions.HADOUKEN in just_pressed
            and self.state != "attack"
            and self.hadouken_cooldown <= 0
            and self.grounded
        ):
            self.attack_context = "stand"
            self.state = "attack"
            self.current_attack = Actions.HADOUKEN
            self.attack_frame = 0.0
            self.attack_has_hit = False
            self.dash_timer = 0.0
            self.events.add("hadouken:windup")

        # Attack input (edge-triggered)
        for action in just_pressed:
            if action in ATTACK_ACTIONS and self.state != "attack":
                if not self.grounded:
                    self.attack_context = "air"
                elif self.state == "crouch":
                    self.attack_context = "crouch"
                else:
                    self.attack_context = "stand"

                self.state = "attack"
                self.current_attack = action
                self.attack_frame = 0.0
                self.attack_has_hit = False
                atk_data = ATTACK_DATA[action]
                is_punch = "Punch" in action
                self.events.add(
                    f"punch:{atk_data.damage}" if is_punch else f"kick:{atk_data.damage}"
                )
                break

        self._apply_physics(dt, stage_left, stage_right, opponent)

    # ─────────────────────────────────────────
    # Physics
    # ─────────────────────────────────────────
    def _apply_physics(
        self,
        dt: float,
        stage_left: float,
        stage_right: float,
        opponent: Fighter | None,
    ) -> None:
        # Gravity
        if not self.grounded or self.vy < 0:
            self.vy += GRAVITY * dt

        self.x += self.vx * dt
        self.y += self.vy * dt

        # Floor clamp
        if self.y >= self.floor_y:
            self.y = self.floor_y
            self.vy = 0.0

        # Stage bounds
        if self.x - self.width / 2 < stage_left:
            self.x = stage_left + self.width / 2
        if self.x + self.width / 2 > stage_right:
            self.x = stage_right - self.width / 2

        # Push apart (no overlapping)
        if opponent is not None:
            overlap = self._get_overlap(opponent)
            if overlap > 0:
                push = overlap / 2
                if self.x < opponent.x:
                    self.x -= push
                    opponent.x += push
                else:
                    self.x += push
                    opponent.x -= push

    def _get_overlap(self, other: Fighter) -> float:
        my_left = self.hurtbox_left
        my_right = self.hurtbox_right
        other_left = other.hurtbox_left
        other_right = other.hurtbox_right
        return max(0.0, min(my_right, other_right) - max(my_left, other_left))

    # ─────────────────────────────────────────
    # Hitbox / Hurtbox system
    # ─────────────────────────────────────────
    def _local_to_world(self, lx: float, ly: float) -> list[float]:
        """Rotate a local skeleton point through flip angle, return world coords."""
        if self.is_flipping:
            pivot_y = -55.0
            rx = lx
            ry = ly - pivot_y
            angle = self.flip_angle * self.facing
            cos = math.cos(angle)
            sin = math.sin(angle)
            rot_x = rx * cos - ry * sin
            rot_y = rx * sin + ry * cos
            return [self.x + rot_x, self.y + rot_y + pivot_y]
        return [self.x + lx, self.y + ly]

    def _limb_box(
        self,
        zone: str,
        world_a: list[float],
        world_b: list[float],
        thickness: float,
        multiplier: float,
    ) -> Hurtbox:
        """Build a hurtbox for a limb segment from world-space endpoints."""
        cx = (world_a[0] + world_b[0]) / 2
        cy = (world_a[1] + world_b[1]) / 2
        span_x = abs(world_a[0] - world_b[0])
        span_y = abs(world_a[1] - world_b[1])
        w = max(span_x + 4, thickness)
        h = max(span_y + 4, thickness)
        return Hurtbox(zone=zone, x=cx - w / 2, y=cy - h / 2, w=w, h=h, multiplier=multiplier)

    def get_hurtboxes(self) -> list[Hurtbox]:
        """Returns hurtboxes for every limb, in world coords."""
        s = self._build_skeleton()

        head = self._local_to_world(s["head"][0], s["head"][1])
        shoulder = self._local_to_world(s["shoulder"][0], s["shoulder"][1])
        hip = self._local_to_world(s["hip"][0], s["hip"][1])
        knee_back = self._local_to_world(s["knee_back"][0], s["knee_back"][1])
        knee_front = self._local_to_world(s["knee_front"][0], s["knee_front"][1])
        foot_back = self._local_to_world(s["foot_back"][0], s["foot_back"][1])
        foot_front = self._local_to_world(s["foot_front"][0], s["foot_front"][1])
        elbow_back = self._local_to_world(s["elbow_back"][0], s["elbow_back"][1])
        elbow_front = self._local_to_world(s["elbow_front"][0], s["elbow_front"][1])
        hand_back = self._local_to_world(s["hand_back"][0], s["hand_back"][1])
        hand_front = self._local_to_world(s["hand_front"][0], s["hand_front"][1])

        limb_pad = 4.0
        torso_pad = 6.0

        return [
            # Head — 2x
            Hurtbox(zone="head", x=head[0] - 7, y=head[1] - 7, w=14, h=14, multiplier=2.0),
            # Crotch — 3x
            Hurtbox(zone="crotch", x=hip[0] - 2, y=hip[1] - 2, w=4, h=4, multiplier=3.0),
            # Torso — 1x
            self._limb_box("body", shoulder, hip, torso_pad, 1.0),
            # Arms — 0.5x
            self._limb_box("arm", shoulder, elbow_back, limb_pad, 0.5),
            self._limb_box("arm", elbow_back, hand_back, limb_pad, 0.5),
            self._limb_box("arm", shoulder, elbow_front, limb_pad, 0.5),
            self._limb_box("arm", elbow_front, hand_front, limb_pad, 0.5),
            # Legs — 0.5x
            self._limb_box("leg", hip, knee_back, limb_pad, 0.5),
            self._limb_box("leg", knee_back, foot_back, limb_pad, 0.5),
            self._limb_box("leg", hip, knee_front, limb_pad, 0.5),
            self._limb_box("leg", knee_front, foot_front, limb_pad, 0.5),
        ]

    def _get_impact_point(self) -> list[float] | None:
        """Returns the current attack impact point in world coords, or None."""
        if self.state != "attack" or self.current_attack is None:
            return None
        skeleton = self._build_skeleton()
        is_punch = "Punch" in self.current_attack
        joint = skeleton["hand_front"] if is_punch else skeleton["foot_front"]
        return self._local_to_world(joint[0], joint[1])

    def get_attack_hitbox(self) -> Rect | None:
        """Returns the attack hitbox rect in world coords, or None if not in active frames."""
        if self.state != "attack" or self.current_attack is None or self.attack_has_hit:
            return None
        # Hadouken has no melee hitbox — projectile handles damage
        if self.current_attack == Actions.HADOUKEN:
            return None
        data = ATTACK_DATA[self.current_attack]
        if self.attack_frame < data.startup or self.attack_frame >= data.startup + data.active:
            return None

        impact = self._get_impact_point()
        if impact is None:
            return None
        pad = 4.0

        # If we have a previous impact point, build a swept box
        if self._prev_impact is not None:
            min_x = min(impact[0], self._prev_impact[0]) - pad
            min_y = min(impact[1], self._prev_impact[1]) - pad
            max_x = max(impact[0], self._prev_impact[0]) + pad
            max_y = max(impact[1], self._prev_impact[1]) + pad
            return Rect(x=min_x, y=min_y, w=max_x - min_x, h=max_y - min_y)

        return Rect(x=impact[0] - pad, y=impact[1] - pad, w=pad * 2, h=pad * 2)

    def update_impact_tracking(self) -> None:
        """Store current impact point for next frame's sweep."""
        if self.state == "attack" and self.current_attack is not None:
            data = HADOUKEN_DATA if self.current_attack == Actions.HADOUKEN else ATTACK_DATA[self.current_attack]
            if self.attack_frame < data.startup + data.active:
                self._prev_impact = self._get_impact_point()
                return
        self._prev_impact = None

    def get_attack_data(self) -> AttackData | None:
        """Returns the current attack's data, or None."""
        if self.current_attack == Actions.HADOUKEN:
            return HADOUKEN_DATA
        if self.current_attack is not None:
            return ATTACK_DATA.get(self.current_attack)
        return None

    def get_attack_hit(self, opponent: Fighter) -> HitResult | None:
        """Check if current attack hits opponent. Returns best zone hit or None."""
        hitbox = self.get_attack_hitbox()
        if hitbox is None:
            return None

        hurtboxes = opponent.get_hurtboxes()

        best_hit: HitResult | None = None
        for hurtbox in hurtboxes:
            hb_rect = Rect(x=hurtbox.x, y=hurtbox.y, w=hurtbox.w, h=hurtbox.h)
            if _rects_overlap(hitbox, hb_rect):
                if best_hit is None or hurtbox.multiplier > best_hit.multiplier:
                    best_hit = HitResult(
                        hit_data=ATTACK_DATA[self.current_attack],  # type: ignore[index]
                        zone=hurtbox.zone,
                        multiplier=hurtbox.multiplier,
                    )
        return best_hit

    def apply_hit(self, hit_data: AttackData, multiplier: float, attacker_x: float) -> None:
        total_damage = hit_data.damage * multiplier
        self.health = max(0.0, self.health - total_damage)
        self.state = "hitstun"
        self.stun_frames = float(hit_data.hitstun)
        direction = 1 if self.x > attacker_x else -1
        self.vx = direction * (100 + multiplier * 50)
        self.current_attack = None

    def apply_block(self, hit_data: AttackData) -> None:
        self.state = "blockstun"
        self.stun_frames = float(hit_data.blockstun)
        self.vx = 0.0
        self.current_attack = None

    def is_blocking(self, actions: set[str]) -> bool:
        """Blocking = holding back (away from opponent)."""
        if self.facing == 1 and Actions.LEFT in actions:
            return True
        if self.facing == -1 and Actions.RIGHT in actions:
            return True
        return False

    # ─────────────────────────────────────────
    # Skeleton building (matches src/fighter.js)
    # ─────────────────────────────────────────
    def _build_skeleton(self) -> Skeleton:
        f = self.facing
        leg_len = 32.0
        thigh_len = 30.0
        torso_len = 40.0
        upper_arm = 22.0
        forearm = 20.0
        head_radius = 10.0

        builders = {
            "idle": self._skeleton_idle,
            "walk": self._skeleton_walk,
            "jump": self._skeleton_jump,
            "crouch": self._skeleton_crouch,
            "attack": self._skeleton_attack,
            "hitstun": self._skeleton_hitstun,
            "blockstun": self._skeleton_block,
        }
        builder = builders.get(self.state, self._skeleton_idle)
        return builder(f, leg_len, thigh_len, torso_len, upper_arm, forearm, head_radius)

    def _skeleton_idle(
        self, f: int, leg_len: float, thigh_len: float, torso_len: float,
        upper_arm: float, forearm: float, head_radius: float,
    ) -> Skeleton:
        breathe = math.sin(self.anim_timer * 3) * 1.5

        shoulder_y = -(leg_len + thigh_len + torso_len) + breathe
        head_y = -(leg_len + thigh_len + torso_len + head_radius + 2) + breathe

        return {
            "foot_back": [-f * 8, 0.0],
            "foot_front": [f * 8, 0.0],
            "knee_back": [-f * 4, -leg_len],
            "knee_front": [f * 4, -leg_len],
            "hip": [0.0, -(leg_len + thigh_len * 0.3)],
            "shoulder": [0.0, shoulder_y],
            "head": [0.0, head_y],
            "elbow_front": [f * 15, shoulder_y + 12],
            "hand_front": [f * 10, shoulder_y - 2],
            "elbow_back": [-f * 8, shoulder_y + 15],
            "hand_back": [-f * 4, shoulder_y + 5],
        }

    def _skeleton_walk(
        self, f: int, leg_len: float, thigh_len: float, torso_len: float,
        upper_arm: float, forearm: float, head_radius: float,
    ) -> Skeleton:
        cycle = math.sin(self.anim_timer * 10)
        stride = cycle * 12

        shoulder_y = -(leg_len + thigh_len + torso_len)
        arm_swing = -cycle * 8

        return {
            "foot_back": [-f * 8 - stride * 0.5, 0.0],
            "foot_front": [f * 8 + stride * 0.5, 0.0],
            "knee_back": [-f * 4 - stride * 0.3, -leg_len + abs(cycle) * 3],
            "knee_front": [f * 4 + stride * 0.3, -leg_len + abs(cycle) * 3],
            "hip": [stride * 0.1, -(leg_len + thigh_len * 0.3)],
            "shoulder": [stride * 0.05, shoulder_y],
            "head": [stride * 0.05, -(leg_len + thigh_len + torso_len + head_radius + 2)],
            "elbow_front": [f * 14 + arm_swing, shoulder_y + 14],
            "hand_front": [f * 10 + arm_swing * 0.5, shoulder_y + 2],
            "elbow_back": [-f * 8 - arm_swing, shoulder_y + 14],
            "hand_back": [-f * 5 - arm_swing * 0.5, shoulder_y + 2],
        }

    def _skeleton_jump(
        self, f: int, leg_len: float, thigh_len: float, torso_len: float,
        upper_arm: float, forearm: float, head_radius: float,
    ) -> Skeleton:
        air_phase = "rising" if self.vy < 0 else "falling"
        tuck = 0.6 if air_phase == "rising" else 0.2
        total_leg = leg_len + thigh_len

        shoulder_y = -(leg_len + thigh_len + torso_len)
        arm_lift = -15.0 if air_phase == "rising" else 8.0

        return {
            "foot_back": [-f * 10, -total_leg * tuck],
            "foot_front": [f * 6, -total_leg * tuck + 5],
            "knee_back": [-f * 12, -total_leg * tuck - leg_len * 0.4],
            "knee_front": [f * 10, -total_leg * tuck - leg_len * 0.3],
            "hip": [0.0, -(leg_len + thigh_len * 0.3)],
            "shoulder": [f * 2, shoulder_y],
            "head": [f * 3, -(leg_len + thigh_len + torso_len + head_radius + 2)],
            "elbow_front": [f * 18, shoulder_y + arm_lift],
            "hand_front": [f * 25, shoulder_y + arm_lift - 8],
            "elbow_back": [-f * 15, shoulder_y + arm_lift + 5],
            "hand_back": [-f * 22, shoulder_y + arm_lift],
        }

    def _skeleton_crouch(
        self, f: int, leg_len: float, thigh_len: float, torso_len: float,
        upper_arm: float, forearm: float, head_radius: float,
    ) -> Skeleton:
        crouch_depth = 25.0

        shoulder_y = -(leg_len + thigh_len + torso_len) + crouch_depth + 10

        return {
            "foot_back": [-f * 12, 0.0],
            "foot_front": [f * 12, 0.0],
            "knee_back": [-f * 16, -leg_len + crouch_depth],
            "knee_front": [f * 16, -leg_len + crouch_depth],
            "hip": [0.0, -(leg_len + thigh_len * 0.3) + crouch_depth],
            "shoulder": [f * 2, shoulder_y],
            "head": [f * 3, -(leg_len + thigh_len + torso_len + head_radius + 2) + crouch_depth + 10],
            "elbow_front": [f * 14, shoulder_y + 8],
            "hand_front": [f * 12, shoulder_y - 4],
            "elbow_back": [-f * 6, shoulder_y + 10],
            "hand_back": [-f * 4, shoulder_y + 2],
        }

    def _skeleton_attack(
        self, f: int, leg_len: float, thigh_len: float, torso_len: float,
        upper_arm: float, forearm: float, head_radius: float,
    ) -> Skeleton:
        if self.current_attack is None:
            return self._skeleton_idle(f, leg_len, thigh_len, torso_len, upper_arm, forearm, head_radius)

        data = HADOUKEN_DATA if self.current_attack == Actions.HADOUKEN else ATTACK_DATA[self.current_attack]
        is_punch = "Punch" in self.current_attack
        strength = data.damage

        # Phase: 0=startup, 1=active, 2=recovery
        if self.attack_frame < data.startup:
            phase = 0
            phase_t = self.attack_frame / data.startup if data.startup > 0 else 0.0
        elif self.attack_frame < data.startup + data.active:
            phase = 1
            phase_t = (self.attack_frame - data.startup) / data.active if data.active > 0 else 0.0
        else:
            phase = 2
            phase_t = (self.attack_frame - data.startup - data.active) / data.recovery if data.recovery > 0 else 0.0

        # Hadouken has its own skeleton
        if self.current_attack == Actions.HADOUKEN:
            return self._skeleton_hadouken(f, leg_len, thigh_len, torso_len, upper_arm, forearm, head_radius, phase, phase_t)

        # Build base stance from attack context
        crouch_depth = 25.0

        if self.attack_context == "crouch":
            foot_back = [-f * 12, 0.0]
            foot_front = [f * 12, 0.0]
            knee_back = [-f * 16, -leg_len + crouch_depth]
            knee_front = [f * 14, -leg_len + crouch_depth]
            hip: list[float] = [0.0, -(leg_len + thigh_len * 0.3) + crouch_depth]
            shoulder: list[float] = [0.0, -(leg_len + thigh_len + torso_len) + crouch_depth + 10]
            head: list[float] = [0.0, -(leg_len + thigh_len + torso_len + 10 + 2) + crouch_depth + 10]
        elif self.attack_context == "air":
            tuck = 0.5
            total_leg = leg_len + thigh_len
            foot_back = [-f * 8, -total_leg * tuck]
            foot_front = [f * 6, -total_leg * tuck + 5]
            knee_back = [-f * 10, -total_leg * tuck - leg_len * 0.4]
            knee_front = [f * 8, -total_leg * tuck - leg_len * 0.3]
            hip = [0.0, -(leg_len + thigh_len * 0.3)]
            shoulder = [0.0, -(leg_len + thigh_len + torso_len)]
            head = [0.0, -(leg_len + thigh_len + torso_len + 10 + 2)]
        else:
            foot_back = [-f * 10, 0.0]
            foot_front = [f * 10, 0.0]
            knee_back = [-f * 6, -leg_len]
            knee_front = [f * 8, -leg_len]
            hip = [0.0, -(leg_len + thigh_len * 0.3)]
            shoulder = [0.0, -(leg_len + thigh_len + torso_len)]
            head = [0.0, -(leg_len + thigh_len + torso_len + 10 + 2)]

        if is_punch:
            if phase == 0:
                lean_forward = -3 * phase_t
            elif phase == 1:
                lean_forward = f * 8
            else:
                lean_forward = f * 8 * (1 - phase_t)
            shoulder[0] += lean_forward
            head[0] += lean_forward

            reach = (upper_arm + forearm) * (1.6 if strength > 7 else 1.3 if strength > 4 else 1.0)
            punch_y = shoulder[1] + (hip[1] - shoulder[1]) * 0.3

            if phase == 0:
                elbow_front = [-f * 5, shoulder[1] + 5]
                hand_front = [-f * 10 * phase_t, punch_y + 5 * (1 - phase_t)]
            elif phase == 1:
                elbow_front = [f * reach * 0.5, punch_y - 3]
                hand_front = [f * reach, punch_y]
            else:
                retract = 1 - phase_t
                elbow_front = [f * reach * 0.5 * retract, punch_y + 5 * phase_t]
                hand_front = [f * reach * retract, punch_y + 10 * phase_t]

            elbow_back = [-f * 10, shoulder[1] + 12]
            hand_back = [-f * 8, shoulder[1] + 5]

            return {
                "foot_back": foot_back, "foot_front": foot_front,
                "knee_back": knee_back, "knee_front": knee_front,
                "hip": hip, "shoulder": shoulder, "head": head,
                "elbow_front": elbow_front, "hand_front": hand_front,
                "elbow_back": elbow_back, "hand_back": hand_back,
            }
        else:
            # Kick
            reach = (leg_len + thigh_len) * (1.4 if strength > 7 else 1.2 if strength > 4 else 1.0)

            if self.attack_context == "crouch":
                kick_height = 20.0 if data.type == "low" else 10.0 if data.type == "mid" else -5.0
            elif self.attack_context == "air":
                kick_height = 15.0 if data.type == "low" else 5.0 if data.type == "mid" else -15.0
            else:
                kick_height = -10.0 if data.type == "low" else -22.0 if data.type == "mid" else -35.0

            chamber_y = hip[1] + kick_height

            if phase == 0:
                kick_knee = [f * 8, hip[1] - 10 * phase_t]
                kick_foot = [f * 5, chamber_y + 5 * (1 - phase_t)]
            elif phase == 1:
                kick_knee = [f * reach * 0.4, hip[1] + kick_height * 0.5]
                kick_foot = [f * reach, hip[1] + kick_height]
            else:
                retract = 1 - phase_t
                kick_knee = [
                    f * reach * 0.4 * retract + f * 5 * (1 - retract),
                    hip[1] + kick_height * 0.5 * retract,
                ]
                kick_foot = [
                    f * reach * retract + f * 8 * (1 - retract),
                    chamber_y + 5 * (1 - retract),
                ]

            if phase == 1:
                lean_back = float(-f * 6)
            elif phase == 0:
                lean_back = -f * 3 * phase_t
            else:
                lean_back = -f * 6 * (1 - phase_t)
            shoulder[0] += lean_back
            head[0] += lean_back

            elbow_front = [f * 12 + lean_back, shoulder[1] + 10]
            hand_front = [f * 8 + lean_back, shoulder[1] - 2]
            elbow_back = [-f * 8 + lean_back, shoulder[1] + 12]
            hand_back = [-f * 6 + lean_back, shoulder[1] + 4]

            return {
                "foot_back": foot_back, "foot_front": kick_foot,
                "knee_back": knee_back, "knee_front": kick_knee,
                "hip": hip, "shoulder": shoulder, "head": head,
                "elbow_front": elbow_front, "hand_front": hand_front,
                "elbow_back": elbow_back, "hand_back": hand_back,
            }

    def _skeleton_hadouken(
        self, f: int, leg_len: float, thigh_len: float, torso_len: float,
        upper_arm: float, forearm: float, head_radius: float,
        phase: int, phase_t: float,
    ) -> Skeleton:
        """Hadouken pose: both arms thrust forward."""
        foot_back = [-f * 14, 0.0]
        foot_front = [f * 14, 0.0]
        knee_back = [-f * 10, -leg_len + 3]
        knee_front = [f * 10, -leg_len + 3]
        hip: list[float] = [0.0, -(leg_len + thigh_len * 0.3)]
        shoulder: list[float] = [0.0, -(leg_len + thigh_len + torso_len)]
        head: list[float] = [0.0, -(leg_len + thigh_len + torso_len + 10 + 2)]

        reach = (upper_arm + forearm) * 1.5
        thrust_y = shoulder[1] + (hip[1] - shoulder[1]) * 0.35

        if phase == 0:
            # Gathering energy: hands pull back to hip
            gather = phase_t
            pull_back = -f * 6 * gather
            shoulder[0] += pull_back * 0.5
            head[0] += pull_back * 0.3
            elbow_front = [f * 5 - f * 12 * gather, shoulder[1] + 8 + 12 * gather]
            hand_front = [f * 2 - f * 8 * gather, hip[1] - 5 * (1 - gather)]
            elbow_back = [-f * 5 - f * 5 * gather, shoulder[1] + 8 + 12 * gather]
            hand_back = [-f * 2 - f * 5 * gather, hip[1] - 5 * (1 - gather)]
        elif phase == 1:
            # Release: both arms thrust forward
            lean_fwd = float(f * 10)
            shoulder[0] += lean_fwd
            head[0] += lean_fwd
            elbow_front = [f * reach * 0.4, thrust_y - 3]
            hand_front = [f * reach, thrust_y]
            elbow_back = [f * reach * 0.35, thrust_y + 3]
            hand_back = [f * reach * 0.9, thrust_y + 2]
        else:
            # Recovery: return to guard
            retract = 1 - phase_t
            lean_fwd = f * 10.0 * retract
            shoulder[0] += lean_fwd
            head[0] += lean_fwd
            elbow_front = [
                f * reach * 0.4 * retract + f * 15 * (1 - retract),
                thrust_y * retract + (shoulder[1] + 12) * (1 - retract),
            ]
            hand_front = [
                f * reach * retract + f * 10 * (1 - retract),
                thrust_y * retract + (shoulder[1] - 2) * (1 - retract),
            ]
            elbow_back = [
                f * reach * 0.35 * retract + (-f * 8) * (1 - retract),
                (thrust_y + 3) * retract + (shoulder[1] + 15) * (1 - retract),
            ]
            hand_back = [
                f * reach * 0.9 * retract + (-f * 4) * (1 - retract),
                (thrust_y + 2) * retract + (shoulder[1] + 5) * (1 - retract),
            ]

        return {
            "foot_back": foot_back, "foot_front": foot_front,
            "knee_back": knee_back, "knee_front": knee_front,
            "hip": hip, "shoulder": shoulder, "head": head,
            "elbow_front": elbow_front, "hand_front": hand_front,
            "elbow_back": elbow_back, "hand_back": hand_back,
        }

    def _skeleton_hitstun(
        self, f: int, leg_len: float, thigh_len: float, torso_len: float,
        upper_arm: float, forearm: float, head_radius: float,
    ) -> Skeleton:
        shake = math.sin(self.stun_frames * 2) * 3

        shoulder_y = -(leg_len + thigh_len + torso_len) + 5

        return {
            "foot_back": [-f * 12, 0.0],
            "foot_front": [f * 5, 0.0],
            "knee_back": [-f * 8, -leg_len + 5],
            "knee_front": [f * 2, -leg_len + 3],
            "hip": [-f * 5 + shake, -(leg_len + thigh_len * 0.3)],
            "shoulder": [-f * 10 + shake, shoulder_y],
            "head": [-f * 12 + shake, -(leg_len + thigh_len + torso_len + head_radius + 2) + 5],
            "elbow_front": [f * 2 + shake, shoulder_y + 15],
            "hand_front": [f * 8 + shake, shoulder_y + 20],
            "elbow_back": [-f * 15 + shake, shoulder_y + 10],
            "hand_back": [-f * 12 + shake, shoulder_y + 18],
        }

    def _skeleton_block(
        self, f: int, leg_len: float, thigh_len: float, torso_len: float,
        upper_arm: float, forearm: float, head_radius: float,
    ) -> Skeleton:
        push = math.sin(self.stun_frames * 3) * 2

        shoulder_y = -(leg_len + thigh_len + torso_len)

        return {
            "foot_back": [-f * 12, 0.0],
            "foot_front": [f * 6, 0.0],
            "knee_back": [-f * 10, -leg_len + 3],
            "knee_front": [f * 4, -leg_len + 2],
            "hip": [-f * 3 + push, -(leg_len + thigh_len * 0.3)],
            "shoulder": [-f * 2 + push, shoulder_y],
            "head": [-f * 2 + push, -(leg_len + thigh_len + torso_len + head_radius + 2)],
            "elbow_front": [f * 8, shoulder_y + 3],
            "hand_front": [f * 4, shoulder_y - 12],
            "elbow_back": [f * 3, shoulder_y + 8],
            "hand_back": [f * 6, shoulder_y - 5],
        }
