"""ELO rating system with PostgreSQL persistence.

Ratings are stored per-user per-category (voice / keyboard):
  - Table ``players`` → user_id, name
  - Table ``elo_ratings`` → user_id, category, rating, wins, losses, draws, matches
  - Table ``match_history`` → per-match audit trail

Leaderboard queries use ``ORDER BY rating DESC`` on the elo_ratings table.
"""
from __future__ import annotations

import math
import random
import re
from typing import Any

import asyncpg  # type: ignore[import-untyped]


# ─────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────

DEFAULT_RATING = 1000
K_FACTOR_NEW = 32       # <30 matches
K_FACTOR_ESTABLISHED = 16  # ≥30 matches
K_FACTOR_THRESHOLD = 30

# Input category mapping
VOICE_CONTROLLERS = {"voice", "phone"}
KEYBOARD_CONTROLLERS = {"keyboard", "controller"}


def controller_to_category(controller: str) -> str | None:
    """Map a controller name to an ELO category.

    Returns 'voice', 'keyboard', or None for non-ranked controllers.
    """
    if controller in VOICE_CONTROLLERS:
        return "voice"
    if controller in KEYBOARD_CONTROLLERS:
        return "keyboard"
    return None


# ─────────────────────────────────────────────
# Random fighter username generation
# ─────────────────────────────────────────────

FIGHTER_NOUNS = [
    "ninja", "tank", "knight", "samurai", "boxer", "brawler", "warrior",
    "striker", "guardian", "champion", "berserker", "duelist", "monk",
    "ronin", "gladiator", "paladin",
]

STICK_NOUNS = [
    "stick", "branch", "broom", "mop", "pole", "stretch", "twig",
    "rod", "staff", "cane", "reed", "wand", "beam", "shaft", "spar",
]

ADJECTIVES = [
    "swift", "shadow", "iron", "dark", "wild", "bold", "keen",
    "fierce", "calm", "stone", "frost", "flame",
]

MAX_USERNAME_RETRIES = 10
USERNAME_PATTERN = r"^[a-zA-Z0-9-]{2,30}$"


def generate_fighter_username() -> str:
    """Generate a random fighter-themed username.

    Format: {adjective}-{fighter}-{stick} or {fighter}-{stick}.
    Roughly 50/50 chance of including the adjective prefix.
    """
    fighter = random.choice(FIGHTER_NOUNS)
    stick = random.choice(STICK_NOUNS)
    if random.random() < 0.5:
        return f"{random.choice(ADJECTIVES)}-{fighter}-{stick}"
    return f"{fighter}-{stick}"


# ─────────────────────────────────────────────
# ELO calculation
# ─────────────────────────────────────────────

def _expected_score(rating_a: float, rating_b: float) -> float:
    """Calculate expected score for player A against player B."""
    return 1.0 / (1.0 + math.pow(10.0, (rating_b - rating_a) / 400.0))


def _k_factor(matches: int) -> int:
    """Return K-factor based on number of matches played."""
    return K_FACTOR_NEW if matches < K_FACTOR_THRESHOLD else K_FACTOR_ESTABLISHED


def calculate_elo_change(
    rating_a: float,
    rating_b: float,
    matches_a: int,
    matches_b: int,
    result: float,
) -> tuple[float, float]:
    """Calculate new ratings for both players.

    Args:
        rating_a: Player A's current rating
        rating_b: Player B's current rating
        matches_a: Player A's total matches played
        matches_b: Player B's total matches played
        result: 1.0 = A wins, 0.0 = B wins, 0.5 = draw

    Returns:
        Tuple of (new_rating_a, new_rating_b)
    """
    expected_a = _expected_score(rating_a, rating_b)
    expected_b = 1.0 - expected_a

    k_a = _k_factor(matches_a)
    k_b = _k_factor(matches_b)

    new_a = rating_a + k_a * (result - expected_a)
    new_b = rating_b + k_b * ((1.0 - result) - expected_b)

    return round(new_a, 1), round(new_b, 1)


# ─────────────────────────────────────────────
# Schema bootstrap
# ─────────────────────────────────────────────

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS players (
    user_id   TEXT PRIMARY KEY,
    name      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS elo_ratings (
    user_id   TEXT NOT NULL REFERENCES players(user_id) ON DELETE CASCADE,
    category  TEXT NOT NULL CHECK (category IN ('voice', 'keyboard')),
    rating    REAL NOT NULL DEFAULT 1000,
    wins      INTEGER NOT NULL DEFAULT 0,
    losses    INTEGER NOT NULL DEFAULT 0,
    draws     INTEGER NOT NULL DEFAULT 0,
    matches   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, category)
);

CREATE INDEX IF NOT EXISTS idx_elo_category_rating
    ON elo_ratings (category, rating DESC);

CREATE TABLE IF NOT EXISTS match_history (
    id                    SERIAL PRIMARY KEY,
    winner_id             TEXT REFERENCES players(user_id),
    loser_id              TEXT REFERENCES players(user_id),
    category              TEXT NOT NULL CHECK (category IN ('voice', 'keyboard')),
    winner_rating_before  REAL NOT NULL,
    loser_rating_before   REAL NOT NULL,
    winner_rating_after   REAL NOT NULL,
    loser_rating_after    REAL NOT NULL,
    draw                  BOOLEAN NOT NULL DEFAULT FALSE,
    played_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_match_history_played_at
    ON match_history (played_at DESC);
"""


async def ensure_schema(pool: asyncpg.Pool) -> None:  # type: ignore[type-arg]
    """Create tables if they don't exist."""
    async with pool.acquire() as conn:
        await conn.execute(_SCHEMA_SQL)


# ─────────────────────────────────────────────
# ELO Manager
# ─────────────────────────────────────────────

class EloManager:
    """Async PostgreSQL-backed ELO rating manager."""

    def __init__(self, pool: asyncpg.Pool) -> None:  # type: ignore[type-arg]
        self._pool: asyncpg.Pool = pool  # type: ignore[type-arg]

    async def get_rating(self, user_id: str, category: str) -> dict[str, Any]:
        """Get a player's rating data for a category.

        Returns dict with: user_id, category, rating, wins, losses, draws, matches.
        Returns defaults (rating=1000) if player has no record.
        """
        row = await self._pool.fetchrow(
            "SELECT rating, wins, losses, draws, matches FROM elo_ratings WHERE user_id = $1 AND category = $2",
            user_id, category,
        )

        if row is None:
            return {
                "user_id": user_id,
                "category": category,
                "rating": DEFAULT_RATING,
                "wins": 0,
                "losses": 0,
                "draws": 0,
                "matches": 0,
            }

        return {
            "user_id": user_id,
            "category": category,
            "rating": float(row["rating"]),
            "wins": int(row["wins"]),
            "losses": int(row["losses"]),
            "draws": int(row["draws"]),
            "matches": int(row["matches"]),
        }

    async def set_player_name(self, user_id: str, name: str) -> None:
        """Store/update a player's display name."""
        await self._pool.execute(
            "INSERT INTO players (user_id, name) VALUES ($1, $2) "
            "ON CONFLICT (user_id) DO UPDATE SET name = $2",
            user_id, name,
        )

    async def get_player_name(self, user_id: str) -> str:
        """Get a player's display name."""
        row = await self._pool.fetchrow(
            "SELECT name FROM players WHERE user_id = $1", user_id,
        )
        return str(row["name"]) if row else ""

    async def _is_name_taken(self, name: str) -> bool:
        """Check if a display name is already used by any player."""
        row = await self._pool.fetchrow(
            "SELECT 1 FROM players WHERE name = $1", name,
        )
        return row is not None

    async def _is_name_taken_by_other(self, name: str, user_id: str) -> bool:
        """Check if a display name is used by a different player."""
        row = await self._pool.fetchrow(
            "SELECT 1 FROM players WHERE name = $1 AND user_id != $2",
            name, user_id,
        )
        return row is not None

    async def update_username(self, user_id: str, name: str) -> str | None:
        """Validate and update a player's username.

        Returns the new name on success, or None if the name is taken.
        Raises ValueError if the name format is invalid.
        """
        if not re.match(USERNAME_PATTERN, name):
            raise ValueError(
                "Username must be 2-30 characters, alphanumeric and hyphens only"
            )
        if await self._is_name_taken_by_other(name, user_id):
            return None
        await self.set_player_name(user_id, name)
        return name

    async def ensure_fighter_username(self, user_id: str) -> str:
        """Return existing name or generate a unique fighter username.

        On first login (no entry or empty name in players table), generates
        a random fighter-themed username and stores it. Retries on collision.
        """
        existing = await self.get_player_name(user_id)
        if existing:
            return existing

        for _ in range(MAX_USERNAME_RETRIES):
            candidate = generate_fighter_username()
            if not await self._is_name_taken(candidate):
                await self.set_player_name(user_id, candidate)
                return candidate

        # Extremely unlikely: all retries collided — append user_id suffix
        fallback = f"{generate_fighter_username()}-{user_id[:6]}"
        await self.set_player_name(user_id, fallback)
        return fallback

    async def update_ratings(
        self,
        winner_id: str,
        loser_id: str,
        category: str,
        draw: bool = False,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """Update ratings after a match. Atomic via Postgres transaction.

        Args:
            winner_id: User ID of the winner (or player A if draw)
            loser_id: User ID of the loser (or player B if draw)
            category: 'voice' or 'keyboard'
            draw: True if the match was a draw

        Returns:
            Tuple of (winner_new_stats, loser_new_stats)
        """
        # Fetch current ratings
        winner_stats = await self.get_rating(winner_id, category)
        loser_stats = await self.get_rating(loser_id, category)

        winner_rating = float(winner_stats["rating"])
        loser_rating = float(loser_stats["rating"])
        winner_matches = int(winner_stats["matches"])
        loser_matches = int(loser_stats["matches"])

        # Calculate new ratings
        result = 0.5 if draw else 1.0
        new_winner_rating, new_loser_rating = calculate_elo_change(
            winner_rating, loser_rating, winner_matches, loser_matches, result
        )

        # Atomic transaction
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                # Ensure both players exist in players table
                await conn.execute(
                    "INSERT INTO players (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
                    winner_id,
                )
                await conn.execute(
                    "INSERT INTO players (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
                    loser_id,
                )

                # Upsert winner
                await conn.execute(
                    "INSERT INTO elo_ratings (user_id, category, rating, wins, losses, draws, matches) "
                    "VALUES ($1, $2, $3, $4, 0, $5, 1) "
                    "ON CONFLICT (user_id, category) DO UPDATE SET "
                    "rating = $3, wins = elo_ratings.wins + $4, "
                    "draws = elo_ratings.draws + $5, matches = elo_ratings.matches + 1",
                    winner_id, category, new_winner_rating,
                    0 if draw else 1,  # wins increment
                    1 if draw else 0,  # draws increment
                )

                # Upsert loser
                await conn.execute(
                    "INSERT INTO elo_ratings (user_id, category, rating, wins, losses, draws, matches) "
                    "VALUES ($1, $2, $3, 0, $4, $5, 1) "
                    "ON CONFLICT (user_id, category) DO UPDATE SET "
                    "rating = $3, losses = elo_ratings.losses + $4, "
                    "draws = elo_ratings.draws + $5, matches = elo_ratings.matches + 1",
                    loser_id, category, new_loser_rating,
                    0 if draw else 1,  # losses increment
                    1 if draw else 0,  # draws increment
                )

                # Record match history
                await conn.execute(
                    "INSERT INTO match_history "
                    "(winner_id, loser_id, category, winner_rating_before, loser_rating_before, "
                    "winner_rating_after, loser_rating_after, draw) "
                    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                    winner_id, loser_id, category,
                    winner_rating, loser_rating,
                    new_winner_rating, new_loser_rating,
                    draw,
                )

        # Return updated stats
        winner_new = {
            "user_id": winner_id,
            "category": category,
            "rating": new_winner_rating,
            "wins": int(winner_stats["wins"]) + (0 if draw else 1),
            "losses": int(winner_stats["losses"]),
            "draws": int(winner_stats["draws"]) + (1 if draw else 0),
            "matches": winner_matches + 1,
        }
        loser_new = {
            "user_id": loser_id,
            "category": category,
            "rating": new_loser_rating,
            "wins": int(loser_stats["wins"]),
            "losses": int(loser_stats["losses"]) + (0 if draw else 1),
            "draws": int(loser_stats["draws"]) + (1 if draw else 0),
            "matches": loser_matches + 1,
        }

        return winner_new, loser_new

    async def get_leaderboard(
        self,
        category: str,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Get leaderboard entries sorted by ELO (highest first).

        Args:
            category: 'voice' or 'keyboard'
            limit: Max entries to return
            offset: Starting offset

        Returns:
            List of dicts with: rank, user_id, name, rating, wins, losses, draws, matches
        """
        rows = await self._pool.fetch(
            "SELECT e.user_id, COALESCE(p.name, '') AS name, "
            "e.rating, e.wins, e.losses, e.draws, e.matches "
            "FROM elo_ratings e "
            "LEFT JOIN players p ON p.user_id = e.user_id "
            "WHERE e.category = $1 "
            "ORDER BY e.rating DESC "
            "LIMIT $2 OFFSET $3",
            category, limit, offset,
        )

        return [
            {
                "rank": offset + i + 1,
                "user_id": str(row["user_id"]),
                "name": str(row["name"]),
                "rating": float(row["rating"]),
                "wins": int(row["wins"]),
                "losses": int(row["losses"]),
                "draws": int(row["draws"]),
                "matches": int(row["matches"]),
            }
            for i, row in enumerate(rows)
        ]

    async def get_player_rank(self, user_id: str, category: str) -> int | None:
        """Get a player's rank (1-based) in a category. Returns None if not ranked."""
        row = await self._pool.fetchrow(
            "SELECT COUNT(*) + 1 AS rank FROM elo_ratings "
            "WHERE category = $1 AND rating > "
            "(SELECT rating FROM elo_ratings WHERE user_id = $2 AND category = $1)",
            category, user_id,
        )
        # Check player actually has a rating in this category
        exists = await self._pool.fetchrow(
            "SELECT 1 FROM elo_ratings WHERE user_id = $1 AND category = $2",
            user_id, category,
        )
        if exists is None:
            return None
        return int(row["rank"]) if row else None
