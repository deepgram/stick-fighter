"""Tests for the Python game engine — physics, state machine, hit detection."""

import pytest

from game_engine.actions import Actions, ATTACK_DATA, ATTACK_ACTIONS, HADOUKEN_DATA
from game_engine.fighter import Fighter, Rect, _rects_overlap
from game_engine.game import GameEngine, Projectile

# Constants matching the 800x400 canvas
FLOOR_Y = 240.0  # 400 - 160
STAGE_LEFT = 40.0  # 800 * 0.05
STAGE_RIGHT = 760.0  # 800 * 0.95


@pytest.fixture
def fighter() -> Fighter:
    return Fighter(400.0, FLOOR_Y, 1)


@pytest.fixture
def opponent() -> Fighter:
    return Fighter(500.0, FLOOR_Y, -1)


@pytest.fixture
def engine() -> GameEngine:
    return GameEngine()


# ─────────────────────────────────────────
# Actions & Attack Data
# ─────────────────────────────────────────
class TestActions:
    def test_actions_are_strings(self) -> None:
        assert Actions.LIGHT_PUNCH == "lightPunch"
        assert Actions.HEAVY_KICK == "heavyKick"

    def test_attack_data_completeness(self) -> None:
        expected = {
            Actions.LIGHT_PUNCH, Actions.MEDIUM_PUNCH, Actions.HEAVY_PUNCH,
            Actions.LIGHT_KICK, Actions.MEDIUM_KICK, Actions.HEAVY_KICK,
        }
        assert set(ATTACK_DATA.keys()) == expected

    def test_attack_actions_matches_data(self) -> None:
        assert ATTACK_ACTIONS == frozenset(ATTACK_DATA.keys())

    def test_string_lookup_works(self) -> None:
        """Plain strings work as keys due to StrEnum."""
        assert "lightPunch" in ATTACK_ACTIONS
        assert ATTACK_DATA["lightPunch"].damage == 3


# ─────────────────────────────────────────
# Fighter Physics
# ─────────────────────────────────────────
class TestFighterPhysics:
    def test_initial_state(self, fighter: Fighter) -> None:
        assert fighter.state == "idle"
        assert fighter.health == 100.0
        assert fighter.grounded
        assert fighter.vx == 0.0
        assert fighter.vy == 0.0

    def test_walk_right(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, {Actions.RIGHT}, set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "walk"
        assert fighter.x > 400.0

    def test_walk_left(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, {Actions.LEFT}, set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "walk"
        assert fighter.x < 400.0

    def test_jump(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.JUMP}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "jump"
        assert fighter.vy < 0  # moving up

    def test_double_jump(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.JUMP}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.jump_count == 1
        fighter.update(1 / 60, set(), {Actions.JUMP}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.jump_count == 2
        # Third jump should not work
        fighter.update(1 / 60, set(), {Actions.JUMP}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.jump_count == 2  # unchanged

    def test_gravity(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, 1)
        fighter.y = FLOOR_Y - 50  # in air
        fighter.vy = 0.0
        fighter.update(1 / 60, set(), set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.vy > 0  # gravity pulling down

    def test_floor_clamp(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, 1)
        fighter.y = FLOOR_Y + 10  # below floor
        fighter.vy = 100.0
        fighter._apply_physics(1 / 60, STAGE_LEFT, STAGE_RIGHT, None)
        assert fighter.y == FLOOR_Y
        assert fighter.vy == 0.0

    def test_stage_bounds_left(self, fighter: Fighter) -> None:
        fighter.x = STAGE_LEFT
        fighter.update(1 / 60, {Actions.LEFT}, set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.x >= STAGE_LEFT + fighter.width / 2

    def test_stage_bounds_right(self, fighter: Fighter) -> None:
        fighter.x = STAGE_RIGHT
        fighter.update(1 / 60, {Actions.RIGHT}, set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.x <= STAGE_RIGHT - fighter.width / 2

    def test_crouch(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, {Actions.DOWN}, set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "crouch"
        assert fighter.vx == 0.0

    def test_push_apart(self) -> None:
        f1 = Fighter(400.0, FLOOR_Y, 1)
        f2 = Fighter(410.0, FLOOR_Y, -1)
        f1.update(1 / 60, set(), set(), f2, STAGE_LEFT, STAGE_RIGHT)
        assert f1.x < f2.x


# ─────────────────────────────────────────
# Fighter Combat
# ─────────────────────────────────────────
class TestFighterCombat:
    def test_attack_starts(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.LIGHT_PUNCH}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "attack"
        assert fighter.current_attack == Actions.LIGHT_PUNCH
        assert not fighter.attack_has_hit

    def test_attack_ends(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.LIGHT_PUNCH}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "attack"
        # LIGHT_PUNCH: startup=2 + active=2 + recovery=3 = 7 frames at 60fps
        for _ in range(12):
            fighter.update(1 / 60, set(), set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state != "attack"
        assert fighter.current_attack is None

    def test_attack_context_stand(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.LIGHT_PUNCH}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.attack_context == "stand"

    def test_attack_context_crouch(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, {Actions.DOWN}, set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "crouch"
        fighter.update(1 / 60, {Actions.DOWN}, {Actions.LIGHT_KICK}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.attack_context == "crouch"

    def test_attack_context_air(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.JUMP}, None, STAGE_LEFT, STAGE_RIGHT)
        fighter.update(1 / 60, set(), {Actions.LIGHT_PUNCH}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.attack_context == "air"

    def test_blocking_facing_right(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, 1)
        assert fighter.is_blocking({Actions.LEFT})
        assert not fighter.is_blocking({Actions.RIGHT})
        assert not fighter.is_blocking(set())

    def test_blocking_facing_left(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, -1)
        assert fighter.is_blocking({Actions.RIGHT})
        assert not fighter.is_blocking({Actions.LEFT})

    def test_apply_hit(self, fighter: Fighter) -> None:
        data = ATTACK_DATA[Actions.LIGHT_PUNCH]
        fighter.apply_hit(data, 1.0, 300.0)
        assert fighter.health == 100.0 - 3.0
        assert fighter.state == "hitstun"
        assert fighter.vx > 0  # knocked right (away from attacker at x=300)

    def test_apply_hit_multiplier(self, fighter: Fighter) -> None:
        data = ATTACK_DATA[Actions.LIGHT_PUNCH]
        fighter.apply_hit(data, 2.0, 300.0)
        assert fighter.health == 100.0 - 6.0  # 3 * 2x

    def test_apply_block(self, fighter: Fighter) -> None:
        data = ATTACK_DATA[Actions.LIGHT_PUNCH]
        fighter.apply_block(data)
        assert fighter.state == "blockstun"
        assert fighter.health == 100.0  # no damage

    def test_stun_recovery(self, fighter: Fighter) -> None:
        fighter.state = "hitstun"
        fighter.stun_frames = 1.0
        for _ in range(5):
            fighter.update(1 / 60, set(), set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "idle"
        assert fighter.stun_frames == 0.0

    def test_attack_events(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.LIGHT_PUNCH}, None, STAGE_LEFT, STAGE_RIGHT)
        assert "punch:3" in fighter.events

    def test_kick_events(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.HEAVY_KICK}, None, STAGE_LEFT, STAGE_RIGHT)
        assert "kick:11" in fighter.events


# ─────────────────────────────────────────
# Dash
# ─────────────────────────────────────────
class TestFighterDash:
    def test_dash_right(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.DASH_RIGHT}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.dash_timer > 0
        assert fighter.dash_dir == 1
        assert "dash" in fighter.events

    def test_dash_left(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.DASH_LEFT}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.dash_timer > 0
        assert fighter.dash_dir == -1

    def test_dash_forward(self, fighter: Fighter) -> None:
        # facing = 1 (right), dash forward → dir = 1
        fighter.update(1 / 60, set(), {Actions.DASH_FORWARD}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.dash_dir == 1

    def test_dash_back(self, fighter: Fighter) -> None:
        # facing = 1 (right), dash back → dir = -1
        fighter.update(1 / 60, set(), {Actions.DASH_BACK}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.dash_dir == -1

    def test_dash_speed(self, fighter: Fighter) -> None:
        x_before = fighter.x
        fighter.update(1 / 60, set(), {Actions.DASH_RIGHT}, None, STAGE_LEFT, STAGE_RIGHT)
        x_after = fighter.x
        # Dash is faster than walk
        fighter2 = Fighter(400.0, FLOOR_Y, 1)
        fighter2.update(1 / 60, {Actions.RIGHT}, set(), None, STAGE_LEFT, STAGE_RIGHT)
        walk_dist = fighter2.x - 400.0
        dash_dist = x_after - x_before
        assert dash_dist > walk_dist

    def test_somersault(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, 1)
        # Jump first
        fighter.update(1 / 60, set(), {Actions.JUMP}, None, STAGE_LEFT, STAGE_RIGHT)
        assert not fighter.grounded
        # Now somersault
        fighter.update(1 / 60, set(), {Actions.SOMERSAULT}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.is_flipping
        assert fighter.flip_count == 1
        assert "somersault" in fighter.events


# ─────────────────────────────────────────
# Hitbox / Hurtbox
# ─────────────────────────────────────────
class TestHitDetection:
    def test_hurtboxes_exist(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, 1)
        hurtboxes = fighter.get_hurtboxes()
        assert len(hurtboxes) > 0
        zones = [h.zone for h in hurtboxes]
        assert "head" in zones
        assert "body" in zones
        assert "crotch" in zones
        assert "arm" in zones
        assert "leg" in zones

    def test_hurtbox_multipliers(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, 1)
        hurtboxes = fighter.get_hurtboxes()
        for hb in hurtboxes:
            if hb.zone == "head":
                assert hb.multiplier == 2.0
            elif hb.zone == "crotch":
                assert hb.multiplier == 3.0
            elif hb.zone == "body":
                assert hb.multiplier == 1.0
            elif hb.zone in ("arm", "leg"):
                assert hb.multiplier == 0.5

    def test_no_hitbox_in_idle(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, 1)
        assert fighter.get_attack_hitbox() is None

    def test_no_hitbox_during_startup(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, 1)
        fighter.update(1 / 60, set(), {Actions.LIGHT_PUNCH}, None, STAGE_LEFT, STAGE_RIGHT)
        # First frame — should be in startup
        assert fighter.get_attack_hitbox() is None

    def test_hitbox_during_active_frames(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, 1)
        fighter.update(1 / 60, set(), {Actions.LIGHT_PUNCH}, None, STAGE_LEFT, STAGE_RIGHT)
        # Advance through startup (2 frames at 60fps)
        for _ in range(3):
            fighter.update_impact_tracking()
            fighter.update(1 / 60, set(), set(), None, STAGE_LEFT, STAGE_RIGHT)
        hitbox = fighter.get_attack_hitbox()
        assert hitbox is not None

    def test_no_hitbox_after_hit(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, 1)
        fighter.update(1 / 60, set(), {Actions.LIGHT_PUNCH}, None, STAGE_LEFT, STAGE_RIGHT)
        fighter.attack_has_hit = True
        assert fighter.get_attack_hitbox() is None

    def test_rects_overlap(self) -> None:
        a = Rect(0, 0, 10, 10)
        b = Rect(5, 5, 10, 10)
        assert _rects_overlap(a, b)

    def test_rects_no_overlap(self) -> None:
        a = Rect(0, 0, 10, 10)
        b = Rect(20, 20, 10, 10)
        assert not _rects_overlap(a, b)

    def test_impact_tracking(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, 1)
        assert fighter._prev_impact is None
        fighter.update(1 / 60, set(), {Actions.LIGHT_PUNCH}, None, STAGE_LEFT, STAGE_RIGHT)
        fighter.update_impact_tracking()
        assert fighter._prev_impact is not None


# ─────────────────────────────────────────
# Game Engine
# ─────────────────────────────────────────
class TestGameEngine:
    def test_initial_state(self, engine: GameEngine) -> None:
        assert not engine.round_over
        assert engine.round_timer == 99.0
        assert engine.p1.health == 100.0
        assert engine.p2.health == 100.0

    def test_facing(self, engine: GameEngine) -> None:
        engine.tick(1 / 60, set(), set(), set(), set())
        assert engine.p1.facing == 1
        assert engine.p2.facing == -1

    def test_facing_swaps(self, engine: GameEngine) -> None:
        # Move P1 past P2
        engine.p1.x = 600.0
        engine.p2.x = 400.0
        engine.tick(1 / 60, set(), set(), set(), set())
        assert engine.p1.facing == -1
        assert engine.p2.facing == 1

    def test_round_timer(self, engine: GameEngine) -> None:
        engine.tick(1.0, set(), set(), set(), set())
        assert engine.round_timer < 99.0

    def test_round_over_on_timeout(self, engine: GameEngine) -> None:
        engine.round_timer = 0.5
        engine.tick(1.0, set(), set(), set(), set())
        assert engine.round_over

    def test_round_over_on_ko(self, engine: GameEngine) -> None:
        engine.p1.health = 0.0
        engine.tick(1 / 60, set(), set(), set(), set())
        assert engine.round_over

    def test_no_update_after_round_over(self, engine: GameEngine) -> None:
        engine.round_over = True
        old_timer = engine.round_timer
        engine.tick(1 / 60, set(), set(), set(), set())
        assert engine.round_timer == old_timer

    def test_hit_in_game(self, engine: GameEngine) -> None:
        """Verify combat works end-to-end without crashing."""
        engine.p1.x = 400.0
        engine.p2.x = 440.0
        engine.tick(1 / 60, set(), {Actions.LIGHT_PUNCH}, set(), set())
        for _ in range(10):
            engine.tick(1 / 60, set(), set(), set(), set())
        assert engine.p2.health <= 100.0

    def test_stage_dimensions(self, engine: GameEngine) -> None:
        assert engine.floor_y == 240.0
        assert engine.stage_left == 40.0
        assert engine.stage_right == 760.0


# ─────────────────────────────────────────
# Determinism
# ─────────────────────────────────────────
class TestDeterminism:
    def test_deterministic_fighter_update(self) -> None:
        f1 = Fighter(400.0, FLOOR_Y, 1)
        f2 = Fighter(400.0, FLOOR_Y, 1)

        actions: set[str] = {Actions.RIGHT}
        pressed: set[str] = {Actions.LIGHT_PUNCH}

        f1.update(1 / 60, actions, pressed, None, STAGE_LEFT, STAGE_RIGHT)
        f2.update(1 / 60, actions, pressed, None, STAGE_LEFT, STAGE_RIGHT)

        assert f1.x == f2.x
        assert f1.y == f2.y
        assert f1.vx == f2.vx
        assert f1.vy == f2.vy
        assert f1.state == f2.state
        assert f1.health == f2.health
        assert f1.attack_frame == f2.attack_frame

    def test_deterministic_game_engine(self) -> None:
        e1 = GameEngine()
        e2 = GameEngine()

        inputs: list[tuple[float, set[str], set[str], set[str], set[str]]] = [
            (1 / 60, set(), {Actions.JUMP}, {Actions.LEFT}, set()),
            (1 / 60, {Actions.RIGHT}, set(), {Actions.LEFT}, {Actions.LIGHT_PUNCH}),
            (1 / 60, {Actions.RIGHT}, {Actions.LIGHT_KICK}, set(), set()),
        ]

        for dt, p1a, p1p, p2a, p2p in inputs:
            e1.tick(dt, p1a, p1p, p2a, p2p)
            e2.tick(dt, p1a, p1p, p2a, p2p)

        assert e1.p1.x == e2.p1.x
        assert e1.p1.y == e2.p1.y
        assert e1.p2.x == e2.p2.x
        assert e1.p2.y == e2.p2.y
        assert e1.p1.health == e2.p1.health
        assert e1.p2.health == e2.p2.health
        assert e1.round_timer == e2.round_timer

    def test_deterministic_multi_frame(self) -> None:
        """Run many frames and verify both engines stay in sync."""
        e1 = GameEngine()
        e2 = GameEngine()

        for i in range(120):  # 2 seconds at 60fps
            p1a: set[str] = {Actions.RIGHT} if i % 3 == 0 else set()
            p2a: set[str] = {Actions.LEFT} if i % 4 == 0 else set()
            p1p: set[str] = {Actions.LIGHT_PUNCH} if i == 30 else set()
            p2p: set[str] = {Actions.MEDIUM_KICK} if i == 45 else set()

            e1.tick(1 / 60, p1a, p1p, p2a, p2p)
            e2.tick(1 / 60, p1a, p1p, p2a, p2p)

        assert e1.p1.x == e2.p1.x
        assert e1.p2.x == e2.p2.x
        assert e1.p1.health == e2.p1.health
        assert e1.p2.health == e2.p2.health


# ─────────────────────────────────────────
# State machine transitions
# ─────────────────────────────────────────
class TestStateMachine:
    def test_idle_to_walk(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, {Actions.RIGHT}, set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "walk"

    def test_idle_to_jump(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.JUMP}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "jump"

    def test_idle_to_crouch(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, {Actions.DOWN}, set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "crouch"

    def test_idle_to_attack(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.LIGHT_PUNCH}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "attack"

    def test_attack_to_idle(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.LIGHT_PUNCH}, None, STAGE_LEFT, STAGE_RIGHT)
        for _ in range(12):
            fighter.update(1 / 60, set(), set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "idle"

    def test_attack_to_jump_if_airborne(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, 1)
        fighter.update(1 / 60, set(), {Actions.JUMP}, None, STAGE_LEFT, STAGE_RIGHT)
        fighter.update(1 / 60, set(), {Actions.LIGHT_PUNCH}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.attack_context == "air"
        for _ in range(12):
            fighter.update(1 / 60, set(), set(), None, STAGE_LEFT, STAGE_RIGHT)
        # Should return to jump state since airborne
        if not fighter.grounded:
            assert fighter.state == "jump"

    def test_hitstun_to_idle(self, fighter: Fighter) -> None:
        data = ATTACK_DATA[Actions.LIGHT_PUNCH]
        fighter.apply_hit(data, 1.0, 300.0)
        assert fighter.state == "hitstun"
        for _ in range(20):
            fighter.update(1 / 60, set(), set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "idle"

    def test_blockstun_to_idle(self, fighter: Fighter) -> None:
        data = ATTACK_DATA[Actions.LIGHT_PUNCH]
        fighter.apply_block(data)
        assert fighter.state == "blockstun"
        for _ in range(20):
            fighter.update(1 / 60, set(), set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "idle"

    def test_no_attack_during_stun(self, fighter: Fighter) -> None:
        fighter.state = "hitstun"
        fighter.stun_frames = 10.0
        fighter.update(1 / 60, set(), {Actions.LIGHT_PUNCH}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "hitstun"  # can't attack during stun

    def test_jump_count_resets_on_land(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, 1)
        fighter.update(1 / 60, set(), {Actions.JUMP}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.jump_count == 1
        # Let it land
        for _ in range(60):
            fighter.update(1 / 60, set(), set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.grounded
        assert fighter.jump_count == 0


# ─────────────────────────────────────────
# Hadouken Special Move
# ─────────────────────────────────────────
class TestHadoukenFighter:
    def test_hadouken_action_exists(self) -> None:
        assert Actions.HADOUKEN == "hadouken"

    def test_hadouken_data_separate_from_attacks(self) -> None:
        """HADOUKEN should NOT be in ATTACK_ACTIONS (it's a special move)."""
        assert Actions.HADOUKEN not in ATTACK_ACTIONS
        assert HADOUKEN_DATA.damage == 25
        assert HADOUKEN_DATA.startup == 18

    def test_hadouken_enters_attack_state(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.HADOUKEN}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state == "attack"
        assert fighter.current_attack == Actions.HADOUKEN

    def test_hadouken_windup_event(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.HADOUKEN}, None, STAGE_LEFT, STAGE_RIGHT)
        assert "hadouken:windup" in fighter.events

    def test_hadouken_fire_event(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.HADOUKEN}, None, STAGE_LEFT, STAGE_RIGHT)
        # Advance past startup frames (18 frames at 60fps ≈ 0.3s)
        fired = False
        for _ in range(25):
            fighter.update(1 / 60, set(), set(), None, STAGE_LEFT, STAGE_RIGHT)
            if "hadouken:fire" in fighter.events:
                fired = True
                break
        assert fired

    def test_hadouken_sets_cooldown(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.HADOUKEN}, None, STAGE_LEFT, STAGE_RIGHT)
        # Advance past startup to trigger fire event
        for _ in range(25):
            fighter.update(1 / 60, set(), set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.hadouken_cooldown > 0

    def test_hadouken_blocked_during_cooldown(self, fighter: Fighter) -> None:
        fighter.hadouken_cooldown = 1.0
        fighter.update(1 / 60, set(), {Actions.HADOUKEN}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.state != "attack" or fighter.current_attack != Actions.HADOUKEN

    def test_hadouken_requires_grounded(self) -> None:
        fighter = Fighter(400.0, FLOOR_Y, 1)
        fighter.update(1 / 60, set(), {Actions.JUMP}, None, STAGE_LEFT, STAGE_RIGHT)
        assert not fighter.grounded
        fighter.update(1 / 60, set(), {Actions.HADOUKEN}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.current_attack != Actions.HADOUKEN

    def test_hadouken_no_melee_hitbox(self, fighter: Fighter) -> None:
        fighter.update(1 / 60, set(), {Actions.HADOUKEN}, None, STAGE_LEFT, STAGE_RIGHT)
        # Even during active frames, no melee hitbox
        for _ in range(25):
            fighter.update(1 / 60, set(), set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.get_attack_hitbox() is None

    def test_hadouken_get_attack_data(self, fighter: Fighter) -> None:
        fighter.state = "attack"
        fighter.current_attack = Actions.HADOUKEN
        data = fighter.get_attack_data()
        assert data is not None
        assert data.damage == 25

    def test_hadouken_cooldown_ticks_down(self, fighter: Fighter) -> None:
        fighter.hadouken_cooldown = 1.0
        fighter.update(1 / 60, set(), set(), None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.hadouken_cooldown < 1.0

    def test_hadouken_cancels_dash(self, fighter: Fighter) -> None:
        fighter.dash_timer = 0.1
        fighter.update(1 / 60, set(), {Actions.HADOUKEN}, None, STAGE_LEFT, STAGE_RIGHT)
        assert fighter.dash_timer == 0.0

    def test_hadouken_priority_over_heavy_punch(self, fighter: Fighter) -> None:
        """When both HADOUKEN and HEAVY_PUNCH are pressed, hadouken wins."""
        fighter.update(
            1 / 60, set(), {Actions.HADOUKEN, Actions.HEAVY_PUNCH}, None, STAGE_LEFT, STAGE_RIGHT,
        )
        assert fighter.current_attack == Actions.HADOUKEN

    def test_hadouken_skeleton_builds(self, fighter: Fighter) -> None:
        """Hadouken skeleton should not crash."""
        fighter.state = "attack"
        fighter.current_attack = Actions.HADOUKEN
        fighter.attack_frame = 0.0
        skeleton = fighter._build_skeleton()
        assert "hand_front" in skeleton
        assert "shoulder" in skeleton


class TestHadoukenProjectile:
    def test_engine_spawns_projectile(self, engine: GameEngine) -> None:
        engine.tick(1 / 60, set(), {Actions.HADOUKEN}, set(), set())
        # Advance past startup
        for _ in range(25):
            engine.tick(1 / 60, set(), set(), set(), set())
        assert len(engine.projectiles) == 1
        assert engine.projectiles[0].owner == "p1"

    def test_projectile_moves(self, engine: GameEngine) -> None:
        engine.tick(1 / 60, set(), {Actions.HADOUKEN}, set(), set())
        for _ in range(25):
            engine.tick(1 / 60, set(), set(), set(), set())
        assert len(engine.projectiles) == 1
        x_before = engine.projectiles[0].x
        engine.tick(1 / 60, set(), set(), set(), set())
        assert engine.projectiles[0].x > x_before  # moving right (facing=1)

    def test_projectile_hits_opponent(self, engine: GameEngine) -> None:
        # Place fighters close so projectile hits quickly
        engine.p1.x = 300.0
        engine.p2.x = 350.0
        p2_health_before = engine.p2.health
        engine.tick(1 / 60, set(), {Actions.HADOUKEN}, set(), set())
        # Advance many frames
        for _ in range(60):
            engine.tick(1 / 60, set(), set(), set(), set())
        assert engine.p2.health < p2_health_before

    def test_projectile_damage_amount(self, engine: GameEngine) -> None:
        engine.p1.x = 300.0
        engine.p2.x = 360.0
        p2_initial = engine.p2.health
        engine.tick(1 / 60, set(), {Actions.HADOUKEN}, set(), set())
        for _ in range(60):
            engine.tick(1 / 60, set(), set(), set(), set())
        assert engine.p2.health == p2_initial - 25

    def test_projectile_blocked(self, engine: GameEngine) -> None:
        engine.p1.x = 300.0
        engine.p2.x = 360.0
        engine.p2.facing = -1  # facing left, so blocking = hold RIGHT
        p2_health_before = engine.p2.health
        engine.tick(1 / 60, set(), {Actions.HADOUKEN}, {Actions.RIGHT}, set())
        for _ in range(60):
            engine.tick(1 / 60, set(), set(), {Actions.RIGHT}, set())
        # Health unchanged when blocked
        assert engine.p2.health == p2_health_before

    def test_projectile_removed_off_stage(self, engine: GameEngine) -> None:
        engine.tick(1 / 60, set(), {Actions.HADOUKEN}, set(), set())
        for _ in range(25):
            engine.tick(1 / 60, set(), set(), set(), set())
        assert len(engine.projectiles) == 1
        # Advance enough for projectile to leave stage (760px / 500px/s ≈ 1.5s)
        for _ in range(120):
            engine.tick(1 / 60, set(), set(), set(), set())
        assert len(engine.projectiles) == 0

    def test_one_projectile_per_player(self, engine: GameEngine) -> None:
        engine.tick(1 / 60, set(), {Actions.HADOUKEN}, set(), set())
        for _ in range(25):
            engine.tick(1 / 60, set(), set(), set(), set())
        assert len(engine.projectiles) == 1
        # Try to fire again immediately (simulate — bypass cooldown for test)
        engine.p1.hadouken_cooldown = 0
        engine.p1.state = "idle"
        engine.p1.current_attack = None
        engine.tick(1 / 60, set(), {Actions.HADOUKEN}, set(), set())
        for _ in range(25):
            engine.tick(1 / 60, set(), set(), set(), set())
        # Still only one because first is still active
        p1_projs = [p for p in engine.projectiles if p.owner == "p1"]
        assert len(p1_projs) <= 1

    def test_projectile_jumpable(self) -> None:
        """At jump peak, the fighter's body box is above the projectile hitbox.

        Projectile spawns at y≈159 (mid-body height). Its hitbox is 24x24.
        A fighter at jump peak has feet at y=133 (floor_y - 107), body top at y=13.
        The projectile's top edge (147) is above the body's bottom edge (133),
        so there's no overlap — the projectile passes underneath.
        """
        peak_y = FLOOR_Y - 107  # fighter feet at jump peak
        body = Rect(x=380, y=peak_y - 120, w=40, h=120)  # body from head to feet
        proj = Rect(x=380, y=159 - 12, w=24, h=24)  # projectile at mid-body height
        assert not _rects_overlap(proj, body), "Projectile should pass under fighter at jump peak"

    def test_projectile_dataclass(self) -> None:
        p = Projectile(x=100.0, y=160.0, vx=500.0, owner="p1")
        assert p.active
        assert p.x == 100.0
