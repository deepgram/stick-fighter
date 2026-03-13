from __future__ import annotations

from litestar.testing import TestClient

from server import app


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
