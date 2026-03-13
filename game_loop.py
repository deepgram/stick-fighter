"""Server-side game loop manager — runs one asyncio task per active room.

Each room gets a headless GameEngine ticking at 20Hz. Player inputs arrive via
WebSocket and are buffered in asyncio.Queues. Each tick consumes buffered inputs,
advances the simulation, and broadcasts the authoritative state snapshot to all
connected clients.
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any

from litestar.connection import WebSocket

from game_engine import GameEngine


# ─────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────

TICK_RATE = 20  # Hz
TICK_INTERVAL = 1.0 / TICK_RATE  # 50ms


# ─────────────────────────────────────────────
# Per-player connection state
# ─────────────────────────────────────────────

@dataclass
class PlayerConnection:
    """Tracks a connected player's WebSocket and buffered inputs."""

    player: int  # 1 or 2
    socket: WebSocket
    # Buffered inputs: each entry is {"actions": [...], "just_pressed": [...]}
    input_queue: asyncio.Queue[dict[str, list[str]]] = field(default_factory=asyncio.Queue)
    connected: bool = True


# ─────────────────────────────────────────────
# Per-room game loop state
# ─────────────────────────────────────────────

@dataclass
class RoomLoop:
    """State for one room's game loop."""

    code: str
    engine: GameEngine
    players: dict[int, PlayerConnection] = field(default_factory=dict)
    task: asyncio.Task[None] | None = None
    stopped: bool = False
    tick_count: int = 0


def _serialize_fighter(f: Any) -> dict[str, Any]:
    """Extract the state we broadcast for one fighter."""
    return {
        "x": round(f.x, 1),
        "y": round(f.y, 1),
        "vx": round(f.vx, 1),
        "vy": round(f.vy, 1),
        "facing": f.facing,
        "state": f.state,
        "health": round(f.health, 1),
        "current_attack": f.current_attack,
        "attack_frame": round(f.attack_frame, 1),
        "attack_context": f.attack_context,
        "attack_has_hit": f.attack_has_hit,
        "stun_frames": round(f.stun_frames, 1),
        "dash_timer": round(f.dash_timer, 3),
        "dash_dir": f.dash_dir,
        "is_flipping": f.is_flipping,
        "flip_angle": round(f.flip_angle, 3),
        "jump_count": f.jump_count,
        "flip_count": f.flip_count,
        "grounded": f.grounded,
        "events": list(f.events),
    }


def _build_snapshot(room: RoomLoop) -> dict[str, Any]:
    """Build the authoritative state snapshot broadcast each tick."""
    return {
        "type": "state",
        "tick": room.tick_count,
        "round_timer": round(room.engine.round_timer, 1),
        "round_over": room.engine.round_over,
        "p1": _serialize_fighter(room.engine.p1),
        "p2": _serialize_fighter(room.engine.p2),
    }


def _drain_inputs(player: PlayerConnection) -> tuple[set[str], set[str]]:
    """Drain the input queue and merge into actions/just_pressed sets.

    Multiple buffered input frames are merged: held actions use the latest
    frame, edge-triggered (just_pressed) accumulate across all buffered frames.
    """
    actions: set[str] = set()
    just_pressed: set[str] = set()
    latest_actions: set[str] = set()
    has_input = False

    while not player.input_queue.empty():
        try:
            inp = player.input_queue.get_nowait()
            has_input = True
            latest_actions = set(inp.get("actions", []))
            just_pressed |= set(inp.get("just_pressed", []))
        except asyncio.QueueEmpty:
            break

    if has_input:
        actions = latest_actions

    return actions, just_pressed


# ─────────────────────────────────────────────
# Game Loop Manager
# ─────────────────────────────────────────────

class GameLoopManager:
    """Manages game loops for all active rooms."""

    def __init__(self) -> None:
        self._rooms: dict[str, RoomLoop] = {}

    @property
    def rooms(self) -> dict[str, RoomLoop]:
        """Read-only access to active room loops."""
        return self._rooms

    def create_room_loop(self, code: str) -> RoomLoop:
        """Create a new room loop (does not start the task yet)."""
        if code in self._rooms:
            return self._rooms[code]

        room = RoomLoop(code=code, engine=GameEngine())
        self._rooms[code] = room
        return room

    def get_room_loop(self, code: str) -> RoomLoop | None:
        """Get an existing room loop by code."""
        return self._rooms.get(code)

    def add_player(self, code: str, player: int, socket: WebSocket) -> PlayerConnection:
        """Register a player WebSocket connection for a room."""
        room = self._rooms.get(code)
        if room is None:
            raise ValueError(f"No game loop for room {code}")
        if player not in (1, 2):
            raise ValueError("player must be 1 or 2")

        conn = PlayerConnection(player=player, socket=socket)
        room.players[player] = conn
        return conn

    def start_loop(self, code: str) -> None:
        """Start the game loop asyncio task for a room."""
        room = self._rooms.get(code)
        if room is None:
            raise ValueError(f"No game loop for room {code}")
        if room.task is not None:
            return  # Already running

        room.task = asyncio.create_task(self._run_loop(room))
        print(f"[game-loop:{code}] Started (tick_rate={TICK_RATE}Hz)")

    async def stop_loop(self, code: str) -> None:
        """Stop and clean up a room's game loop."""
        room = self._rooms.pop(code, None)
        if room is None:
            return

        room.stopped = True
        if room.task is not None:
            room.task.cancel()
            try:
                await room.task
            except asyncio.CancelledError:
                pass

        # Close player connections
        for conn in room.players.values():
            conn.connected = False

        print(f"[game-loop:{code}] Stopped after {room.tick_count} ticks")

    async def stop_all(self) -> None:
        """Stop all active game loops. Called during server shutdown."""
        codes = list(self._rooms.keys())
        for code in codes:
            await self.stop_loop(code)

    def remove_player(self, code: str, player: int) -> None:
        """Remove a player connection from a room."""
        room = self._rooms.get(code)
        if room is not None:
            conn = room.players.pop(player, None)
            if conn is not None:
                conn.connected = False

    async def _run_loop(self, room: RoomLoop) -> None:
        """The actual game loop — ticks at TICK_RATE Hz."""
        try:
            while not room.stopped:
                tick_start = time.monotonic()

                # Drain buffered inputs for each player
                p1_actions: set[str] = set()
                p1_pressed: set[str] = set()
                p2_actions: set[str] = set()
                p2_pressed: set[str] = set()

                if 1 in room.players:
                    p1_actions, p1_pressed = _drain_inputs(room.players[1])
                if 2 in room.players:
                    p2_actions, p2_pressed = _drain_inputs(room.players[2])

                # Advance simulation
                room.engine.tick(TICK_INTERVAL, p1_actions, p1_pressed, p2_actions, p2_pressed)
                room.tick_count += 1

                # Build and broadcast state snapshot
                snapshot = _build_snapshot(room)
                msg = json.dumps(snapshot)
                await self._broadcast(room, msg)

                # Check for round over
                if room.engine.round_over:
                    # Send final state and stop
                    end_msg = json.dumps({
                        "type": "round_over",
                        "tick": room.tick_count,
                        "winner": self._determine_winner(room.engine),
                        "p1_health": round(room.engine.p1.health, 1),
                        "p2_health": round(room.engine.p2.health, 1),
                    })
                    await self._broadcast(room, end_msg)
                    print(f"[game-loop:{room.code}] Round over at tick {room.tick_count}")
                    break

                # Sleep to maintain tick rate
                elapsed = time.monotonic() - tick_start
                sleep_time = TICK_INTERVAL - elapsed
                if sleep_time > 0:
                    await asyncio.sleep(sleep_time)

        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"[game-loop:{room.code}] Error: {type(e).__name__}: {e}")
        finally:
            # Clean up — remove from manager if still present
            self._rooms.pop(room.code, None)
            room.stopped = True
            print(f"[game-loop:{room.code}] Loop exited")

    @staticmethod
    async def _broadcast(room: RoomLoop, msg: str) -> None:
        """Send a message to all connected players in a room."""
        disconnected: list[int] = []
        for player_num, conn in room.players.items():
            if not conn.connected:
                disconnected.append(player_num)
                continue
            try:
                await conn.socket.send_data(msg, mode="text")
            except Exception:
                conn.connected = False
                disconnected.append(player_num)

        for p in disconnected:
            room.players.pop(p, None)

    @staticmethod
    def _determine_winner(engine: GameEngine) -> int | None:
        """Return winning player number, or None for draw/timeout."""
        if engine.p1.health <= 0 and engine.p2.health <= 0:
            return None  # Double KO
        if engine.p1.health <= 0:
            return 2
        if engine.p2.health <= 0:
            return 1
        # Timer ran out — higher health wins
        if engine.p1.health > engine.p2.health:
            return 1
        if engine.p2.health > engine.p1.health:
            return 2
        return None  # Draw
