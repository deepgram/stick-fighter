"""Redis-backed room state management for multiplayer rooms.

Room data is stored as a Redis hash at key ``room:{code}`` with fields:
  code, p1_id, p2_id, p1_controller, p2_controller, status, created_at

Rooms expire via Redis TTL (5 minutes from last activity).
"""
from __future__ import annotations

import random
import time

import redis.asyncio as aioredis  # type: ignore[import-untyped]

# ─────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────

ROOM_TTL = 300  # 5 minutes
MATCHMAKING_ENTRY_TTL = 120  # 2 minutes — queue entries expire if player disconnects

ROOM_STATUSES = ("waiting", "selecting", "fighting", "finished")

_VALID_TRANSITIONS: dict[str, list[str]] = {
    "waiting": ["selecting"],
    "selecting": ["fighting"],
    "fighting": ["finished"],
    "finished": [],
}

# Word list for room codes — common, distinct, inoffensive English words
_ADJECTIVES = [
    "red", "blue", "gold", "dark", "wild", "cool", "bold", "fast",
    "keen", "calm", "warm", "deep", "free", "high", "iron", "jade",
    "pale", "rich", "sage", "true", "vast", "wise", "pure", "dawn",
]

_NOUNS = [
    "tiger", "eagle", "flame", "storm", "blade", "frost", "crown",
    "spark", "shade", "stone", "river", "forge", "lance", "ridge",
    "grove", "raven", "steel", "drift", "thorn", "cedar", "flint",
    "ember", "cliff", "pearl",
]

_VERBS = [
    "paw", "run", "fly", "dash", "leap", "spin", "rush", "soar",
    "roar", "dive", "howl", "snap", "kick", "rise", "glow", "flow",
    "burn", "turn", "call", "roll", "hold", "leap", "cast", "draw",
]


def _room_key(code: str) -> str:
    return f"room:{code}"


def generate_room_code() -> str:
    """Generate a 3-word room code like ``red-tiger-paw``."""
    return f"{random.choice(_ADJECTIVES)}-{random.choice(_NOUNS)}-{random.choice(_VERBS)}"


class RoomManager:
    """Async Redis-backed room state manager."""

    def __init__(self, redis: aioredis.Redis) -> None:  # type: ignore[type-arg]
        self._redis: aioredis.Redis = redis  # type: ignore[type-arg]

    async def create_room(self, player_id: str) -> dict[str, str]:
        """Create a new room, assign creator as Player 1, return room data.

        Generates a unique code among active rooms.
        """
        # Generate a unique code (retry on collision)
        for _ in range(20):
            code = generate_room_code()
            key = _room_key(code)
            if not await self._redis.exists(key):
                break
        else:
            # Extremely unlikely — 24*24*24 = 13,824 combinations
            raise RuntimeError("Could not generate unique room code")

        now = str(int(time.time()))
        room_data: dict[str, str] = {
            "code": code,
            "p1_id": player_id,
            "p2_id": "",
            "p1_controller": "",
            "p2_controller": "",
            "status": "waiting",
            "created_at": now,
        }

        key = _room_key(code)
        await self._redis.hset(key, mapping=room_data)  # type: ignore[misc]
        await self._redis.expire(key, ROOM_TTL)  # type: ignore[misc]

        return room_data

    async def get_room(self, code: str) -> dict[str, str] | None:
        """Fetch room data by code. Returns None if not found / expired."""
        data = await self._redis.hgetall(_room_key(code))  # type: ignore[misc]
        if not data:
            return None
        # Redis returns bytes when decode_responses is not set,
        # but our tests/config typically use decode_responses=True.
        # Handle both cases.
        return {
            (k.decode() if isinstance(k, bytes) else k): (v.decode() if isinstance(v, bytes) else v)
            for k, v in data.items()
        }

    async def join_room(self, code: str, player_id: str) -> dict[str, str]:
        """Join a room as Player 2. Raises ValueError if room is full or not found."""
        room = await self.get_room(code)
        if room is None:
            raise ValueError("Room not found or expired")

        if room["p2_id"]:
            raise ValueError("Room is full")

        if room["status"] != "waiting":
            raise ValueError(f"Room is not accepting players (status: {room['status']})")

        key = _room_key(code)
        await self._redis.hset(key, "p2_id", player_id)  # type: ignore[misc]
        await self._redis.expire(key, ROOM_TTL)  # type: ignore[misc]

        room["p2_id"] = player_id
        return room

    async def set_controller(self, code: str, player: int, controller: str) -> dict[str, str]:
        """Set a player's controller choice. player is 1 or 2."""
        if player not in (1, 2):
            raise ValueError("player must be 1 or 2")

        room = await self.get_room(code)
        if room is None:
            raise ValueError("Room not found or expired")

        field = f"p{player}_controller"
        key = _room_key(code)
        await self._redis.hset(key, field, controller)  # type: ignore[misc]
        await self._redis.expire(key, ROOM_TTL)  # type: ignore[misc]

        room[field] = controller
        return room

    async def transition_status(self, code: str, new_status: str) -> dict[str, str]:
        """Transition room to a new status. Raises ValueError on invalid transition."""
        if new_status not in ROOM_STATUSES:
            raise ValueError(f"Invalid status: {new_status}")

        room = await self.get_room(code)
        if room is None:
            raise ValueError("Room not found or expired")

        current = room["status"]
        allowed = _VALID_TRANSITIONS.get(current, [])
        if new_status not in allowed:
            raise ValueError(f"Cannot transition from '{current}' to '{new_status}'")

        key = _room_key(code)
        await self._redis.hset(key, "status", new_status)  # type: ignore[misc]
        await self._redis.expire(key, ROOM_TTL)  # type: ignore[misc]

        room["status"] = new_status
        return room

    async def reset_for_rematch(self, code: str) -> dict[str, str]:
        """Reset a room for a rematch — clear controllers, set status to 'selecting'.

        Room must be in 'fighting' or 'finished' status. Players stay assigned.
        Raises ValueError if room not found or invalid status.
        """
        room = await self.get_room(code)
        if room is None:
            raise ValueError("Room not found or expired")

        if room["status"] not in ("fighting", "finished"):
            raise ValueError(f"Cannot rematch from status '{room['status']}'")

        key = _room_key(code)
        await self._redis.hset(key, mapping={  # type: ignore[misc]
            "p1_controller": "",
            "p2_controller": "",
            "status": "selecting",
        })
        await self._redis.expire(key, ROOM_TTL)  # type: ignore[misc]

        room["p1_controller"] = ""
        room["p2_controller"] = ""
        room["status"] = "selecting"
        return room

    async def refresh_ttl(self, code: str) -> bool:
        """Refresh the room's TTL on activity. Returns False if room doesn't exist."""
        return bool(await self._redis.expire(_room_key(code), ROOM_TTL))  # type: ignore[misc]

    async def delete_room(self, code: str) -> bool:
        """Explicitly delete a room. Returns True if it existed."""
        return bool(await self._redis.delete(_room_key(code)))  # type: ignore[misc]

    # ─────────────────────────────────────────────
    # Matchmaking queue with TTL
    # ─────────────────────────────────────────────

    async def matchmaking_join(self, category: str, player_id: str, elo: float) -> bool:
        """Add a player to the matchmaking queue with an auto-expiring TTL key.

        The sorted set ``matchmaking:{category}`` holds player_id scored by ELO.
        A companion key ``matchmaking_ttl:{category}:{player_id}`` expires after
        ``MATCHMAKING_ENTRY_TTL`` — the cleanup sweep removes orphaned entries.

        Returns True if the player was added (False if already in queue).
        """
        queue_key = f"matchmaking:{category}"
        ttl_key = f"matchmaking_ttl:{category}:{player_id}"

        # Check if already queued
        existing = await self._redis.zscore(queue_key, player_id)  # type: ignore[misc]
        if existing is not None:
            # Refresh TTL on re-join
            await self._redis.expire(ttl_key, MATCHMAKING_ENTRY_TTL)  # type: ignore[misc]
            return False

        await self._redis.zadd(queue_key, {player_id: elo})  # type: ignore[misc]
        await self._redis.set(ttl_key, "1", ex=MATCHMAKING_ENTRY_TTL)  # type: ignore[misc]
        return True

    async def matchmaking_leave(self, category: str, player_id: str) -> bool:
        """Remove a player from the matchmaking queue. Returns True if they were queued."""
        queue_key = f"matchmaking:{category}"
        ttl_key = f"matchmaking_ttl:{category}:{player_id}"

        removed = await self._redis.zrem(queue_key, player_id)  # type: ignore[misc]
        await self._redis.delete(ttl_key)  # type: ignore[misc]
        return bool(removed)

    async def matchmaking_refresh_ttl(self, category: str, player_id: str) -> bool:
        """Refresh the TTL for a matchmaking queue entry. Returns False if key doesn't exist."""
        ttl_key = f"matchmaking_ttl:{category}:{player_id}"
        return bool(await self._redis.expire(ttl_key, MATCHMAKING_ENTRY_TTL))  # type: ignore[misc]

    async def matchmaking_cleanup_expired(self, category: str) -> list[str]:
        """Remove queue entries whose TTL key has expired. Returns removed player IDs."""
        queue_key = f"matchmaking:{category}"
        members: list[str] = await self._redis.zrange(queue_key, 0, -1)  # type: ignore[misc]
        removed: list[str] = []

        for player_id in members:
            ttl_key = f"matchmaking_ttl:{category}:{player_id}"
            exists = await self._redis.exists(ttl_key)  # type: ignore[misc]
            if not exists:
                await self._redis.zrem(queue_key, player_id)  # type: ignore[misc]
                removed.append(player_id)

        return removed
