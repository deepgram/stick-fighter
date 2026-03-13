"""Periodic room cleanup — detects expired Redis rooms and cleans up server resources.

When a Redis room key expires via TTL, the server-side resources (game loops,
signaling sessions) linger in memory. This module runs a periodic sweep that
cross-references in-memory rooms against Redis and cleans up orphans.

Also sends ``room_expired`` messages to connected WebSocket clients so they
can close WebRTC connections gracefully.
"""
from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from game_loop import GameLoopManager
    from room_manager import RoomManager
    from signaling import SignalingManager


CLEANUP_INTERVAL = 30.0  # seconds between sweeps


class RoomCleanupTask:
    """Periodically sweeps for expired rooms and cleans up associated resources."""

    def __init__(
        self,
        room_manager: RoomManager,
        game_loop_manager: GameLoopManager,
        signaling_manager: SignalingManager,
    ) -> None:
        self._room_manager = room_manager
        self._game_loop_manager = game_loop_manager
        self._signaling_manager = signaling_manager
        self._task: asyncio.Task[None] | None = None
        self._stopped = False

    def start(self) -> None:
        """Start the periodic cleanup task."""
        if self._task is not None:
            return
        self._stopped = False
        self._task = asyncio.create_task(self._run())
        print(f"[cleanup] Started (interval={CLEANUP_INTERVAL}s)")

    async def stop(self) -> None:
        """Stop the cleanup task."""
        self._stopped = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        print("[cleanup] Stopped")

    async def sweep(self) -> list[str]:
        """Run one cleanup sweep. Returns list of cleaned-up room codes."""
        cleaned: list[str] = []

        # Check game loops against Redis
        active_codes = list(self._game_loop_manager.rooms.keys())
        for code in active_codes:
            room = await self._room_manager.get_room(code)
            if room is None:
                # Room expired in Redis — notify clients and clean up
                await self._cleanup_room(code)
                cleaned.append(code)

        # Check signaling sessions against Redis (may have rooms without game loops)
        signal_codes = list(self._signaling_manager.sessions.keys())
        for code in signal_codes:
            if code in cleaned:
                continue  # Already cleaned up above
            room = await self._room_manager.get_room(code)
            if room is None:
                self._signaling_manager.cleanup_room(code)
                cleaned.append(code)

        # Clean up expired matchmaking queue entries
        for category in ("keyboard", "voice"):
            expired = await self._room_manager.matchmaking_cleanup_expired(category)
            if expired:
                print(f"[cleanup] Removed {len(expired)} expired matchmaking entries from '{category}'")

        if cleaned:
            print(f"[cleanup] Swept {len(cleaned)} expired room(s): {', '.join(cleaned)}")

        return cleaned

    async def _cleanup_room(self, code: str) -> None:
        """Clean up all server resources for an expired room."""
        # Notify connected WebSocket clients before closing
        room_loop = self._game_loop_manager.get_room_loop(code)
        if room_loop is not None:
            msg = json.dumps({"type": "room_expired", "code": code})
            for conn in room_loop.players.values():
                if conn.connected:
                    try:
                        await conn.socket.send_data(msg, mode="text")
                    except Exception:
                        pass

        # Stop the game loop (removes from manager, cancels task, marks players disconnected)
        await self._game_loop_manager.stop_loop(code)

        # Clean up signaling sessions
        self._signaling_manager.cleanup_room(code)

    async def _run(self) -> None:
        """Background loop — sweeps at regular intervals."""
        try:
            while not self._stopped:
                await asyncio.sleep(CLEANUP_INTERVAL)
                if self._stopped:
                    break
                try:
                    await self.sweep()
                except Exception as e:
                    print(f"[cleanup] Sweep error: {type(e).__name__}: {e}")
        except asyncio.CancelledError:
            pass
