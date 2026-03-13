"""Tests for WebRTC signaling relay — signaling.py + server endpoints."""
from __future__ import annotations

import fakeredis
import fakeredis.aioredis
import pytest
from litestar.testing import TestClient

import server
from room_manager import RoomManager
from signaling import ICE_SERVERS, SignalingManager


# ─── Unit tests: SignalingManager ──────────────


class TestSignalingManagerConnect:
    def test_connect_creates_session(self) -> None:
        mgr = SignalingManager()
        session = mgr.connect("room1", 1)
        assert session.room_code == "room1"
        assert session.player == 1
        assert session.closed is False

    def test_connect_creates_room_entry(self) -> None:
        mgr = SignalingManager()
        mgr.connect("room1", 1)
        assert "room1" in mgr.sessions
        assert 1 in mgr.sessions["room1"]

    def test_connect_two_players(self) -> None:
        mgr = SignalingManager()
        s1 = mgr.connect("room1", 1)
        s2 = mgr.connect("room1", 2)
        assert s1 is not s2
        assert len(mgr.sessions["room1"]) == 2

    def test_reconnect_closes_old_session(self) -> None:
        mgr = SignalingManager()
        old = mgr.connect("room1", 1)
        new = mgr.connect("room1", 1)
        assert old.closed is True
        assert new.closed is False
        assert mgr.sessions["room1"][1] is new


class TestSignalingManagerDisconnect:
    def test_disconnect_removes_session(self) -> None:
        mgr = SignalingManager()
        mgr.connect("room1", 1)
        mgr.disconnect("room1", 1)
        assert "room1" not in mgr.sessions

    def test_disconnect_closes_session(self) -> None:
        mgr = SignalingManager()
        session = mgr.connect("room1", 1)
        mgr.disconnect("room1", 1)
        assert session.closed is True

    def test_disconnect_keeps_other_player(self) -> None:
        mgr = SignalingManager()
        mgr.connect("room1", 1)
        s2 = mgr.connect("room1", 2)
        mgr.disconnect("room1", 1)
        assert "room1" in mgr.sessions
        assert mgr.sessions["room1"][2] is s2

    def test_disconnect_nonexistent_room(self) -> None:
        mgr = SignalingManager()
        mgr.disconnect("nonexistent", 1)  # Should not raise

    def test_disconnect_nonexistent_player(self) -> None:
        mgr = SignalingManager()
        mgr.connect("room1", 1)
        mgr.disconnect("room1", 2)  # Should not raise
        assert 1 in mgr.sessions["room1"]


class TestSignalingManagerRelay:
    @pytest.mark.asyncio()
    async def test_relay_p1_to_p2(self) -> None:
        mgr = SignalingManager()
        mgr.connect("room1", 1)
        mgr.connect("room1", 2)
        signal = {"type": "offer", "sdp": "v=0..."}
        result = await mgr.relay("room1", 1, signal)
        assert result is True
        # P2 should receive it
        msg = mgr.sessions["room1"][2].queue.get_nowait()
        assert msg == signal

    @pytest.mark.asyncio()
    async def test_relay_p2_to_p1(self) -> None:
        mgr = SignalingManager()
        mgr.connect("room1", 1)
        mgr.connect("room1", 2)
        signal = {"type": "answer", "sdp": "v=0..."}
        result = await mgr.relay("room1", 2, signal)
        assert result is True
        msg = mgr.sessions["room1"][1].queue.get_nowait()
        assert msg == signal

    @pytest.mark.asyncio()
    async def test_relay_ice_candidate(self) -> None:
        mgr = SignalingManager()
        mgr.connect("room1", 1)
        mgr.connect("room1", 2)
        signal = {"type": "ice-candidate", "candidate": "candidate:123..."}
        result = await mgr.relay("room1", 1, signal)
        assert result is True

    @pytest.mark.asyncio()
    async def test_relay_no_recipient(self) -> None:
        mgr = SignalingManager()
        mgr.connect("room1", 1)
        # P2 not connected
        result = await mgr.relay("room1", 1, {"type": "offer"})
        assert result is False

    @pytest.mark.asyncio()
    async def test_relay_no_room(self) -> None:
        mgr = SignalingManager()
        result = await mgr.relay("nonexistent", 1, {"type": "offer"})
        assert result is False

    @pytest.mark.asyncio()
    async def test_relay_closed_recipient(self) -> None:
        mgr = SignalingManager()
        mgr.connect("room1", 1)
        s2 = mgr.connect("room1", 2)
        s2.closed = True
        result = await mgr.relay("room1", 1, {"type": "offer"})
        assert result is False

    @pytest.mark.asyncio()
    async def test_relay_multiple_signals(self) -> None:
        mgr = SignalingManager()
        mgr.connect("room1", 1)
        mgr.connect("room1", 2)
        for i in range(3):
            await mgr.relay("room1", 1, {"type": "ice-candidate", "idx": i})
        assert mgr.sessions["room1"][2].queue.qsize() == 3


class TestSignalingManagerGetSession:
    def test_get_existing_session(self) -> None:
        mgr = SignalingManager()
        session = mgr.connect("room1", 1)
        assert mgr.get_session("room1", 1) is session

    def test_get_nonexistent_returns_none(self) -> None:
        mgr = SignalingManager()
        assert mgr.get_session("room1", 1) is None

    def test_get_nonexistent_player_returns_none(self) -> None:
        mgr = SignalingManager()
        mgr.connect("room1", 1)
        assert mgr.get_session("room1", 2) is None


class TestSignalingManagerCleanup:
    def test_cleanup_room(self) -> None:
        mgr = SignalingManager()
        s1 = mgr.connect("room1", 1)
        s2 = mgr.connect("room1", 2)
        mgr.cleanup_room("room1")
        assert "room1" not in mgr.sessions
        assert s1.closed is True
        assert s2.closed is True

    def test_cleanup_nonexistent_room(self) -> None:
        mgr = SignalingManager()
        mgr.cleanup_room("nonexistent")  # Should not raise


# ─── Integration tests: server endpoints ───────


@pytest.fixture()
def signal_client():
    """TestClient with fakeredis-backed RoomManager + SignalingManager.

    Uses a shared FakeServer so sync redis can set up test data (e.g. joining
    a room as P2) without event loop conflicts.
    """
    fake_server = fakeredis.FakeServer()
    with TestClient(app=server.app) as client:
        async_redis = fakeredis.aioredis.FakeRedis(
            server=fake_server, decode_responses=True,
        )
        sync_redis = fakeredis.FakeRedis(
            server=fake_server, decode_responses=True,
        )
        server.room_manager = RoomManager(async_redis)
        server.signaling_manager = SignalingManager()
        # Attach sync redis for test helpers
        client._test_redis = sync_redis  # type: ignore[attr-defined]
        yield client
        server.room_manager = None
        server.signaling_manager = None


def _create_room_with_two_players(client: TestClient) -> tuple[str, str, str]:
    """Helper: create a room and join with a second player.

    Uses sync fakeredis to set p2_id directly (avoids event loop mismatch).
    Returns (room_code, p1_id, p2_id).
    """
    # Create room (P1) via HTTP
    resp = client.post("/api/room/create")
    data = resp.json()
    code = data["code"]
    p1_id = data["playerId"]

    # Join room (P2) — set p2_id directly via sync redis
    p2_id = "test-player-2-id"
    sync_redis = client._test_redis  # type: ignore[attr-defined]
    sync_redis.hset(f"room:{code}", "p2_id", p2_id)

    return code, p1_id, p2_id


class TestRtcConfig:
    def test_returns_ice_servers(self, signal_client: TestClient) -> None:
        resp = signal_client.get("/api/rtc/config")
        assert resp.status_code == 200
        data = resp.json()
        assert "iceServers" in data
        assert len(data["iceServers"]) >= 1

    def test_returns_fallback_strategy(self, signal_client: TestClient) -> None:
        resp = signal_client.get("/api/rtc/config")
        data = resp.json()
        assert data["fallback"] == "server-relay"

    def test_ice_servers_have_urls(self, signal_client: TestClient) -> None:
        resp = signal_client.get("/api/rtc/config")
        for srv in resp.json()["iceServers"]:
            assert "urls" in srv
            assert srv["urls"].startswith("stun:")


class TestSignalSend:
    def test_signal_requires_room(self, signal_client: TestClient) -> None:
        resp = signal_client.post("/api/room/signal", json={
            "playerId": "x",
            "signal": {"type": "offer"},
        })
        assert resp.status_code == 400

    def test_signal_requires_player_id(self, signal_client: TestClient) -> None:
        resp = signal_client.post("/api/room/signal", json={
            "room": "abc",
            "signal": {"type": "offer"},
        })
        assert resp.status_code == 400

    def test_signal_requires_signal_data(self, signal_client: TestClient) -> None:
        resp = signal_client.post("/api/room/signal", json={
            "room": "abc",
            "playerId": "x",
        })
        assert resp.status_code == 400

    def test_signal_room_not_found(self, signal_client: TestClient) -> None:
        resp = signal_client.post("/api/room/signal", json={
            "room": "nonexistent-room-code",
            "playerId": "x",
            "signal": {"type": "offer"},
        })
        assert resp.status_code == 404

    def test_signal_player_not_in_room(self, signal_client: TestClient) -> None:
        code, p1_id, p2_id = _create_room_with_two_players(signal_client)
        resp = signal_client.post("/api/room/signal", json={
            "room": code,
            "playerId": "wrong-player-id",
            "signal": {"type": "offer"},
        })
        assert resp.status_code == 403

    def test_signal_relayed_false_no_listener(self, signal_client: TestClient) -> None:
        """Signal sent but no SSE listener — relayed is False."""
        code, p1_id, p2_id = _create_room_with_two_players(signal_client)
        resp = signal_client.post("/api/room/signal", json={
            "room": code,
            "playerId": p1_id,
            "signal": {"type": "offer", "sdp": "v=0..."},
        })
        assert resp.status_code == 201
        assert resp.json()["relayed"] is False

    def test_signal_relayed_true_with_listener(self, signal_client: TestClient) -> None:
        """Signal relayed when the other player has an SSE session."""
        code, p1_id, p2_id = _create_room_with_two_players(signal_client)

        # Manually register P2's signal session
        assert server.signaling_manager is not None
        server.signaling_manager.connect(code, 2)

        resp = signal_client.post("/api/room/signal", json={
            "room": code,
            "playerId": p1_id,
            "signal": {"type": "offer", "sdp": "v=0..."},
        })
        assert resp.status_code == 201
        assert resp.json()["relayed"] is True

    def test_signal_p2_sends_answer(self, signal_client: TestClient) -> None:
        """P2 can send an answer back to P1."""
        code, p1_id, p2_id = _create_room_with_two_players(signal_client)

        assert server.signaling_manager is not None
        server.signaling_manager.connect(code, 1)

        resp = signal_client.post("/api/room/signal", json={
            "room": code,
            "playerId": p2_id,
            "signal": {"type": "answer", "sdp": "v=0..."},
        })
        assert resp.status_code == 201
        assert resp.json()["relayed"] is True

    def test_signal_ice_candidate(self, signal_client: TestClient) -> None:
        """ICE candidates can be relayed."""
        code, p1_id, p2_id = _create_room_with_two_players(signal_client)

        assert server.signaling_manager is not None
        server.signaling_manager.connect(code, 2)

        resp = signal_client.post("/api/room/signal", json={
            "room": code,
            "playerId": p1_id,
            "signal": {"type": "ice-candidate", "candidate": "candidate:123 ..."},
        })
        assert resp.status_code == 201
        assert resp.json()["relayed"] is True

    def test_signal_without_managers_returns_503(self) -> None:
        with TestClient(app=server.app) as client:
            server.room_manager = None
            server.signaling_manager = None
            resp = client.post("/api/room/signal", json={
                "room": "x",
                "playerId": "y",
                "signal": {"type": "offer"},
            })
            assert resp.status_code == 503


class TestIceServersConstant:
    def test_ice_servers_not_empty(self) -> None:
        assert len(ICE_SERVERS) >= 1

    def test_ice_servers_have_stun(self) -> None:
        stun_urls = [s["urls"] for s in ICE_SERVERS if str(s["urls"]).startswith("stun:")]
        assert len(stun_urls) >= 1
