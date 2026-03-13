"""ELO-based matchmaking queue with periodic matching.

Players join a per-category queue (keyboard / voice) with their ELO rating.
A background task periodically scans for pairs within an ELO threshold.
The threshold widens over time so no player waits indefinitely.

When matched, a room is auto-created with both controllers set and
status transitioned to ``fighting``.  Clients poll for match results.
"""
from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from elo import EloManager
    from room_manager import RoomManager

# ─────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────

MATCH_INTERVAL = 3.0  # seconds between match attempts
STALE_THRESHOLD = 60.0  # seconds without refresh → prune
MATCH_EXPIRY = 60.0  # seconds before unclaimed match result expires

DEFAULT_ELO_THRESHOLD = 100
THRESHOLD_WIDEN_AMOUNT = 50
THRESHOLD_WIDEN_INTERVAL = 10  # seconds


class MatchmakingTask:
    """Background matchmaking engine — matches players by ELO within a category."""

    def __init__(self, room_manager: RoomManager, elo_manager: EloManager) -> None:
        self._room_manager = room_manager
        self._elo_manager = elo_manager
        self._task: asyncio.Task[None] | None = None
        self._stopped = False
        # In-memory state
        self._entries: dict[str, dict[str, Any]] = {}   # player_id → entry
        self._matches: dict[str, dict[str, Any]] = {}   # player_id → match result

    # ── Queue operations ──────────────────────────

    async def join(
        self,
        player_id: str,
        category: str,
        controller: str,
        elo: float,
        user_id: str = "",
        name: str = "",
    ) -> None:
        """Add a player to the matchmaking queue."""
        now = time.monotonic()
        self._entries[player_id] = {
            "category": category,
            "controller": controller,
            "elo": elo,
            "user_id": user_id,
            "name": name,
            "joined_at": now,
            "refreshed_at": now,
        }
        await self._room_manager.matchmaking_join(category, player_id, elo)

    async def cancel(self, player_id: str) -> bool:
        """Remove a player from the queue + any pending match. Returns True if was queued."""
        entry = self._entries.pop(player_id, None)
        self._matches.pop(player_id, None)
        if entry:
            await self._room_manager.matchmaking_leave(entry["category"], player_id)
            return True
        return False

    def refresh(self, player_id: str) -> None:
        """Mark a player as still active (called on status poll)."""
        entry = self._entries.get(player_id)
        if entry:
            entry["refreshed_at"] = time.monotonic()

    def get_status(self, player_id: str) -> dict[str, Any]:
        """Return the player's current matchmaking status."""
        match = self._matches.get(player_id)
        if match:
            return {
                "status": "matched",
                "roomCode": match["roomCode"],
                "playerNum": match["playerNum"],
                "playerId": match["playerId"],
                "opponentName": match["opponentName"],
            }

        entry = self._entries.get(player_id)
        if not entry:
            return {"status": "not_queued"}

        now = time.monotonic()
        wait_time = now - entry["joined_at"]
        queue_count = sum(
            1 for e in self._entries.values()
            if e["category"] == entry["category"]
        )
        threshold = self._threshold(wait_time)

        return {
            "status": "searching",
            "waitTime": round(wait_time),
            "queueSize": queue_count,
            "threshold": threshold,
            "category": entry["category"],
        }

    # ── Matching algorithm ────────────────────────

    def _threshold(self, wait_time: float) -> int:
        """ELO threshold: starts at 100, widens by 50 every 10 seconds."""
        return DEFAULT_ELO_THRESHOLD + int(wait_time / THRESHOLD_WIDEN_INTERVAL) * THRESHOLD_WIDEN_AMOUNT

    async def try_match(self) -> list[tuple[str, str]]:
        """Scan the queue and match closest-ELO pairs. Returns matched (pid1, pid2) pairs."""
        matched_pairs: list[tuple[str, str]] = []

        # Group by category
        by_cat: dict[str, list[tuple[str, dict[str, Any]]]] = {}
        for pid, entry in list(self._entries.items()):
            cat = entry["category"]
            by_cat.setdefault(cat, []).append((pid, entry))

        for _category, players in by_cat.items():
            if len(players) < 2:
                continue

            # Sort by ELO for efficient closest-pair matching
            players.sort(key=lambda x: x[1]["elo"])
            matched_pids: set[str] = set()

            for i in range(len(players)):
                pid1, entry1 = players[i]
                if pid1 in matched_pids:
                    continue

                now = time.monotonic()
                wait1 = now - entry1["joined_at"]
                thresh1 = self._threshold(wait1)

                best: tuple[str, dict[str, Any]] | None = None
                best_diff = float("inf")

                for j in range(i + 1, len(players)):
                    pid2, entry2 = players[j]
                    if pid2 in matched_pids:
                        continue

                    diff = abs(entry1["elo"] - entry2["elo"])
                    wait2 = now - entry2["joined_at"]
                    thresh2 = self._threshold(wait2)
                    # Use the wider threshold (more generous for longer-waiting player)
                    threshold = max(thresh1, thresh2)

                    if diff <= threshold and diff < best_diff:
                        best = (pid2, entry2)
                        best_diff = diff

                if best is not None:
                    pid2, entry2 = best
                    matched_pids.add(pid1)
                    matched_pids.add(pid2)
                    await self._create_match(pid1, entry1, pid2, entry2)
                    matched_pairs.append((pid1, pid2))

        # Housekeeping
        self._prune_stale()
        self._prune_expired_matches()

        return matched_pairs

    async def _create_match(
        self,
        pid1: str,
        entry1: dict[str, Any],
        pid2: str,
        entry2: dict[str, Any],
    ) -> str:
        """Create a room for a matched pair. Returns the room code."""
        room = await self._room_manager.create_room(pid1)
        code = room["code"]
        await self._room_manager.join_room(code, pid2)
        await self._room_manager.transition_status(code, "selecting")
        await self._room_manager.set_controller(code, 1, entry1["controller"])
        await self._room_manager.set_controller(code, 2, entry2["controller"])
        await self._room_manager.transition_status(code, "fighting")

        now = time.monotonic()
        self._matches[pid1] = {
            "roomCode": code,
            "playerNum": 1,
            "playerId": pid1,
            "opponentName": entry2.get("name") or "Opponent",
            "matched_at": now,
        }
        self._matches[pid2] = {
            "roomCode": code,
            "playerNum": 2,
            "playerId": pid2,
            "opponentName": entry1.get("name") or "Opponent",
            "matched_at": now,
        }

        # Remove from queue
        self._entries.pop(pid1, None)
        self._entries.pop(pid2, None)
        await self._room_manager.matchmaking_leave(entry1["category"], pid1)
        await self._room_manager.matchmaking_leave(entry2["category"], pid2)

        print(f"[matchmaking] Matched {pid1} vs {pid2} → room {code}")
        return code

    # ── Housekeeping ──────────────────────────────

    def _prune_stale(self) -> list[str]:
        """Remove entries that haven't been refreshed within STALE_THRESHOLD."""
        now = time.monotonic()
        stale: list[str] = []
        for pid in list(self._entries.keys()):
            if now - self._entries[pid]["refreshed_at"] > STALE_THRESHOLD:
                stale.append(pid)
                self._entries.pop(pid)
        return stale

    def _prune_expired_matches(self) -> list[str]:
        """Remove match results that weren't picked up within MATCH_EXPIRY."""
        now = time.monotonic()
        expired: list[str] = []
        for pid in list(self._matches.keys()):
            if now - self._matches[pid]["matched_at"] > MATCH_EXPIRY:
                expired.append(pid)
                self._matches.pop(pid)
        return expired

    # ── Lifecycle ─────────────────────────────────

    def start(self) -> None:
        """Start the periodic matching task."""
        if self._task is not None:
            return
        self._stopped = False
        self._task = asyncio.create_task(self._run())
        print(f"[matchmaking] Started (interval={MATCH_INTERVAL}s)")

    async def stop(self) -> None:
        """Stop the matching task."""
        self._stopped = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        print("[matchmaking] Stopped")

    async def _run(self) -> None:
        """Background loop — tries to match players at regular intervals."""
        try:
            while not self._stopped:
                await asyncio.sleep(MATCH_INTERVAL)
                if self._stopped:
                    break
                try:
                    pairs = await self.try_match()
                    if pairs:
                        print(f"[matchmaking] Matched {len(pairs)} pair(s)")
                except Exception as e:
                    print(f"[matchmaking] Error: {type(e).__name__}: {e}")
        except asyncio.CancelledError:
            pass
