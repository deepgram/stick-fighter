"""Tests for the ELO rating system (elo.py + server endpoints)."""
from __future__ import annotations

import pytest
import pytest_asyncio
import fakeredis
import fakeredis.aioredis

from elo import (
    EloManager,
    calculate_elo_change,
    controller_to_category,
    DEFAULT_RATING,
    K_FACTOR_NEW,
    K_FACTOR_ESTABLISHED,
    _expected_score,
    _k_factor,
)


# ─────────────────────────────────────────────
# Pure function tests
# ─────────────────────────────────────────────


class TestExpectedScore:
    """Test the expected score calculation."""

    def test_equal_ratings(self) -> None:
        assert _expected_score(1000, 1000) == pytest.approx(0.5)

    def test_higher_rated_favored(self) -> None:
        score = _expected_score(1200, 1000)
        assert score > 0.5

    def test_lower_rated_unfavored(self) -> None:
        score = _expected_score(1000, 1200)
        assert score < 0.5

    def test_symmetric(self) -> None:
        a = _expected_score(1200, 1000)
        b = _expected_score(1000, 1200)
        assert a + b == pytest.approx(1.0)

    def test_large_gap(self) -> None:
        score = _expected_score(1400, 1000)
        assert score > 0.9


class TestKFactor:
    """Test K-factor selection."""

    def test_new_player(self) -> None:
        assert _k_factor(0) == K_FACTOR_NEW
        assert _k_factor(15) == K_FACTOR_NEW
        assert _k_factor(29) == K_FACTOR_NEW

    def test_established_player(self) -> None:
        assert _k_factor(30) == K_FACTOR_ESTABLISHED
        assert _k_factor(100) == K_FACTOR_ESTABLISHED


class TestCalculateEloChange:
    """Test the ELO calculation function."""

    def test_equal_ratings_winner_gains(self) -> None:
        new_a, new_b = calculate_elo_change(1000, 1000, 0, 0, 1.0)
        assert new_a > 1000
        assert new_b < 1000

    def test_equal_ratings_symmetric_win(self) -> None:
        new_a, new_b = calculate_elo_change(1000, 1000, 0, 0, 1.0)
        gain = new_a - 1000
        loss = 1000 - new_b
        assert gain == pytest.approx(loss)

    def test_equal_ratings_draw_no_change(self) -> None:
        new_a, new_b = calculate_elo_change(1000, 1000, 0, 0, 0.5)
        assert new_a == pytest.approx(1000, abs=0.1)
        assert new_b == pytest.approx(1000, abs=0.1)

    def test_upset_win_bigger_change(self) -> None:
        # Lower-rated player beats higher-rated
        new_a, _ = calculate_elo_change(1000, 1200, 0, 0, 1.0)
        normal_a, _ = calculate_elo_change(1200, 1000, 0, 0, 1.0)
        # Upset win gains more than expected win
        assert (new_a - 1000) > (normal_a - 1200)

    def test_k_factor_matters(self) -> None:
        # New player (K=32) has bigger swing than established (K=16)
        new_a, _ = calculate_elo_change(1000, 1000, 0, 0, 1.0)
        est_a, _ = calculate_elo_change(1000, 1000, 50, 50, 1.0)
        assert (new_a - 1000) > (est_a - 1000)

    def test_returns_rounded(self) -> None:
        new_a, new_b = calculate_elo_change(1000, 1000, 0, 0, 1.0)
        # Should be rounded to 1 decimal place
        assert new_a == round(new_a, 1)
        assert new_b == round(new_b, 1)


class TestControllerToCategory:
    """Test input mode to ELO category mapping."""

    def test_voice(self) -> None:
        assert controller_to_category("voice") == "voice"

    def test_phone(self) -> None:
        assert controller_to_category("phone") == "voice"

    def test_keyboard(self) -> None:
        assert controller_to_category("keyboard") == "keyboard"

    def test_simulated_not_ranked(self) -> None:
        assert controller_to_category("simulated") is None

    def test_llm_not_ranked(self) -> None:
        assert controller_to_category("llm") is None

    def test_unknown_not_ranked(self) -> None:
        assert controller_to_category("unknown") is None


# ─────────────────────────────────────────────
# EloManager async tests
# ─────────────────────────────────────────────


@pytest_asyncio.fixture
async def elo() -> EloManager:
    """Create an EloManager backed by fakeredis."""
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    return EloManager(redis)


class TestGetRating:
    """Test getting player ratings."""

    @pytest.mark.asyncio
    async def test_new_player_default(self, elo: EloManager) -> None:
        stats = await elo.get_rating("user-1", "keyboard")
        assert stats["rating"] == DEFAULT_RATING
        assert stats["wins"] == 0
        assert stats["losses"] == 0
        assert stats["draws"] == 0
        assert stats["matches"] == 0

    @pytest.mark.asyncio
    async def test_returns_user_and_category(self, elo: EloManager) -> None:
        stats = await elo.get_rating("user-1", "voice")
        assert stats["user_id"] == "user-1"
        assert stats["category"] == "voice"


class TestPlayerName:
    """Test player name storage."""

    @pytest.mark.asyncio
    async def test_set_and_get(self, elo: EloManager) -> None:
        await elo.set_player_name("user-1", "Alice")
        assert await elo.get_player_name("user-1") == "Alice"

    @pytest.mark.asyncio
    async def test_unknown_player_empty(self, elo: EloManager) -> None:
        assert await elo.get_player_name("unknown") == ""

    @pytest.mark.asyncio
    async def test_update_name(self, elo: EloManager) -> None:
        await elo.set_player_name("user-1", "Alice")
        await elo.set_player_name("user-1", "Bob")
        assert await elo.get_player_name("user-1") == "Bob"


class TestUpdateRatings:
    """Test rating updates after matches."""

    @pytest.mark.asyncio
    async def test_winner_gains_loser_loses(self, elo: EloManager) -> None:
        winner, loser = await elo.update_ratings("w", "l", "keyboard")
        assert float(winner["rating"]) > DEFAULT_RATING
        assert float(loser["rating"]) < DEFAULT_RATING

    @pytest.mark.asyncio
    async def test_win_updates_counts(self, elo: EloManager) -> None:
        winner, loser = await elo.update_ratings("w", "l", "keyboard")
        assert winner["wins"] == 1
        assert winner["losses"] == 0
        assert winner["matches"] == 1
        assert loser["wins"] == 0
        assert loser["losses"] == 1
        assert loser["matches"] == 1

    @pytest.mark.asyncio
    async def test_draw_updates_counts(self, elo: EloManager) -> None:
        a, b = await elo.update_ratings("a", "b", "keyboard", draw=True)
        assert a["draws"] == 1
        assert a["wins"] == 0
        assert a["losses"] == 0
        assert b["draws"] == 1
        assert b["wins"] == 0
        assert b["losses"] == 0

    @pytest.mark.asyncio
    async def test_draw_equal_ratings_no_change(self, elo: EloManager) -> None:
        a, b = await elo.update_ratings("a", "b", "keyboard", draw=True)
        assert float(a["rating"]) == pytest.approx(DEFAULT_RATING, abs=0.5)
        assert float(b["rating"]) == pytest.approx(DEFAULT_RATING, abs=0.5)

    @pytest.mark.asyncio
    async def test_persisted_to_redis(self, elo: EloManager) -> None:
        await elo.update_ratings("w", "l", "keyboard")
        stats = await elo.get_rating("w", "keyboard")
        assert float(stats["rating"]) > DEFAULT_RATING
        assert stats["wins"] == 1
        assert stats["matches"] == 1

    @pytest.mark.asyncio
    async def test_multiple_matches(self, elo: EloManager) -> None:
        await elo.update_ratings("a", "b", "keyboard")
        await elo.update_ratings("a", "b", "keyboard")
        stats_a = await elo.get_rating("a", "keyboard")
        assert stats_a["wins"] == 2
        assert stats_a["matches"] == 2
        stats_b = await elo.get_rating("b", "keyboard")
        assert stats_b["losses"] == 2
        assert stats_b["matches"] == 2

    @pytest.mark.asyncio
    async def test_separate_categories(self, elo: EloManager) -> None:
        await elo.update_ratings("a", "b", "keyboard")
        await elo.update_ratings("b", "a", "voice")
        kb = await elo.get_rating("a", "keyboard")
        voice = await elo.get_rating("a", "voice")
        assert float(kb["rating"]) > DEFAULT_RATING  # Won keyboard
        assert float(voice["rating"]) < DEFAULT_RATING  # Lost voice


class TestLeaderboard:
    """Test leaderboard queries."""

    @pytest.mark.asyncio
    async def test_empty_leaderboard(self, elo: EloManager) -> None:
        result = await elo.get_leaderboard("keyboard")
        assert result == []

    @pytest.mark.asyncio
    async def test_entries_sorted_by_rating(self, elo: EloManager) -> None:
        await elo.set_player_name("a", "Alice")
        await elo.set_player_name("b", "Bob")
        # a beats b twice → a has higher rating
        await elo.update_ratings("a", "b", "keyboard")
        await elo.update_ratings("a", "b", "keyboard")
        result = await elo.get_leaderboard("keyboard")
        assert len(result) == 2
        assert result[0]["user_id"] == "a"
        assert result[0]["rank"] == 1
        assert result[1]["user_id"] == "b"
        assert result[1]["rank"] == 2

    @pytest.mark.asyncio
    async def test_limit(self, elo: EloManager) -> None:
        for i in range(5):
            await elo.update_ratings(f"w{i}", f"l{i}", "keyboard")
        result = await elo.get_leaderboard("keyboard", limit=3)
        assert len(result) == 3

    @pytest.mark.asyncio
    async def test_includes_name(self, elo: EloManager) -> None:
        await elo.set_player_name("a", "Alice")
        await elo.update_ratings("a", "b", "keyboard")
        result = await elo.get_leaderboard("keyboard")
        alice = [e for e in result if e["user_id"] == "a"][0]
        assert alice["name"] == "Alice"

    @pytest.mark.asyncio
    async def test_includes_stats(self, elo: EloManager) -> None:
        await elo.update_ratings("a", "b", "keyboard")
        result = await elo.get_leaderboard("keyboard")
        alice = [e for e in result if e["user_id"] == "a"][0]
        assert alice["wins"] == 1
        assert alice["matches"] == 1


class TestPlayerRank:
    """Test player rank queries."""

    @pytest.mark.asyncio
    async def test_unranked_player(self, elo: EloManager) -> None:
        rank = await elo.get_player_rank("nobody", "keyboard")
        assert rank is None

    @pytest.mark.asyncio
    async def test_ranked_after_match(self, elo: EloManager) -> None:
        await elo.update_ratings("a", "b", "keyboard")
        rank_a = await elo.get_player_rank("a", "keyboard")
        rank_b = await elo.get_player_rank("b", "keyboard")
        assert rank_a == 1  # Winner is rank 1
        assert rank_b == 2


# ─────────────────────────────────────────────
# Server endpoint tests
# ─────────────────────────────────────────────

from litestar.testing import TestClient
from server import app


class TestLeaderboardEndpoint:
    """Test GET /api/leaderboard."""

    def test_empty_leaderboard(self) -> None:
        with TestClient(app=app) as client:
            import server
            server.elo_manager = EloManager(
                fakeredis.aioredis.FakeRedis(decode_responses=True)
            )
            resp = client.get("/api/leaderboard?category=keyboard")
            assert resp.status_code == 200
            data = resp.json()
            assert data["category"] == "keyboard"
            assert data["entries"] == []

    def test_invalid_category(self) -> None:
        with TestClient(app=app) as client:
            import server
            server.elo_manager = EloManager(
                fakeredis.aioredis.FakeRedis(decode_responses=True)
            )
            resp = client.get("/api/leaderboard?category=invalid")
            assert resp.status_code == 400

    def test_default_category_is_all(self) -> None:
        with TestClient(app=app) as client:
            import server
            server.elo_manager = EloManager(
                fakeredis.aioredis.FakeRedis(decode_responses=True)
            )
            resp = client.get("/api/leaderboard")
            assert resp.status_code == 200
            assert resp.json()["category"] == "all"


def _elo_client_with_data():
    """Create a TestClient + EloManager with shared FakeServer for sync data setup.

    The trick: use sync FakeRedis to pre-populate data, sharing the same
    FakeServer with the async FakeRedis used by EloManager. This avoids
    event loop issues with asyncio.new_event_loop().
    """
    fake_server = fakeredis.FakeServer()
    async_redis = fakeredis.aioredis.FakeRedis(
        decode_responses=True, server=fake_server
    )
    sync_redis = fakeredis.FakeRedis(
        decode_responses=True, server=fake_server
    )
    return async_redis, sync_redis


def _seed_player(sync_redis: fakeredis.FakeRedis, user_id: str, name: str,  # type: ignore[type-arg]
                 category: str, rating: float, wins: int, losses: int) -> None:
    """Seed a player's ELO data via sync Redis."""
    sync_redis.hset(f"player:{user_id}", "name", name)
    sync_redis.hset(f"elo:{user_id}:{category}", mapping={
        "rating": str(rating),
        "wins": str(wins),
        "losses": str(losses),
        "draws": "0",
        "matches": str(wins + losses),
    })
    sync_redis.zadd(f"leaderboard:{category}", {user_id: rating})


class TestLeaderboardViewer:
    """Test GET /api/leaderboard with user_id (viewer rank)."""

    def test_viewer_not_ranked(self) -> None:
        with TestClient(app=app) as client:
            import server
            server.elo_manager = EloManager(
                fakeredis.aioredis.FakeRedis(decode_responses=True)
            )
            resp = client.get("/api/leaderboard?category=keyboard&user_id=nobody")
            assert resp.status_code == 200
            data = resp.json()
            assert data["viewer"] is None
            assert data["viewer_in_entries"] is False

    def test_viewer_in_entries(self) -> None:
        """Viewer is in the top entries — viewer_in_entries = True."""
        async_redis, sync_redis = _elo_client_with_data()
        _seed_player(sync_redis, "viewer-1", "Viewer", "keyboard", 1016.0, 1, 0)
        _seed_player(sync_redis, "other", "Other", "keyboard", 984.0, 0, 1)

        with TestClient(app=app) as client:
            import server
            server.elo_manager = EloManager(async_redis)

            resp = client.get("/api/leaderboard?category=keyboard&user_id=viewer-1")
            assert resp.status_code == 200
            data = resp.json()
            assert data["viewer_in_entries"] is True
            assert data["viewer"] is not None
            assert data["viewer"]["user_id"] == "viewer-1"
            assert data["viewer"]["rank"] == 1

    def test_viewer_not_in_entries_but_ranked(self) -> None:
        """Viewer is ranked but below the limit — still returned as viewer."""
        async_redis, sync_redis = _elo_client_with_data()
        _seed_player(sync_redis, "top-1", "Top1", "keyboard", 1032.0, 2, 0)
        _seed_player(sync_redis, "top-2", "Top2", "keyboard", 1016.0, 1, 0)
        _seed_player(sync_redis, "viewer-1", "Viewer", "keyboard", 968.0, 0, 2)

        with TestClient(app=app) as client:
            import server
            server.elo_manager = EloManager(async_redis)

            resp = client.get("/api/leaderboard?category=keyboard&limit=2&user_id=viewer-1")
            assert resp.status_code == 200
            data = resp.json()
            assert len(data["entries"]) == 2
            assert data["viewer_in_entries"] is False
            assert data["viewer"] is not None
            assert data["viewer"]["rank"] == 3
            assert data["viewer"]["name"] == "Viewer"

    def test_viewer_all_category(self) -> None:
        """Viewer rank works with category=all (merges voice + keyboard)."""
        async_redis, sync_redis = _elo_client_with_data()
        _seed_player(sync_redis, "viewer-1", "Viewer", "voice", 1016.0, 1, 0)
        _seed_player(sync_redis, "other", "Other", "voice", 984.0, 0, 1)

        with TestClient(app=app) as client:
            import server
            server.elo_manager = EloManager(async_redis)

            resp = client.get("/api/leaderboard?category=all&user_id=viewer-1")
            assert resp.status_code == 200
            data = resp.json()
            assert data["viewer"] is not None
            assert data["viewer"]["input_mode"] == "voice"

    def test_no_viewer_without_user_id(self) -> None:
        """No viewer field when user_id not provided."""
        with TestClient(app=app) as client:
            import server
            server.elo_manager = EloManager(
                fakeredis.aioredis.FakeRedis(decode_responses=True)
            )
            resp = client.get("/api/leaderboard?category=keyboard")
            assert resp.status_code == 200
            data = resp.json()
            assert "viewer" not in data
            assert "viewer_in_entries" not in data


class TestLeaderboardPageRoute:
    """Test GET /leaderboard page route."""

    def test_serves_html(self) -> None:
        with TestClient(app=app) as client:
            resp = client.get("/leaderboard")
            assert resp.status_code == 200
            assert "text/html" in resp.headers["content-type"]
            assert "STICK FIGHTER" in resp.text


class TestGetEloEndpoint:
    """Test GET /api/elo/{user_id}."""

    def test_new_player_defaults(self) -> None:
        with TestClient(app=app) as client:
            import server
            server.elo_manager = EloManager(
                fakeredis.aioredis.FakeRedis(decode_responses=True)
            )
            resp = client.get("/api/elo/user-123")
            assert resp.status_code == 200
            data = resp.json()
            assert data["user_id"] == "user-123"
            assert data["voice"]["rating"] == DEFAULT_RATING
            assert data["keyboard"]["rating"] == DEFAULT_RATING

    def test_specific_category(self) -> None:
        with TestClient(app=app) as client:
            import server
            server.elo_manager = EloManager(
                fakeredis.aioredis.FakeRedis(decode_responses=True)
            )
            resp = client.get("/api/elo/user-123?category=keyboard")
            assert resp.status_code == 200
            data = resp.json()
            assert data["rating"] == DEFAULT_RATING
            assert data["category"] == "keyboard"
