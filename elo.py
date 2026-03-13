"""ELO rating system with Redis persistence.

Ratings are stored per-user per-category (voice / keyboard):
  - Hash ``elo:{user_id}:{category}`` → rating, wins, losses, draws, matches
  - Sorted set ``leaderboard:{category}`` → user IDs scored by ELO
  - Hash ``player:{user_id}`` → name (for leaderboard display)

No TTL — ELO data persists indefinitely.
"""
from __future__ import annotations

import math
from typing import Any

import redis.asyncio as aioredis  # type: ignore[import-untyped]


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
# Redis key helpers
# ─────────────────────────────────────────────

def _elo_key(user_id: str, category: str) -> str:
    return f"elo:{user_id}:{category}"


def _leaderboard_key(category: str) -> str:
    return f"leaderboard:{category}"


def _player_key(user_id: str) -> str:
    return f"player:{user_id}"


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
# ELO Manager
# ─────────────────────────────────────────────

class EloManager:
    """Async Redis-backed ELO rating manager."""

    def __init__(self, redis: aioredis.Redis) -> None:  # type: ignore[type-arg]
        self._redis: aioredis.Redis = redis  # type: ignore[type-arg]

    async def get_rating(self, user_id: str, category: str) -> dict[str, Any]:
        """Get a player's rating data for a category.

        Returns dict with: user_id, category, rating, wins, losses, draws, matches.
        Returns defaults (rating=1000) if player has no record.
        """
        key = _elo_key(user_id, category)
        data = await self._redis.hgetall(key)  # type: ignore[misc]

        if not data:
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
            "rating": float(data.get("rating", str(DEFAULT_RATING))),
            "wins": int(data.get("wins", "0")),
            "losses": int(data.get("losses", "0")),
            "draws": int(data.get("draws", "0")),
            "matches": int(data.get("matches", "0")),
        }

    async def set_player_name(self, user_id: str, name: str) -> None:
        """Store/update a player's display name for leaderboard."""
        await self._redis.hset(_player_key(user_id), "name", name)  # type: ignore[misc]

    async def get_player_name(self, user_id: str) -> str:
        """Get a player's display name."""
        name = await self._redis.hget(_player_key(user_id), "name")  # type: ignore[misc]
        return str(name) if name else ""

    async def update_ratings(
        self,
        winner_id: str,
        loser_id: str,
        category: str,
        draw: bool = False,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """Update ratings after a match. Atomic via Redis pipeline.

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

        # Build update data
        winner_key = _elo_key(winner_id, category)
        loser_key = _elo_key(loser_id, category)
        lb_key = _leaderboard_key(category)

        # Atomic pipeline update
        pipe = self._redis.pipeline()
        pipe.hset(winner_key, mapping={  # type: ignore[misc]
            "rating": str(new_winner_rating),
            "wins": str(int(winner_stats["wins"]) + (0 if draw else 1)),
            "losses": str(int(winner_stats["losses"])),
            "draws": str(int(winner_stats["draws"]) + (1 if draw else 0)),
            "matches": str(winner_matches + 1),
        })
        pipe.hset(loser_key, mapping={  # type: ignore[misc]
            "rating": str(new_loser_rating),
            "wins": str(int(loser_stats["wins"])),
            "losses": str(int(loser_stats["losses"]) + (0 if draw else 1)),
            "draws": str(int(loser_stats["draws"]) + (1 if draw else 0)),
            "matches": str(loser_matches + 1),
        })
        # Update leaderboard sorted sets
        pipe.zadd(lb_key, {winner_id: new_winner_rating})  # type: ignore[misc]
        pipe.zadd(lb_key, {loser_id: new_loser_rating})  # type: ignore[misc]
        await pipe.execute()  # type: ignore[misc]

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
        lb_key = _leaderboard_key(category)

        # ZREVRANGE returns highest scores first
        entries = await self._redis.zrevrange(  # type: ignore[misc]
            lb_key, offset, offset + limit - 1, withscores=True
        )

        result: list[dict[str, Any]] = []
        for rank_idx, (user_id, score) in enumerate(entries):
            name = await self.get_player_name(user_id)
            stats = await self.get_rating(user_id, category)
            result.append({
                "rank": offset + rank_idx + 1,
                "user_id": str(user_id),
                "name": name,
                "rating": float(score),
                "wins": int(stats["wins"]),
                "losses": int(stats["losses"]),
                "draws": int(stats["draws"]),
                "matches": int(stats["matches"]),
            })

        return result

    async def get_player_rank(self, user_id: str, category: str) -> int | None:
        """Get a player's rank (1-based) in a category. Returns None if not ranked."""
        lb_key = _leaderboard_key(category)
        rank = await self._redis.zrevrank(lb_key, user_id)  # type: ignore[misc]
        if rank is None:
            return None
        return int(rank) + 1  # Convert 0-based to 1-based
