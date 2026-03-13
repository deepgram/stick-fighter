from __future__ import annotations

import fakeredis.aioredis
import pytest
from litestar.testing import TestClient

import server
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
