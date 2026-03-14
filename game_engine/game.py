"""GameEngine — headless game loop, hit detection, and clash resolution.

Mirrors the update logic from src/game.js without rendering.
"""

from __future__ import annotations

from dataclasses import dataclass

from game_engine.actions import HADOUKEN_DATA
from game_engine.fighter import Fighter, Rect, _rects_overlap

# Projectile constants (match src/game.js)
PROJECTILE_SPEED = 500.0
PROJECTILE_DAMAGE = 25.0


@dataclass
class Projectile:
    """A hadouken energy ball traveling across the stage."""

    x: float
    y: float
    vx: float
    owner: str  # "p1" or "p2"
    active: bool = True


class GameEngine:
    """Server-authoritative headless game engine for one match."""

    STAGE_MARGIN = 0.05

    def __init__(self, width: float = 800.0, height: float = 400.0) -> None:
        self.width = width
        self.height = height
        self.floor_y = height - 160
        self.stage_left = width * self.STAGE_MARGIN
        self.stage_right = width * (1 - self.STAGE_MARGIN)
        start_offset = (self.stage_right - self.stage_left) * 0.25

        self.p1 = Fighter(self.stage_left + start_offset, self.floor_y, 1)
        self.p2 = Fighter(self.stage_right - start_offset, self.floor_y, -1)

        self.round_over = False
        self.round_timer = 99.0
        self._last_clash_key: str | None = None
        self.projectiles: list[Projectile] = []

    def tick(
        self,
        dt: float,
        p1_actions: set[str],
        p1_just_pressed: set[str],
        p2_actions: set[str],
        p2_just_pressed: set[str],
    ) -> None:
        """Advance one game tick. Mirrors src/game.js _update()."""
        if self.round_over:
            return

        self.round_timer -= dt
        if self.round_timer <= 0:
            self.round_timer = 0.0
            self.round_over = True
            return

        # Update facing
        if self.p1.x < self.p2.x:
            self.p1.facing = 1
            self.p2.facing = -1
        else:
            self.p1.facing = -1
            self.p2.facing = 1

        # Update fighters
        self.p1.update(dt, p1_actions, p1_just_pressed, self.p2, self.stage_left, self.stage_right)
        self.p2.update(dt, p2_actions, p2_just_pressed, self.p1, self.stage_left, self.stage_right)

        # Handle hadouken fire events → spawn projectiles
        self._handle_projectile_spawn(self.p1, "p1")
        self._handle_projectile_spawn(self.p2, "p2")

        # Update projectiles (movement + collision)
        self._update_projectiles(dt, p1_actions, p2_actions)

        # Check attack clash
        clashed = self._check_clash(self.p1, self.p2)

        # Normal hit checks only if no clash
        if not clashed:
            self._check_hit(self.p1, self.p2, p2_actions)
            self._check_hit(self.p2, self.p1, p1_actions)

        # Track impact points for swept collision next frame
        self.p1.update_impact_tracking()
        self.p2.update_impact_tracking()

        if self.p1.health <= 0 or self.p2.health <= 0:
            self.round_over = True

    def _handle_projectile_spawn(self, fighter: Fighter, owner: str) -> None:
        """Spawn a projectile when a fighter fires a hadouken."""
        if "hadouken:fire" not in fighter.events:
            return
        # Only one active projectile per player
        if any(p.owner == owner and p.active for p in self.projectiles):
            return
        skeleton = fighter._build_skeleton()
        hand = fighter._local_to_world(skeleton["hand_front"][0], skeleton["hand_front"][1])
        self.projectiles.append(
            Projectile(x=hand[0], y=hand[1], vx=fighter.facing * PROJECTILE_SPEED, owner=owner)
        )

    def _update_projectiles(
        self, dt: float, p1_actions: set[str], p2_actions: set[str],
    ) -> None:
        """Move projectiles and check for collisions with opponents."""
        for proj in self.projectiles:
            if not proj.active:
                continue
            proj.x += proj.vx * dt

            # Off stage?
            if proj.x < self.stage_left - 30 or proj.x > self.stage_right + 30:
                proj.active = False
                continue

            # Collision with opponent
            target = self.p2 if proj.owner == "p1" else self.p1
            target_actions = p2_actions if proj.owner == "p1" else p1_actions
            attacker = self.p1 if proj.owner == "p1" else self.p2

            # Skip if target already stunned
            if target.state in ("hitstun", "blockstun"):
                continue

            # Projectile hitbox (24x24 mid-height)
            p_rect = Rect(x=proj.x - 12, y=proj.y - 12, w=24, h=24)
            # Target body bounding box
            t_rect = Rect(
                x=target.x - target.width / 2,
                y=target.y - target.height,
                w=target.width,
                h=target.height,
            )

            if _rects_overlap(p_rect, t_rect):
                proj.active = False
                if target.is_blocking(target_actions) and target.grounded:
                    target.apply_block(HADOUKEN_DATA)
                else:
                    target.health = max(0.0, target.health - PROJECTILE_DAMAGE)
                    target.state = "hitstun"
                    target.stun_frames = float(HADOUKEN_DATA.hitstun)
                    direction = 1 if target.x > attacker.x else -1
                    target.vx = direction * 200.0
                    target.current_attack = None

                if target.health <= 0:
                    self.round_over = True

        # Clean up inactive
        self.projectiles = [p for p in self.projectiles if p.active]

    def _check_clash(self, f1: Fighter, f2: Fighter) -> bool:
        h1 = f1.get_attack_hitbox()
        h2 = f2.get_attack_hitbox()
        if h1 is None or h2 is None:
            return False

        # Prevent multi-clash on same attack frame pair
        clash_key = f"{f1.attack_frame},{f2.attack_frame}"
        if self._last_clash_key == clash_key:
            return False

        if not _rects_overlap(h1, h2):
            return False

        self._last_clash_key = clash_key

        # Both fighters take the other's attack damage at limb multiplier (0.5x)
        d1 = f1.get_attack_data()
        d2 = f2.get_attack_data()
        f1.attack_has_hit = True
        f2.attack_has_hit = True
        if d1 is not None:
            f2.apply_hit(d1, 0.5, f1.x)
        if d2 is not None:
            f1.apply_hit(d2, 0.5, f2.x)

        return True

    def _check_hit(self, attacker: Fighter, defender: Fighter, defender_actions: set[str]) -> None:
        result = attacker.get_attack_hit(defender)
        if result is None:
            return

        attacker.attack_has_hit = True

        if defender.is_blocking(defender_actions) and defender.grounded:
            defender.apply_block(result.hit_data)
        else:
            defender.apply_hit(result.hit_data, result.multiplier, attacker.x)
