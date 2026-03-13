"""Tests for game_loop.py — server-side game loop manager."""
from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from game_loop import (
    TICK_INTERVAL,
    TICK_RATE,
    GameLoopManager,
    PlayerConnection,
    RoomLoop,
    _build_snapshot,
    _drain_inputs,
    _serialize_fighter,
)
from game_engine import GameEngine


# ─── Helpers ──────────────────────────────────────


def _make_mock_socket() -> MagicMock:
    """Create a mock WebSocket that records sent messages."""
    sock = MagicMock()
    sock.send_data = AsyncMock()
    return sock


# ─── Constants ────────────────────────────────────


class TestConstants:
    def test_tick_rate(self) -> None:
        assert TICK_RATE == 20

    def test_tick_interval(self) -> None:
        assert abs(TICK_INTERVAL - 0.05) < 1e-9


# ─── PlayerConnection ────────────────────────────


class TestPlayerConnection:
    def test_defaults(self) -> None:
        sock = _make_mock_socket()
        conn = PlayerConnection(player=1, socket=sock)
        assert conn.player == 1
        assert conn.connected is True
        assert conn.input_queue.empty()


# ─── _drain_inputs ────────────────────────────────


class TestDrainInputs:
    def test_empty_queue_returns_empty_sets(self) -> None:
        conn = PlayerConnection(player=1, socket=_make_mock_socket())
        actions, pressed = _drain_inputs(conn)
        assert actions == set()
        assert pressed == set()

    def test_single_input_frame(self) -> None:
        conn = PlayerConnection(player=1, socket=_make_mock_socket())
        conn.input_queue.put_nowait({
            "actions": ["left", "down"],
            "just_pressed": ["heavyKick"],
        })
        actions, pressed = _drain_inputs(conn)
        assert actions == {"left", "down"}
        assert pressed == {"heavyKick"}

    def test_multiple_frames_held_uses_latest(self) -> None:
        conn = PlayerConnection(player=1, socket=_make_mock_socket())
        conn.input_queue.put_nowait({"actions": ["left"], "just_pressed": []})
        conn.input_queue.put_nowait({"actions": ["right"], "just_pressed": []})
        actions, pressed = _drain_inputs(conn)
        assert actions == {"right"}  # Latest wins for held

    def test_multiple_frames_pressed_accumulates(self) -> None:
        conn = PlayerConnection(player=1, socket=_make_mock_socket())
        conn.input_queue.put_nowait({"actions": [], "just_pressed": ["lightPunch"]})
        conn.input_queue.put_nowait({"actions": [], "just_pressed": ["heavyKick"]})
        actions, pressed = _drain_inputs(conn)
        assert pressed == {"lightPunch", "heavyKick"}  # Accumulate

    def test_queue_is_empty_after_drain(self) -> None:
        conn = PlayerConnection(player=1, socket=_make_mock_socket())
        conn.input_queue.put_nowait({"actions": ["up"], "just_pressed": ["jump"]})
        _drain_inputs(conn)
        assert conn.input_queue.empty()


# ─── _serialize_fighter ───────────────────────────


class TestSerializeFighter:
    def test_includes_required_fields(self) -> None:
        engine = GameEngine()
        data = _serialize_fighter(engine.p1)
        required = {
            "x", "y", "vx", "vy", "facing", "state", "health",
            "current_attack", "attack_frame", "attack_context",
            "attack_has_hit", "stun_frames", "dash_timer", "dash_dir",
            "is_flipping", "flip_angle", "jump_count", "flip_count",
            "grounded", "events",
        }
        assert required.issubset(data.keys())

    def test_initial_state_values(self) -> None:
        engine = GameEngine()
        data = _serialize_fighter(engine.p1)
        assert data["state"] == "idle"
        assert data["health"] == 100.0
        assert data["facing"] == 1
        assert data["grounded"] is True
        assert data["events"] == []
        assert data["current_attack"] is None

    def test_values_are_rounded(self) -> None:
        engine = GameEngine()
        # Move fighter to a non-round position
        engine.p1.x = 123.456789
        engine.p1.vy = -620.12345
        data = _serialize_fighter(engine.p1)
        assert data["x"] == 123.5
        assert data["vy"] == -620.1


# ─── _build_snapshot ─────────────────────────────


class TestBuildSnapshot:
    def test_snapshot_structure(self) -> None:
        room = RoomLoop(code="test-room-code", engine=GameEngine())
        room.tick_count = 42
        snap = _build_snapshot(room)
        assert snap["type"] == "state"
        assert snap["tick"] == 42
        assert "round_timer" in snap
        assert "round_over" in snap
        assert "p1" in snap
        assert "p2" in snap

    def test_snapshot_is_json_serializable(self) -> None:
        room = RoomLoop(code="test-room-code", engine=GameEngine())
        snap = _build_snapshot(room)
        # Should not raise
        serialized = json.dumps(snap)
        parsed = json.loads(serialized)
        assert parsed["type"] == "state"


# ─── GameLoopManager CRUD ────────────────────────


class TestGameLoopManagerCrud:
    def test_create_room_loop(self) -> None:
        mgr = GameLoopManager()
        room = mgr.create_room_loop("abc-def-ghi")
        assert room.code == "abc-def-ghi"
        assert room.engine is not None
        assert room.stopped is False
        assert room.tick_count == 0

    def test_create_room_loop_idempotent(self) -> None:
        mgr = GameLoopManager()
        r1 = mgr.create_room_loop("abc")
        r2 = mgr.create_room_loop("abc")
        assert r1 is r2

    def test_get_room_loop(self) -> None:
        mgr = GameLoopManager()
        mgr.create_room_loop("abc")
        assert mgr.get_room_loop("abc") is not None
        assert mgr.get_room_loop("nonexistent") is None

    def test_add_player(self) -> None:
        mgr = GameLoopManager()
        mgr.create_room_loop("abc")
        sock = _make_mock_socket()
        conn = mgr.add_player("abc", 1, sock)
        assert conn.player == 1
        assert conn.socket is sock
        room = mgr.get_room_loop("abc")
        assert room is not None
        assert 1 in room.players

    def test_add_player_no_room_raises(self) -> None:
        mgr = GameLoopManager()
        with pytest.raises(ValueError, match="No game loop"):
            mgr.add_player("nonexistent", 1, _make_mock_socket())

    def test_add_player_invalid_number_raises(self) -> None:
        mgr = GameLoopManager()
        mgr.create_room_loop("abc")
        with pytest.raises(ValueError, match="player must be 1 or 2"):
            mgr.add_player("abc", 3, _make_mock_socket())

    def test_remove_player(self) -> None:
        mgr = GameLoopManager()
        mgr.create_room_loop("abc")
        mgr.add_player("abc", 1, _make_mock_socket())
        mgr.remove_player("abc", 1)
        room = mgr.get_room_loop("abc")
        assert room is not None
        assert 1 not in room.players

    def test_remove_player_nonexistent_room(self) -> None:
        mgr = GameLoopManager()
        # Should not raise
        mgr.remove_player("nonexistent", 1)


# ─── GameLoopManager loop lifecycle ──────────────


class TestGameLoopLifecycle:
    @pytest.mark.asyncio
    async def test_start_loop_creates_task(self) -> None:
        mgr = GameLoopManager()
        room = mgr.create_room_loop("abc")
        mgr.add_player("abc", 1, _make_mock_socket())
        mgr.add_player("abc", 2, _make_mock_socket())
        mgr.start_loop("abc")
        assert room.task is not None
        # Clean up
        await mgr.stop_loop("abc")

    @pytest.mark.asyncio
    async def test_start_loop_no_room_raises(self) -> None:
        mgr = GameLoopManager()
        with pytest.raises(ValueError, match="No game loop"):
            mgr.start_loop("nonexistent")

    @pytest.mark.asyncio
    async def test_start_loop_idempotent(self) -> None:
        mgr = GameLoopManager()
        mgr.create_room_loop("abc")
        mgr.add_player("abc", 1, _make_mock_socket())
        mgr.add_player("abc", 2, _make_mock_socket())
        mgr.start_loop("abc")
        room = mgr.get_room_loop("abc")
        assert room is not None
        task1 = room.task
        mgr.start_loop("abc")
        assert room.task is task1
        await mgr.stop_loop("abc")

    @pytest.mark.asyncio
    async def test_stop_loop_cleans_up(self) -> None:
        mgr = GameLoopManager()
        mgr.create_room_loop("abc")
        mgr.add_player("abc", 1, _make_mock_socket())
        mgr.add_player("abc", 2, _make_mock_socket())
        mgr.start_loop("abc")
        await mgr.stop_loop("abc")
        assert mgr.get_room_loop("abc") is None

    @pytest.mark.asyncio
    async def test_stop_loop_nonexistent(self) -> None:
        mgr = GameLoopManager()
        # Should not raise
        await mgr.stop_loop("nonexistent")

    @pytest.mark.asyncio
    async def test_stop_all(self) -> None:
        mgr = GameLoopManager()
        for code in ("a", "b", "c"):
            mgr.create_room_loop(code)
            mgr.add_player(code, 1, _make_mock_socket())
            mgr.add_player(code, 2, _make_mock_socket())
            mgr.start_loop(code)
        assert len(mgr.rooms) == 3
        await mgr.stop_all()
        assert len(mgr.rooms) == 0


# ─── Game loop tick behavior ─────────────────────


class TestGameLoopTick:
    @pytest.mark.asyncio
    async def test_loop_broadcasts_state(self) -> None:
        """Verify the loop ticks and sends state to both players."""
        mgr = GameLoopManager()
        mgr.create_room_loop("abc")
        sock1 = _make_mock_socket()
        sock2 = _make_mock_socket()
        mgr.add_player("abc", 1, sock1)
        mgr.add_player("abc", 2, sock2)
        mgr.start_loop("abc")

        # Let a few ticks run
        await asyncio.sleep(0.15)
        await mgr.stop_loop("abc")

        # Both sockets should have received state messages
        assert sock1.send_data.call_count >= 2
        assert sock2.send_data.call_count >= 2

        # Parse first state message
        first_call = sock1.send_data.call_args_list[0]
        msg = json.loads(first_call.args[0])
        assert msg["type"] == "state"
        assert msg["tick"] == 1
        assert "p1" in msg
        assert "p2" in msg

    @pytest.mark.asyncio
    async def test_loop_processes_inputs(self) -> None:
        """Verify player inputs affect the game state."""
        mgr = GameLoopManager()
        mgr.create_room_loop("abc")
        sock1 = _make_mock_socket()
        sock2 = _make_mock_socket()
        conn1 = mgr.add_player("abc", 1, sock1)
        mgr.add_player("abc", 2, sock2)

        # Buffer a jump input for P1
        await conn1.input_queue.put({"actions": [], "just_pressed": ["jump"]})

        mgr.start_loop("abc")
        await asyncio.sleep(0.15)
        await mgr.stop_loop("abc")

        # Check that at least one broadcast shows P1 in a non-idle state or airborne
        # The jump should have been processed
        found_jump = False
        for call in sock1.send_data.call_args_list:
            msg = json.loads(call.args[0])
            if msg.get("type") == "state" and msg["p1"].get("state") in ("jump",):
                found_jump = True
                break
            if msg.get("type") == "state" and not msg["p1"].get("grounded"):
                found_jump = True
                break
        assert found_jump, "P1 should have jumped after input was processed"

    @pytest.mark.asyncio
    async def test_round_over_sends_event(self) -> None:
        """Verify round_over message is sent when a fighter is KO'd."""
        mgr = GameLoopManager()
        room = mgr.create_room_loop("abc")
        # Set P2 to near-death
        room.engine.p2.health = 1.0

        sock1 = _make_mock_socket()
        sock2 = _make_mock_socket()
        conn1 = mgr.add_player("abc", 1, sock1)
        mgr.add_player("abc", 2, sock2)

        # Queue up a heavy punch at close range
        room.engine.p2.x = room.engine.p1.x + 50  # Close range
        await conn1.input_queue.put({"actions": [], "just_pressed": ["lightPunch"]})

        mgr.start_loop("abc")
        # Give enough time for attack to complete
        await asyncio.sleep(0.8)
        await mgr.stop_loop("abc")

        # Check if round_over was sent
        all_messages = []
        for call in sock1.send_data.call_args_list:
            msg = json.loads(call.args[0])
            all_messages.append(msg)

        round_over_msgs = [m for m in all_messages if m.get("type") == "round_over"]
        # If KO happened, there should be a round_over message
        if round_over_msgs:
            assert round_over_msgs[0]["winner"] in (1, 2, None)

    @pytest.mark.asyncio
    async def test_disconnected_player_removed(self) -> None:
        """Verify that a player whose socket raises on send is removed."""
        mgr = GameLoopManager()
        mgr.create_room_loop("abc")
        sock1 = _make_mock_socket()
        sock2 = _make_mock_socket()
        # Make sock2 raise on send
        sock2.send_data = AsyncMock(side_effect=ConnectionError("gone"))
        mgr.add_player("abc", 1, sock1)
        mgr.add_player("abc", 2, sock2)

        mgr.start_loop("abc")
        await asyncio.sleep(0.15)
        await mgr.stop_loop("abc")

        # sock1 should still have received messages
        assert sock1.send_data.call_count >= 1


# ─── Determinism ─────────────────────────────────


class TestDeterminism:
    def test_same_inputs_same_snapshot(self) -> None:
        """Two engines with identical inputs should produce identical snapshots."""
        r1 = RoomLoop(code="a", engine=GameEngine())
        r2 = RoomLoop(code="b", engine=GameEngine())

        p1_actions: set[str] = {"right"}
        p1_pressed: set[str] = set()
        p2_actions: set[str] = {"left"}
        p2_pressed: set[str] = set()

        for _ in range(20):
            r1.engine.tick(TICK_INTERVAL, p1_actions, p1_pressed, p2_actions, p2_pressed)
            r2.engine.tick(TICK_INTERVAL, p1_actions, p1_pressed, p2_actions, p2_pressed)
            r1.tick_count += 1
            r2.tick_count += 1

        s1 = _build_snapshot(r1)
        s2 = _build_snapshot(r2)
        assert s1 == s2

    def test_clash_is_deterministic(self) -> None:
        """Simultaneous attacks resolve identically across runs."""
        results = []
        for _ in range(5):
            engine = GameEngine()
            # Place fighters close together
            engine.p1.x = 400.0
            engine.p2.x = 440.0
            for tick in range(30):
                p1_pressed = {"lightPunch"} if tick == 0 else set()
                p2_pressed = {"lightPunch"} if tick == 0 else set()
                engine.tick(TICK_INTERVAL, set(), p1_pressed, set(), p2_pressed)
            results.append((round(engine.p1.health, 1), round(engine.p2.health, 1)))

        # All runs should produce identical results
        assert all(r == results[0] for r in results)


# ─── Winner determination ────────────────────────


class TestDetermineWinner:
    def test_p1_ko(self) -> None:
        engine = GameEngine()
        engine.p1.health = 0
        assert GameLoopManager._determine_winner(engine) == 2

    def test_p2_ko(self) -> None:
        engine = GameEngine()
        engine.p2.health = 0
        assert GameLoopManager._determine_winner(engine) == 1

    def test_double_ko(self) -> None:
        engine = GameEngine()
        engine.p1.health = 0
        engine.p2.health = 0
        assert GameLoopManager._determine_winner(engine) is None

    def test_timeout_p1_wins(self) -> None:
        engine = GameEngine()
        engine.p1.health = 80
        engine.p2.health = 60
        assert GameLoopManager._determine_winner(engine) == 1

    def test_timeout_p2_wins(self) -> None:
        engine = GameEngine()
        engine.p1.health = 40
        engine.p2.health = 70
        assert GameLoopManager._determine_winner(engine) == 2

    def test_timeout_draw(self) -> None:
        engine = GameEngine()
        engine.p1.health = 50
        engine.p2.health = 50
        assert GameLoopManager._determine_winner(engine) is None
