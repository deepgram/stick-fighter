from __future__ import annotations

import json
import time

import fakeredis
import fakeredis.aioredis
import pytest
from litestar.testing import TestClient

import server
from elo import EloManager
from room_manager import RoomManager
from server import app


@pytest.fixture()
def room_client():
    """TestClient with fakeredis-backed RoomManager injected after lifespan."""
    with TestClient(app=app) as client:
        redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
        manager = RoomManager(redis)
        server.room_manager = manager
        yield client
        server.room_manager = None


@pytest.fixture()
def room_client_with_sync():
    """TestClient + sync FakeRedis for pre-populating room data in tests.

    Returns (client, sync_redis) — sync_redis shares the same server as the
    async FakeRedis used by the room manager, so data set via sync is visible
    to the async manager.
    """
    fake_server = fakeredis.FakeServer()
    with TestClient(app=app) as client:
        async_redis = fakeredis.aioredis.FakeRedis(
            decode_responses=True, server=fake_server
        )
        sync_redis = fakeredis.FakeRedis(
            decode_responses=True, server=fake_server
        )
        manager = RoomManager(async_redis)
        server.room_manager = manager
        yield client, sync_redis
        server.room_manager = None


def test_health() -> None:
    with TestClient(app=app) as client:
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"


def test_index_returns_html() -> None:
    with TestClient(app=app) as client:
        resp = client.get("/")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]
        assert "STICK FIGHTER" in resp.text


def test_room_route_returns_html() -> None:
    with TestClient(app=app) as client:
        resp = client.get("/room/red-tiger-paw")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]
        assert "STICK FIGHTER" in resp.text


def test_room_route_single_word() -> None:
    with TestClient(app=app) as client:
        resp = client.get("/room/test")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]


# ─── Room creation endpoint ───────────────────────


class TestRoomCreate:
    def test_create_returns_room_code(self, room_client) -> None:
        resp = room_client.post("/api/room/create")
        assert resp.status_code == 201
        data = resp.json()
        assert "code" in data
        parts = data["code"].split("-")
        assert len(parts) == 3, f"Expected 3-word code, got: {data['code']}"

    def test_create_returns_player_id(self, room_client) -> None:
        resp = room_client.post("/api/room/create")
        data = resp.json()
        assert "playerId" in data
        assert len(data["playerId"]) > 0

    def test_create_returns_shareable_url(self, room_client) -> None:
        resp = room_client.post("/api/room/create")
        data = resp.json()
        assert "url" in data
        assert f"/room/{data['code']}" in data["url"]

    def test_create_assigns_player_as_p1(self, room_client) -> None:
        """Creator gets a playerId (P1 assignment verified in room_manager tests)."""
        resp = room_client.post("/api/room/create")
        data = resp.json()
        assert resp.status_code == 201
        # Player ID is a UUID
        assert len(data["playerId"]) == 36
        assert data["playerId"].count("-") == 4

    def test_create_unique_codes(self, room_client) -> None:
        codes = set()
        for _ in range(10):
            resp = room_client.post("/api/room/create")
            data = resp.json()
            codes.add(data["code"])
        # All 10 should be unique
        assert len(codes) == 10

    def test_create_without_room_manager_returns_503(self) -> None:
        with TestClient(app=app) as client:
            server.room_manager = None
            resp = client.post("/api/room/create")
            assert resp.status_code == 503


# ─── Room join endpoint ──────────────────────────


def _create_waiting_room(sync_redis, code: str = "red-tiger-paw", p1_id: str = "p1-uuid") -> None:
    """Pre-populate a room in Redis using the sync client."""
    key = f"room:{code}"
    sync_redis.hset(key, mapping={
        "code": code,
        "p1_id": p1_id,
        "p2_id": "",
        "p1_controller": "",
        "p2_controller": "",
        "status": "waiting",
        "created_at": str(int(time.time())),
    })
    sync_redis.expire(key, 300)


class TestRoomJoin:
    def test_join_returns_player_info(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_waiting_room(sync_redis, "red-tiger-paw")
        resp = client.post(
            "/api/room/join",
            content=json.dumps({"code": "red-tiger-paw"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["code"] == "red-tiger-paw"
        assert data["playerNum"] == "2"
        assert len(data["playerId"]) == 36  # UUID

    def test_join_assigns_p2_in_redis(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_waiting_room(sync_redis, "red-tiger-paw")
        resp = client.post(
            "/api/room/join",
            content=json.dumps({"code": "red-tiger-paw"}),
            headers={"Content-Type": "application/json"},
        )
        data = resp.json()
        # Verify P2 was actually stored in Redis
        p2_id = sync_redis.hget("room:red-tiger-paw", "p2_id")
        assert p2_id == data["playerId"]

    def test_join_nonexistent_room_returns_404(self, room_client_with_sync) -> None:
        client, _ = room_client_with_sync
        resp = client.post(
            "/api/room/join",
            content=json.dumps({"code": "no-such-room"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 404

    def test_join_full_room_returns_409(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_waiting_room(sync_redis, "full-room-test")
        # Fill the room by setting p2_id
        sync_redis.hset("room:full-room-test", "p2_id", "existing-p2")
        resp = client.post(
            "/api/room/join",
            content=json.dumps({"code": "full-room-test"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 409

    def test_join_empty_code_returns_400(self, room_client_with_sync) -> None:
        client, _ = room_client_with_sync
        resp = client.post(
            "/api/room/join",
            content=json.dumps({"code": ""}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 400

    def test_join_missing_code_returns_400(self, room_client_with_sync) -> None:
        client, _ = room_client_with_sync
        resp = client.post(
            "/api/room/join",
            content=json.dumps({}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 400

    def test_join_without_room_manager_returns_503(self) -> None:
        with TestClient(app=app) as client:
            server.room_manager = None
            resp = client.post(
                "/api/room/join",
                content=json.dumps({"code": "any-code-here"}),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 503

    def test_join_normalizes_code_case(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_waiting_room(sync_redis, "red-tiger-paw")
        resp = client.post(
            "/api/room/join",
            content=json.dumps({"code": "RED-TIGER-PAW"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 201
        assert resp.json()["code"] == "red-tiger-paw"

    def test_join_transitions_to_selecting(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_waiting_room(sync_redis, "red-tiger-paw")
        client.post(
            "/api/room/join",
            content=json.dumps({"code": "red-tiger-paw"}),
            headers={"Content-Type": "application/json"},
        )
        status = sync_redis.hget("room:red-tiger-paw", "status")
        assert status == "selecting"


# ─── Room status endpoint ────────────────────────


def _create_selecting_room(
    sync_redis,
    code: str = "red-tiger-paw",
    p1_id: str = "p1-uuid",
    p2_id: str = "p2-uuid",
) -> None:
    """Pre-populate a room in 'selecting' status."""
    key = f"room:{code}"
    sync_redis.hset(key, mapping={
        "code": code,
        "p1_id": p1_id,
        "p2_id": p2_id,
        "p1_controller": "",
        "p2_controller": "",
        "status": "selecting",
        "created_at": str(int(time.time())),
    })
    sync_redis.expire(key, 300)


class TestRoomStatus:
    def test_status_returns_room_data(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_selecting_room(sync_redis, "red-tiger-paw")
        resp = client.get("/api/room/status?code=red-tiger-paw")
        assert resp.status_code == 200
        data = resp.json()
        assert data["code"] == "red-tiger-paw"
        assert data["status"] == "selecting"
        assert data["p1Ready"] is False
        assert data["p2Ready"] is False

    def test_status_shows_controllers(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_selecting_room(sync_redis, "red-tiger-paw")
        sync_redis.hset("room:red-tiger-paw", "p1_controller", "keyboard")
        resp = client.get("/api/room/status?code=red-tiger-paw")
        data = resp.json()
        assert data["p1Controller"] == "keyboard"
        assert data["p1Ready"] is True
        assert data["p2Ready"] is False

    def test_status_nonexistent_room_returns_404(self, room_client_with_sync) -> None:
        client, _ = room_client_with_sync
        resp = client.get("/api/room/status?code=nope-nope-nope")
        assert resp.status_code == 404

    def test_status_without_room_manager_returns_503(self) -> None:
        with TestClient(app=app) as client:
            server.room_manager = None
            resp = client.get("/api/room/status?code=any")
            assert resp.status_code == 503


# ─── Room controller endpoint ────────────────────


class TestRoomController:
    def test_set_controller_p1(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_selecting_room(sync_redis, "red-tiger-paw", p1_id="p1-uuid")
        resp = client.post(
            "/api/room/controller",
            content=json.dumps({"code": "red-tiger-paw", "playerId": "p1-uuid", "controller": "controller"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["p1Controller"] == "controller"
        assert data["bothReady"] is False
        # Verify in Redis
        assert sync_redis.hget("room:red-tiger-paw", "p1_controller") == "controller"

    def test_set_controller_p2(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_selecting_room(sync_redis, "red-tiger-paw", p2_id="p2-uuid")
        resp = client.post(
            "/api/room/controller",
            content=json.dumps({"code": "red-tiger-paw", "playerId": "p2-uuid", "controller": "voice"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["p2Controller"] == "voice"

    def test_both_controllers_transitions_to_fighting(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_selecting_room(sync_redis, "red-tiger-paw", p1_id="p1-uuid", p2_id="p2-uuid")
        # P1 selects
        client.post(
            "/api/room/controller",
            content=json.dumps({"code": "red-tiger-paw", "playerId": "p1-uuid", "controller": "controller"}),
            headers={"Content-Type": "application/json"},
        )
        # P2 selects
        resp = client.post(
            "/api/room/controller",
            content=json.dumps({"code": "red-tiger-paw", "playerId": "p2-uuid", "controller": "voice"}),
            headers={"Content-Type": "application/json"},
        )
        data = resp.json()
        assert data["bothReady"] is True
        assert data["status"] == "fighting"
        # Verify Redis status
        assert sync_redis.hget("room:red-tiger-paw", "status") == "fighting"

    def test_invalid_controller_returns_400(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_selecting_room(sync_redis, "red-tiger-paw", p1_id="p1-uuid")
        resp = client.post(
            "/api/room/controller",
            content=json.dumps({"code": "red-tiger-paw", "playerId": "p1-uuid", "controller": "telepathy"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 400

    def test_missing_fields_returns_400(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_selecting_room(sync_redis, "red-tiger-paw")
        resp = client.post(
            "/api/room/controller",
            content=json.dumps({"code": "red-tiger-paw"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 400

    def test_nonexistent_room_returns_404(self, room_client_with_sync) -> None:
        client, _ = room_client_with_sync
        resp = client.post(
            "/api/room/controller",
            content=json.dumps({"code": "nope", "playerId": "x", "controller": "controller"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 404

    def test_wrong_player_returns_403(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_selecting_room(sync_redis, "red-tiger-paw", p1_id="p1-uuid", p2_id="p2-uuid")
        resp = client.post(
            "/api/room/controller",
            content=json.dumps({"code": "red-tiger-paw", "playerId": "intruder", "controller": "controller"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 403

    def test_without_room_manager_returns_503(self) -> None:
        with TestClient(app=app) as client:
            server.room_manager = None
            resp = client.post(
                "/api/room/controller",
                content=json.dumps({"code": "a", "playerId": "b", "controller": "controller"}),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 503

    def test_all_valid_controllers_accepted(self, room_client_with_sync) -> None:
        """Every INPUT_MODES id should be accepted."""
        client, sync_redis = room_client_with_sync
        for ctrl in ("controller", "voice", "phone", "simulated", "llm"):
            _create_selecting_room(sync_redis, f"room-{ctrl}", p1_id="p1-uuid")
            resp = client.post(
                "/api/room/controller",
                content=json.dumps({"code": f"room-{ctrl}", "playerId": "p1-uuid", "controller": ctrl}),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 201, f"Controller '{ctrl}' rejected"


# ─── Room rematch endpoint ─────────────────────


def _create_fighting_room(
    sync_redis,
    code: str = "red-tiger-paw",
    p1_id: str = "p1-uuid",
    p2_id: str = "p2-uuid",
    p1_ctrl: str = "controller",
    p2_ctrl: str = "voice",
) -> None:
    """Pre-populate a room in 'fighting' status."""
    key = f"room:{code}"
    sync_redis.hset(key, mapping={
        "code": code,
        "p1_id": p1_id,
        "p2_id": p2_id,
        "p1_controller": p1_ctrl,
        "p2_controller": p2_ctrl,
        "status": "fighting",
        "created_at": str(int(time.time())),
    })
    sync_redis.expire(key, 300)


class TestRoomRematch:
    def test_rematch_resets_room(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_fighting_room(sync_redis, "red-tiger-paw")
        resp = client.post(
            "/api/room/rematch",
            content=json.dumps({"code": "red-tiger-paw", "playerId": "p1-uuid"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["status"] == "selecting"
        # Verify controllers were cleared in Redis
        assert sync_redis.hget("room:red-tiger-paw", "p1_controller") == ""
        assert sync_redis.hget("room:red-tiger-paw", "p2_controller") == ""

    def test_rematch_p2_can_request(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_fighting_room(sync_redis, "red-tiger-paw")
        resp = client.post(
            "/api/room/rematch",
            content=json.dumps({"code": "red-tiger-paw", "playerId": "p2-uuid"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 201

    def test_rematch_wrong_player_returns_403(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_fighting_room(sync_redis, "red-tiger-paw")
        resp = client.post(
            "/api/room/rematch",
            content=json.dumps({"code": "red-tiger-paw", "playerId": "intruder"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 403

    def test_rematch_nonexistent_room_returns_404(self, room_client_with_sync) -> None:
        client, _ = room_client_with_sync
        resp = client.post(
            "/api/room/rematch",
            content=json.dumps({"code": "nope", "playerId": "p1-uuid"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 404

    def test_rematch_missing_fields_returns_400(self, room_client_with_sync) -> None:
        client, _ = room_client_with_sync
        resp = client.post(
            "/api/room/rematch",
            content=json.dumps({"code": ""}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 400

    def test_rematch_from_waiting_returns_400(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_waiting_room(sync_redis, "red-tiger-paw")
        resp = client.post(
            "/api/room/rematch",
            content=json.dumps({"code": "red-tiger-paw", "playerId": "p1-uuid"}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 400

    def test_rematch_without_room_manager_returns_503(self) -> None:
        with TestClient(app=app) as client:
            server.room_manager = None
            resp = client.post(
                "/api/room/rematch",
                content=json.dumps({"code": "a", "playerId": "b"}),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 503


# ─── Match complete endpoint ────────────────────


class TestMatchComplete:
    def test_complete_transitions_to_finished(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_fighting_room(sync_redis, "red-tiger-paw")
        resp = client.post(
            "/api/match/complete",
            content=json.dumps({
                "code": "red-tiger-paw",
                "playerId": "p1-uuid",
                "winner": 1,
                "p1Health": 80.0,
                "p2Health": 0.0,
            }),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["ok"] is True
        assert data["winner"] == 1
        # Room should be "finished" in Redis
        assert sync_redis.hget("room:red-tiger-paw", "status") == "finished"

    def test_complete_without_elo_returns_not_updated(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_fighting_room(sync_redis, "red-tiger-paw")
        resp = client.post(
            "/api/match/complete",
            content=json.dumps({
                "code": "red-tiger-paw",
                "playerId": "p1-uuid",
                "winner": 2,
            }),
            headers={"Content-Type": "application/json"},
        )
        data = resp.json()
        assert data["elo"]["updated"] is False

    def test_complete_with_elo_updates_ratings(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_fighting_room(sync_redis, "red-tiger-paw", p1_ctrl="controller", p2_ctrl="controller")
        # Inject EloManager
        async_redis = fakeredis.aioredis.FakeRedis(
            decode_responses=True, server=sync_redis.connection_pool.connection_kwargs.get("server")
        )
        elo = EloManager(async_redis)
        server.elo_manager = elo

        resp = client.post(
            "/api/match/complete",
            content=json.dumps({
                "code": "red-tiger-paw",
                "playerId": "p1-uuid",
                "winner": 1,
                "p1UserId": "user-aaa",
                "p2UserId": "user-bbb",
                "p1Name": "Alice",
                "p2Name": "Bob",
            }),
            headers={"Content-Type": "application/json"},
        )
        data = resp.json()
        assert data["elo"]["updated"] is True
        assert data["elo"]["category"] == "keyboard"
        assert data["elo"]["p1"]["wins"] == 1
        assert data["elo"]["p2"]["losses"] == 1

    def test_complete_nonexistent_room_returns_404(self, room_client_with_sync) -> None:
        client, _ = room_client_with_sync
        resp = client.post(
            "/api/match/complete",
            content=json.dumps({"code": "nope", "playerId": "p1-uuid", "winner": 1}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 404

    def test_complete_wrong_player_returns_403(self, room_client_with_sync) -> None:
        client, sync_redis = room_client_with_sync
        _create_fighting_room(sync_redis, "red-tiger-paw")
        resp = client.post(
            "/api/match/complete",
            content=json.dumps({"code": "red-tiger-paw", "playerId": "intruder", "winner": 1}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 403

    def test_complete_missing_fields_returns_400(self, room_client_with_sync) -> None:
        client, _ = room_client_with_sync
        resp = client.post(
            "/api/match/complete",
            content=json.dumps({"code": ""}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 400

    def test_complete_idempotent_finished(self, room_client_with_sync) -> None:
        """Second call to complete on already-finished room doesn't fail."""
        client, sync_redis = room_client_with_sync
        key = "room:red-tiger-paw"
        sync_redis.hset(key, mapping={
            "code": "red-tiger-paw",
            "p1_id": "p1-uuid",
            "p2_id": "p2-uuid",
            "p1_controller": "controller",
            "p2_controller": "controller",
            "status": "finished",
            "created_at": str(int(time.time())),
        })
        sync_redis.expire(key, 300)

        resp = client.post(
            "/api/match/complete",
            content=json.dumps({"code": "red-tiger-paw", "playerId": "p1-uuid", "winner": 1}),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 201
        assert resp.json()["ok"] is True

    def test_complete_without_room_manager_returns_503(self) -> None:
        with TestClient(app=app) as client:
            server.room_manager = None
            resp = client.post(
                "/api/match/complete",
                content=json.dumps({"code": "a", "playerId": "b", "winner": 1}),
                headers={"Content-Type": "application/json"},
            )
            assert resp.status_code == 503
