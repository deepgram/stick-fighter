"""Tests for the ELO rating system (elo.py + server endpoints)."""
from __future__ import annotations

import os

import asyncpg  # type: ignore[import-untyped]
import pytest
import pytest_asyncio

from elo import (
    ADJECTIVES,
    EloManager,
    FIGHTER_NOUNS,
    STICK_NOUNS,
    calculate_elo_change,
    controller_to_category,
    ensure_schema,
    generate_fighter_username,
    DEFAULT_RATING,
    K_FACTOR_NEW,
    K_FACTOR_ESTABLISHED,
    _expected_score,
    _k_factor,
)


# ─────────────────────────────────────────────
# Pure function tests (no DB needed)
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
        new_a, _ = calculate_elo_change(1000, 1200, 0, 0, 1.0)
        normal_a, _ = calculate_elo_change(1200, 1000, 0, 0, 1.0)
        assert (new_a - 1000) > (normal_a - 1200)

    def test_k_factor_matters(self) -> None:
        new_a, _ = calculate_elo_change(1000, 1000, 0, 0, 1.0)
        est_a, _ = calculate_elo_change(1000, 1000, 50, 50, 1.0)
        assert (new_a - 1000) > (est_a - 1000)

    def test_returns_rounded(self) -> None:
        new_a, new_b = calculate_elo_change(1000, 1000, 0, 0, 1.0)
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


class TestGenerateFighterUsername:
    """Test random fighter username generation."""

    def test_format_two_or_three_parts(self) -> None:
        for _ in range(50):
            name = generate_fighter_username()
            parts = name.split("-")
            assert len(parts) in (2, 3), f"Unexpected format: {name}"

    def test_two_part_uses_fighter_and_stick(self) -> None:
        for _ in range(100):
            name = generate_fighter_username()
            parts = name.split("-")
            if len(parts) == 2:
                assert parts[0] in FIGHTER_NOUNS
                assert parts[1] in STICK_NOUNS
                return
        pytest.fail("No two-part names generated in 100 tries")

    def test_three_part_uses_adjective_fighter_stick(self) -> None:
        for _ in range(100):
            name = generate_fighter_username()
            parts = name.split("-")
            if len(parts) == 3:
                assert parts[0] in ADJECTIVES
                assert parts[1] in FIGHTER_NOUNS
                assert parts[2] in STICK_NOUNS
                return
        pytest.fail("No three-part names generated in 100 tries")

    def test_word_lists_have_expected_entries(self) -> None:
        assert "ninja" in FIGHTER_NOUNS
        assert "stick" in STICK_NOUNS
        assert "swift" in ADJECTIVES
        assert len(FIGHTER_NOUNS) == 16
        assert len(STICK_NOUNS) == 15
        assert len(ADJECTIVES) == 12

    def test_randomness(self) -> None:
        names = {generate_fighter_username() for _ in range(20)}
        assert len(names) > 1, "All 20 names were identical — not random"


# ─────────────────────────────────────────────
# EloManager async tests (requires Postgres)
# ─────────────────────────────────────────────

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql://stick:fighter@localhost:5433/stickfighter",
)


@pytest_asyncio.fixture
async def pg_pool():
    """Create a connection pool and clean tables before each test."""
    pool = await asyncpg.create_pool(TEST_DATABASE_URL, min_size=1, max_size=3)
    await ensure_schema(pool)
    # Clean tables before each test (order matters for FK constraints)
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM match_history")
        await conn.execute("DELETE FROM elo_ratings")
        await conn.execute("DELETE FROM players")
    yield pool
    await pool.close()


@pytest_asyncio.fixture
async def elo(pg_pool) -> EloManager:
    """Create an EloManager backed by the test Postgres pool."""
    return EloManager(pg_pool)


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


class TestEnsureFighterUsername:
    """Test automatic fighter username assignment."""

    @pytest.mark.asyncio
    async def test_generates_name_for_new_player(self, elo: EloManager) -> None:
        name = await elo.ensure_fighter_username("new-user")
        assert name != ""
        parts = name.split("-")
        assert len(parts) in (2, 3)

    @pytest.mark.asyncio
    async def test_returns_existing_name(self, elo: EloManager) -> None:
        await elo.set_player_name("user-1", "custom-name")
        name = await elo.ensure_fighter_username("user-1")
        assert name == "custom-name"

    @pytest.mark.asyncio
    async def test_stores_generated_name(self, elo: EloManager) -> None:
        name = await elo.ensure_fighter_username("user-2")
        stored = await elo.get_player_name("user-2")
        assert stored == name

    @pytest.mark.asyncio
    async def test_idempotent(self, elo: EloManager) -> None:
        name1 = await elo.ensure_fighter_username("user-3")
        name2 = await elo.ensure_fighter_username("user-3")
        assert name1 == name2

    @pytest.mark.asyncio
    async def test_unique_across_players(self, elo: EloManager) -> None:
        names = set()
        for i in range(20):
            name = await elo.ensure_fighter_username(f"user-{i}")
            names.add(name)
        assert len(names) == 20, "Some generated names collided"


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
    async def test_persisted_to_db(self, elo: EloManager) -> None:
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

    @pytest.mark.asyncio
    async def test_match_history_recorded(self, elo: EloManager, pg_pool) -> None:
        await elo.update_ratings("a", "b", "keyboard")
        async with pg_pool.acquire() as conn:
            count = await conn.fetchval("SELECT COUNT(*) FROM match_history")
        assert count == 1


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
