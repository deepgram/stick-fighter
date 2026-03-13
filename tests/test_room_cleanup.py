"""Tests for room_cleanup.py — periodic room expiry detection and cleanup."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import fakeredis.aioredis
import pytest
import pytest_asyncio

from game_loop import GameLoopManager
from room_cleanup import CLEANUP_INTERVAL, RoomCleanupTask
from room_manager import RoomManager
from signaling import SignalingManager


# ─── Helpers ──────────────────────────────────────


def _make_mock_socket() -> MagicMock:
    """Create a mock WebSocket that records sent messages."""
    sock = MagicMock()
    sock.send_data = AsyncMock()
    return sock


# ─── Fixtures ─────────────────────────────────────


@pytest_asyncio.fixture
async def redis():
    r = fakeredis.aioredis.FakeRedis(decode_responses=True)
    yield r
    await r.aclose()


@pytest_asyncio.fixture
async def room_mgr(redis):
    return RoomManager(redis)


@pytest.fixture
def game_loop_mgr():
    return GameLoopManager()


@pytest.fixture
def signal_mgr():
    return SignalingManager()


@pytest.fixture
def cleanup(room_mgr, game_loop_mgr, signal_mgr):
    return RoomCleanupTask(room_mgr, game_loop_mgr, signal_mgr)


# ─── Constants ────────────────────────────────────


class TestConstants:
    def test_cleanup_interval(self) -> None:
        assert CLEANUP_INTERVAL == 30.0


# ─── Sweep: no stale rooms ──────────────────────


class TestSweepNoStaleRooms:
    @pytest.mark.asyncio
    async def test_sweep_empty_returns_nothing(self, cleanup: RoomCleanupTask) -> None:
        result = await cleanup.sweep()
        assert result == []

    @pytest.mark.asyncio
    async def test_sweep_with_active_room_returns_nothing(
        self, cleanup: RoomCleanupTask, room_mgr: RoomManager, game_loop_mgr: GameLoopManager
    ) -> None:
        room = await room_mgr.create_room("p1")
        game_loop_mgr.create_room_loop(room["code"])
        result = await cleanup.sweep()
        assert result == []

    @pytest.mark.asyncio
    async def test_sweep_with_active_signaling_returns_nothing(
        self, cleanup: RoomCleanupTask, room_mgr: RoomManager, signal_mgr: SignalingManager
    ) -> None:
        room = await room_mgr.create_room("p1")
        signal_mgr.connect(room["code"], 1)
        result = await cleanup.sweep()
        assert result == []


# ─── Sweep: expired rooms ───────────────────────


class TestSweepExpiredRooms:
    @pytest.mark.asyncio
    async def test_sweep_cleans_expired_game_loop(
        self, cleanup: RoomCleanupTask, room_mgr: RoomManager, game_loop_mgr: GameLoopManager
    ) -> None:
        """Game loop for a room that no longer exists in Redis gets cleaned up."""
        room = await room_mgr.create_room("p1")
        code = room["code"]
        game_loop_mgr.create_room_loop(code)

        # Simulate Redis expiry by deleting the room
        await room_mgr.delete_room(code)

        result = await cleanup.sweep()
        assert code in result
        assert game_loop_mgr.get_room_loop(code) is None

    @pytest.mark.asyncio
    async def test_sweep_cleans_expired_signaling(
        self, cleanup: RoomCleanupTask, room_mgr: RoomManager, signal_mgr: SignalingManager
    ) -> None:
        """Signaling session for an expired room gets cleaned up."""
        room = await room_mgr.create_room("p1")
        code = room["code"]
        signal_mgr.connect(code, 1)

        await room_mgr.delete_room(code)
        result = await cleanup.sweep()
        assert code in result
        assert signal_mgr.get_session(code, 1) is None

    @pytest.mark.asyncio
    async def test_sweep_cleans_both_game_loop_and_signaling(
        self, cleanup: RoomCleanupTask, room_mgr: RoomManager,
        game_loop_mgr: GameLoopManager, signal_mgr: SignalingManager
    ) -> None:
        room = await room_mgr.create_room("p1")
        code = room["code"]
        game_loop_mgr.create_room_loop(code)
        signal_mgr.connect(code, 1)
        signal_mgr.connect(code, 2)

        await room_mgr.delete_room(code)
        result = await cleanup.sweep()
        assert code in result
        assert game_loop_mgr.get_room_loop(code) is None
        assert signal_mgr.get_session(code, 1) is None
        assert signal_mgr.get_session(code, 2) is None

    @pytest.mark.asyncio
    async def test_sweep_only_cleans_expired_not_active(
        self, cleanup: RoomCleanupTask, room_mgr: RoomManager,
        game_loop_mgr: GameLoopManager
    ) -> None:
        """Active rooms survive the sweep; only expired ones are cleaned."""
        active_room = await room_mgr.create_room("p1")
        expired_room = await room_mgr.create_room("p2")
        game_loop_mgr.create_room_loop(active_room["code"])
        game_loop_mgr.create_room_loop(expired_room["code"])

        await room_mgr.delete_room(expired_room["code"])

        result = await cleanup.sweep()
        assert expired_room["code"] in result
        assert active_room["code"] not in result
        assert game_loop_mgr.get_room_loop(active_room["code"]) is not None


# ─── WebSocket notification on expiry ────────────


class TestExpiryNotification:
    @pytest.mark.asyncio
    async def test_sends_room_expired_to_connected_players(
        self, cleanup: RoomCleanupTask, room_mgr: RoomManager,
        game_loop_mgr: GameLoopManager
    ) -> None:
        room = await room_mgr.create_room("p1")
        code = room["code"]
        game_loop_mgr.create_room_loop(code)

        sock1 = _make_mock_socket()
        sock2 = _make_mock_socket()
        game_loop_mgr.add_player(code, 1, sock1)
        game_loop_mgr.add_player(code, 2, sock2)

        await room_mgr.delete_room(code)
        await cleanup.sweep()

        # Both players should have received room_expired message
        for sock in (sock1, sock2):
            sock.send_data.assert_called()
            sent_msg = json.loads(sock.send_data.call_args[0][0])
            assert sent_msg["type"] == "room_expired"
            assert sent_msg["code"] == code

    @pytest.mark.asyncio
    async def test_handles_send_error_gracefully(
        self, cleanup: RoomCleanupTask, room_mgr: RoomManager,
        game_loop_mgr: GameLoopManager
    ) -> None:
        """If sending room_expired fails, cleanup still proceeds."""
        room = await room_mgr.create_room("p1")
        code = room["code"]
        game_loop_mgr.create_room_loop(code)

        sock = _make_mock_socket()
        sock.send_data = AsyncMock(side_effect=Exception("connection lost"))
        game_loop_mgr.add_player(code, 1, sock)

        await room_mgr.delete_room(code)
        result = await cleanup.sweep()
        # Should still clean up despite send error
        assert code in result
        assert game_loop_mgr.get_room_loop(code) is None

    @pytest.mark.asyncio
    async def test_no_notification_if_no_players(
        self, cleanup: RoomCleanupTask, room_mgr: RoomManager,
        game_loop_mgr: GameLoopManager
    ) -> None:
        """Empty game loop (no connected players) cleans up without errors."""
        room = await room_mgr.create_room("p1")
        code = room["code"]
        game_loop_mgr.create_room_loop(code)

        await room_mgr.delete_room(code)
        result = await cleanup.sweep()
        assert code in result


# ─── Matchmaking queue cleanup ───────────────────


class TestMatchmakingCleanup:
    @pytest.mark.asyncio
    async def test_sweep_cleans_expired_matchmaking_entries(
        self, cleanup: RoomCleanupTask, room_mgr: RoomManager, redis
    ) -> None:
        """Queue entries whose TTL key expired are removed during sweep."""
        await room_mgr.matchmaking_join("keyboard", "player-1", 1000.0)
        await room_mgr.matchmaking_join("keyboard", "player-2", 1100.0)

        # Simulate TTL expiry for player-1 by deleting TTL key
        await redis.delete("matchmaking_ttl:keyboard:player-1")

        await cleanup.sweep()

        # player-1 should be removed from the sorted set
        score = await redis.zscore("matchmaking:keyboard", "player-1")
        assert score is None
        # player-2 should still be in queue
        score = await redis.zscore("matchmaking:keyboard", "player-2")
        assert score is not None


# ─── Start / Stop lifecycle ──────────────────────


class TestLifecycle:
    @pytest.mark.asyncio
    async def test_start_creates_task(self, cleanup: RoomCleanupTask) -> None:
        cleanup.start()
        assert cleanup._task is not None
        await cleanup.stop()

    @pytest.mark.asyncio
    async def test_stop_cancels_task(self, cleanup: RoomCleanupTask) -> None:
        cleanup.start()
        await cleanup.stop()
        assert cleanup._task is None

    @pytest.mark.asyncio
    async def test_double_start_is_idempotent(self, cleanup: RoomCleanupTask) -> None:
        cleanup.start()
        task1 = cleanup._task
        cleanup.start()
        assert cleanup._task is task1
        await cleanup.stop()

    @pytest.mark.asyncio
    async def test_stop_without_start_is_safe(self, cleanup: RoomCleanupTask) -> None:
        await cleanup.stop()  # Should not raise
