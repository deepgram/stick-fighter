"""WebRTC signaling relay for multiplayer rooms.

Manages signal sessions per room. Each player connects via SSE to receive
signals (SDP offers/answers, ICE candidates) sent by the other player via
POST. The signaling server brokers the WebRTC introduction — actual game
data flows peer-to-peer over the data channel once established.

Fallback: If WebRTC fails, clients fall back to server-only relay via the
existing ``/ws/game/{code}`` WebSocket (inputs to server, authoritative
state broadcast back). This is already the default path — WebRTC is an
optimization layer on top.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any


# ─────────────────────────────────────────────
# ICE Server Configuration
# ─────────────────────────────────────────────

# Public STUN servers for NAT traversal. These are free and low-latency.
# TURN servers can be added here if needed for restrictive networks.
ICE_SERVERS: list[dict[str, str | list[str]]] = [
    {"urls": "stun:stun.l.google.com:19302"},
    {"urls": "stun:stun1.l.google.com:19302"},
]


# ─────────────────────────────────────────────
# Signal Session
# ─────────────────────────────────────────────

@dataclass
class SignalSession:
    """A player's signaling session within a room."""

    room_code: str
    player: int  # 1 or 2
    queue: asyncio.Queue[dict[str, Any]] = field(default_factory=asyncio.Queue)
    closed: bool = False


# ─────────────────────────────────────────────
# Signaling Manager
# ─────────────────────────────────────────────

class SignalingManager:
    """Manages WebRTC signaling sessions for all active rooms.

    Each room has up to two signal sessions (one per player). Signals from
    one player are relayed to the other player's SSE queue.
    """

    def __init__(self) -> None:
        # room_code -> {player_num -> SignalSession}
        self._sessions: dict[str, dict[int, SignalSession]] = {}

    @property
    def sessions(self) -> dict[str, dict[int, SignalSession]]:
        """Read-only access to active sessions (for testing)."""
        return self._sessions

    def connect(self, room_code: str, player: int) -> SignalSession:
        """Register a player's signaling session. Returns the new session.

        If the player already had a session, the old one is closed first.
        """
        if room_code not in self._sessions:
            self._sessions[room_code] = {}

        # Close existing session if reconnecting
        existing = self._sessions[room_code].get(player)
        if existing is not None:
            existing.closed = True

        session = SignalSession(room_code=room_code, player=player)
        self._sessions[room_code][player] = session
        return session

    def disconnect(self, room_code: str, player: int) -> None:
        """Remove a player's signaling session."""
        room = self._sessions.get(room_code)
        if room is not None:
            session = room.pop(player, None)
            if session is not None:
                session.closed = True
            if not room:
                del self._sessions[room_code]

    async def relay(self, room_code: str, from_player: int, signal: dict[str, Any]) -> bool:
        """Relay a signal from one player to the other in the same room.

        Returns True if the signal was queued for delivery, False if no
        recipient is connected.
        """
        room = self._sessions.get(room_code)
        if not room:
            return False

        # Route to the other player
        target = 2 if from_player == 1 else 1
        session = room.get(target)
        if session is None or session.closed:
            return False

        await session.queue.put(signal)
        return True

    def get_session(self, room_code: str, player: int) -> SignalSession | None:
        """Get an active signaling session."""
        room = self._sessions.get(room_code)
        if room is not None:
            return room.get(player)
        return None

    def cleanup_room(self, room_code: str) -> None:
        """Clean up all signaling sessions for a room."""
        room = self._sessions.pop(room_code, None)
        if room is not None:
            for session in room.values():
                session.closed = True
