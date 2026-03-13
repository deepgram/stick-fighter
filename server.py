from __future__ import annotations

from dotenv import load_dotenv
load_dotenv()

import asyncio
import base64
import json
import os
import random
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import httpx
import redis.asyncio as aioredis
from deepgram import AsyncDeepgramClient  # Deepgram SDK v6
from deepgram.core.events import EventType
from deepgram.listen.v2.types import ListenV2TurnInfo, ListenV2Connected, ListenV2FatalError
from litestar import Litestar, Request, get, post, websocket
from litestar.connection import WebSocket
from litestar.response import ServerSentEvent
from litestar.response.base import Response
from litestar.static_files import create_static_files_router
from litestar.exceptions import HTTPException

from room_manager import RoomManager
from game_loop import GameLoopManager
from signaling import SignalingManager, ICE_SERVERS

# ─────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────

ROOT = Path(__file__).parent

# ─────────────────────────────────────────────
# Redis / Room Manager lifecycle
# ─────────────────────────────────────────────

room_manager: RoomManager | None = None
game_loop_manager: GameLoopManager | None = None
signaling_manager: SignalingManager | None = None


@asynccontextmanager
async def lifespan(app: Litestar) -> AsyncGenerator[None, None]:
    """Start/stop the Redis connection pool and game loop manager."""
    global room_manager, game_loop_manager, signaling_manager  # noqa: PLW0603
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    pool = aioredis.from_url(redis_url, decode_responses=True)
    room_manager = RoomManager(pool)
    game_loop_manager = GameLoopManager()
    signaling_manager = SignalingManager()
    print(f"[redis] Connected to {redis_url}")
    try:
        yield
    finally:
        if game_loop_manager is not None:
            await game_loop_manager.stop_all()
        game_loop_manager = None
        signaling_manager = None
        await pool.aclose()
        room_manager = None
        print("[redis] Connection closed")

DG_TTS_URL = "https://api.deepgram.com/v1/speak"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"


# ─────────────────────────────────────────────
# STT WebSocket proxy (Deepgram Flux v2)
# ─────────────────────────────────────────────

_STT_KEYTERMS = {
    "forward", "forwards", "back", "backward", "backwards",
    "crouch", "duck", "jump", "somersault", "flip",
    "dash", "punch", "kick", "light", "medium", "heavy", "hard",
}

STT_KEYTERMS = [
    # Movement
    "forward", "back", "crouch", "duck",
    # Jumps
    "jump", "somersault", "flip",
    # Dash
    "dash", "dash forward", "dash back",
    # Attack modifiers
    "light", "medium", "heavy", "hard",
    # Attacks
    "punch", "kick",
    # Multi-word attacks
    "light punch", "medium punch", "heavy punch", "hard punch",
    "light kick", "medium kick", "heavy kick",
    # Combos (high risk / high reward moves)
    "jump forward heavy kick", "jump forward heavy punch",
    "jump jump forward heavy kick", "jump jump forward heavy punch",
    "crouch heavy punch", "crouch heavy kick",
    "dash forward heavy punch", "dash forward heavy kick",
]


@websocket("/ws/stt")
async def stt_proxy(socket: WebSocket) -> None:
    """Proxy mic audio to Deepgram STT (Flux v2) and return transcription results."""
    api_key = os.environ.get("DEEPGRAM_API_KEY")
    if not api_key:
        await socket.close(code=4000, reason="DEEPGRAM_API_KEY not set")
        return

    await socket.accept()
    print("[stt] Browser WebSocket accepted, connecting to Deepgram Flux...")

    client = AsyncDeepgramClient(api_key=api_key)
    audio_chunks = 0

    try:
        async with client.listen.v2.connect(
            model="flux-general-en",
            encoding="linear16",
            sample_rate="16000",
            keyterm=STT_KEYTERMS,
        ) as dg:
            print("[stt] Connected to Deepgram Flux v2")

            # ── Event handler: forward Deepgram events → browser ──
            async def on_message(message) -> None:
                if isinstance(message, ListenV2TurnInfo):
                    event = message.event
                    transcript = message.transcript or ""
                    # Log interesting events
                    if transcript:
                        print(f"[stt] ─── {event} (turn={int(message.turn_index)}) ───")
                        print(f'[stt]   "{transcript}"')
                        words = transcript.lower().split()
                        matched = [w for w in words if w in _STT_KEYTERMS]
                        unmatched = [w for w in words if w not in _STT_KEYTERMS]
                        if matched:
                            print(f"[stt]   actions: {' '.join(matched)}")
                        if unmatched:
                            print(f"[stt]   other:   {' '.join(unmatched)}")
                    elif event in ("EndOfTurn", "EagerEndOfTurn"):
                        print(f"[stt] ─── {event} (empty) ───")

                    # Send to browser as JSON
                    data = {
                        "type": "TurnInfo",
                        "event": event,
                        "turn_index": message.turn_index,
                        "transcript": transcript,
                        "words": [{"word": w.word, "confidence": w.confidence} for w in (message.words or [])],
                    }
                    await socket.send_data(json.dumps(data), mode="text")

                elif isinstance(message, ListenV2Connected):
                    print(f"[stt] Deepgram connected: {message}")

                elif isinstance(message, ListenV2FatalError):
                    print(f"[stt] Deepgram FATAL: {message}")
                    await socket.send_data(json.dumps({
                        "type": "Error",
                        "message": str(message),
                    }), mode="text")

            def on_error(error) -> None:
                print(f"[stt] Deepgram error: {type(error).__name__}: {error}")

            def on_close(_) -> None:
                print("[stt] Deepgram connection closed")

            dg.on(EventType.MESSAGE, on_message)
            dg.on(EventType.ERROR, on_error)
            dg.on(EventType.CLOSE, on_close)

            # ── Audio forwarder: browser → Deepgram ──
            async def forward_audio():
                nonlocal audio_chunks
                try:
                    while True:
                        data = await socket.receive_data(mode="binary")
                        if data:
                            audio_chunks += 1
                            if audio_chunks == 1:
                                print(f"[stt] First audio chunk ({len(data)} bytes)")
                            elif audio_chunks % 100 == 0:
                                print(f"[stt] Audio chunks: {audio_chunks}")
                            await dg.send_media(data)
                except Exception as e:
                    print(f"[stt] Audio forwarding ended: {type(e).__name__}: {e}")

            # Run audio forwarding + SDK listener concurrently
            audio_task = asyncio.create_task(forward_audio())
            try:
                await dg.start_listening()
            finally:
                audio_task.cancel()

    except Exception as e:
        print(f"[stt] Connection error: {type(e).__name__}: {e}")
        try:
            await socket.send_data(json.dumps({
                "type": "Error",
                "message": f"Deepgram connection failed: {e}",
            }), mode="text")
        except Exception:
            pass

    print(f"[stt] Disconnected (sent {audio_chunks} audio chunks)")


# ─────────────────────────────────────────────
# LLM fighter endpoint (Anthropic Claude)
# ─────────────────────────────────────────────

LLM_FIGHTER_SYSTEM = """STICK FIGHTER AI. You control a fighter. Plan your next 5 moves as a JSON array.

COMMANDS: forward, back, crouch, jump, somersault, dash forward, dash back, light punch, medium punch, heavy punch, light kick, medium kick, heavy kick

Commands can be combined: "forward light punch", "jump heavy kick", "dash forward medium punch". Movement + attack combos execute together.

MECHANICS:
- Walk: 200px/s. Dash: 90px burst (600px/s for 0.15s).
- Jump: ~107px high, ~0.69s airtime. Double jump available.
- Somersault: airborne flip attack, max 2 per airtime. Must jump first.
- Block: hold back while grounded. Absorbs hits with reduced stun.
- Health: 200 per fighter. Head hits=2x dmg. Crotch=3x. Limbs=0.5x. Body=1x.
- P1 faces right, P2 faces left. "forward"=toward opponent, "back"=away.

ATTACKS (dmg/startup/active/recovery/range/type):
- light punch: 3/2/2/3/40/high (fastest)
- medium punch: 6/3/2/5/50/high
- heavy punch: 10/5/3/8/55/high (slowest, most damage)
- light kick: 3/2/2/4/50/low
- medium kick: 7/4/2/6/60/mid
- heavy kick: 11/6/3/10/65/low (longest range)

COMBOS (high risk, high reward — plan sequences that set these up!):
- "jump forward heavy kick" — aerial approach, long range, 11dmg body or 22dmg head
- "jump forward heavy punch" — aerial punch, 10dmg body or 20dmg head
- "jump jump forward heavy kick" — double jump attack, harder to block, closes distance fast
- "jump jump forward heavy punch" — double jump punch, surprise from above
- "crouch heavy punch" — low stance into uppercut, 10dmg, avoids high attacks while hitting
- "crouch heavy kick" — sweep from crouch, 11dmg, catches standing opponents low
- "dash forward heavy punch" — rush in with power hit, 10dmg, punishes idle opponents
- "dash forward heavy kick" — dash into sweep, 11dmg, longest range surprise

STRATEGY:
- Think in sequences: approach → position → attack → recover → reposition.
- Close distance first (forward/dash forward), then strike.
- Use light attacks when close (fast, safe). Heavy when opponent is in recovery/stun.
- Plan combo setups: e.g. ["dash forward", "forward", "jump forward heavy kick", "back", "crouch heavy punch"]
- Crouch to avoid high attacks. Jump to avoid low kicks.
- Block (back) when you expect the opponent to attack.
- If low health, plan defensively. If opponent is low, press advantage aggressively.
- Vary your plan — mix movement, positioning, and different attack types.

LEARNING:
- You'll see RESULT from your previous plan's outcome: total damage dealt and taken.
- BEST: shows your most effective tactics ranked by net damage per use.
- Favor your BEST tactics but ALWAYS mix up to stay unpredictable.
- If previous plan was ineffective, try a completely different approach.

State format: T<timer> | ME:<x>,<y> hp<health> <state> | OPP:<x>,<y> hp<health> <state> | D<distance> | RESULT:<outcome> | BEST:<tactics>
States: idle, walk, jump, crouch, attack, hitstun, blockstun. "air" suffix = airborne.

RESPOND WITH ONLY A JSON ARRAY OF 5 MOVES. Example: ["dash forward", "forward", "jump forward heavy kick", "back", "light punch"]
No explanation, no markdown, no code fences. Just the JSON array."""


@post("/api/llm/command")
async def llm_command(data: dict[str, Any]) -> dict:
    """Send game state to LLM, return a 5-move plan. Supports multiple providers."""
    provider = data.get("provider", "anthropic")
    messages = data.get("messages", [])

    # Log outgoing request
    print(f"[llm-fighter:{provider}] ─── REQUEST ───")
    print(f"[llm-fighter:{provider}] messages ({len(messages)}):")
    for msg in messages[-4:]:
        role = msg.get("role", "?")
        content = msg.get("content", "")
        print(f"[llm-fighter:{provider}]   {role}: {content}")
    if len(messages) > 4:
        print(f"[llm-fighter:{provider}]   ... ({len(messages) - 4} earlier messages omitted)")

    if provider == "openai":
        text = await _llm_openai(messages)
    else:
        text = await _llm_anthropic(messages)

    # Parse JSON array of moves
    raw = text.strip()
    print(f"[llm-fighter:{provider}] raw: \"{raw}\"")

    try:
        # Strip markdown code fences if present
        clean = raw
        if clean.startswith("```"):
            clean = clean.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        plan = json.loads(clean)
        if not isinstance(plan, list):
            plan = [str(plan)]
        # Normalize: lowercase, strip quotes/punctuation
        plan = [str(m).strip().strip('"\'').lower().strip('.') for m in plan if m]
    except (json.JSONDecodeError, ValueError):
        # Fallback: treat as single command (backward compat)
        command = raw.strip('"\'').lower().strip('.')
        plan = [command] if command else ["forward"]
        print(f"[llm-fighter:{provider}] JSON parse failed, fallback: {plan}")

    print(f"[llm-fighter:{provider}] plan: {plan}")
    print(f"[llm-fighter:{provider}] ──────────────")
    return {"plan": plan}


async def _llm_anthropic(messages: list[dict]) -> str:
    """Call Anthropic Claude Haiku 4.5."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not set")

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            ANTHROPIC_URL,
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 150,
                "system": LLM_FIGHTER_SYSTEM,
                "messages": messages,
            },
        )

    if resp.status_code != 200:
        print(f"[llm-fighter:anthropic] ─── ERROR {resp.status_code} ───")
        print(f"[llm-fighter:anthropic] {resp.text}")
        raise HTTPException(status_code=502, detail="Anthropic request failed")

    result = resp.json()
    print("[llm-fighter:anthropic] ─── RESPONSE ───")
    print(f"[llm-fighter:anthropic] model: {result.get('model')}")
    print(f"[llm-fighter:anthropic] usage: in={result.get('usage', {}).get('input_tokens')} out={result.get('usage', {}).get('output_tokens')}")
    print(f"[llm-fighter:anthropic] stop: {result.get('stop_reason')}")

    text = ""
    for block in result.get("content", []):
        if block.get("type") == "text":
            text += block["text"]
    return text


async def _llm_openai(messages: list[dict]) -> str:
    """Call OpenAI GPT-4o mini."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not set")

    # OpenAI uses system message in the messages array
    oai_messages = [{"role": "system", "content": LLM_FIGHTER_SYSTEM}] + messages

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            OPENAI_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "gpt-4o-mini",
                "max_tokens": 150,
                "messages": oai_messages,
            },
        )

    if resp.status_code != 200:
        print(f"[llm-fighter:openai] ─── ERROR {resp.status_code} ───")
        print(f"[llm-fighter:openai] {resp.text}")
        raise HTTPException(status_code=502, detail="OpenAI request failed")

    result = resp.json()
    print("[llm-fighter:openai] ─── RESPONSE ───")
    print(f"[llm-fighter:openai] model: {result.get('model')}")
    usage = result.get("usage", {})
    print(f"[llm-fighter:openai] usage: in={usage.get('prompt_tokens')} out={usage.get('completion_tokens')}")
    print(f"[llm-fighter:openai] stop: {result.get('choices', [{}])[0].get('finish_reason')}")

    choices = result.get("choices", [])
    if choices:
        return choices[0].get("message", {}).get("content", "")
    return ""


# ─────────────────────────────────────────────
# Voice LLM endpoint (Anthropic Claude)
# ─────────────────────────────────────────────

@post("/api/voice/llm")
async def voice_llm(data: dict[str, Any]) -> dict:
    """Send conversation to Anthropic and return the response text."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not set")

    messages = data.get("messages", [])
    system = data.get("system", "")

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            ANTHROPIC_URL,
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 100,
                "system": system,
                "messages": messages,
            },
        )

    if resp.status_code != 200:
        print(f"[llm] Anthropic error {resp.status_code}: {resp.text}")
        raise HTTPException(status_code=502, detail="LLM request failed")

    result = resp.json()
    text = ""
    for block in result.get("content", []):
        if block.get("type") == "text":
            text += block["text"]

    return {"text": text}


# ─────────────────────────────────────────────
# TTS endpoint (Deepgram Aura 2)
# ─────────────────────────────────────────────

@post("/api/voice/tts")
async def voice_tts(data: dict[str, Any]) -> Response:
    """Convert text to speech via Deepgram TTS, return audio bytes."""
    api_key = os.environ.get("DEEPGRAM_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="DEEPGRAM_API_KEY not set")

    text = data.get("text", "")
    if not text:
        raise HTTPException(status_code=400, detail="text required")

    tts_url = f"{DG_TTS_URL}?model=aura-2-thalia-en&encoding=linear16&sample_rate=24000&container=none"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            tts_url,
            headers={
                "Authorization": f"Token {api_key}",
                "Content-Type": "application/json",
            },
            json={"text": text},
        )

    if resp.status_code != 200:
        print(f"[tts] Deepgram TTS error {resp.status_code}: {resp.text}")
        raise HTTPException(status_code=502, detail="TTS request failed")

    return Response(
        content=resp.content,
        media_type="audio/raw",
        headers={"Content-Type": "audio/raw"},
    )


# ─────────────────────────────────────────────
# LLM mode (SSE-based, random commands)
# ─────────────────────────────────────────────

@dataclass
class LLMSession:
    id: str
    player: int
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    closed: bool = False


llm_sessions: dict[str, LLMSession] = {}


async def query_llm(game_state: Any) -> str:
    # Weighted towards passive/defensive actions so voice players can keep up
    commands = [
        "forward", "forward", "forward", "forward", "forward",
        "forward", "forward", "forward",
        "back", "back", "back",
        "dash forward", "dash back",
        "crouch",
        "jump",
        "light punch", "light kick",
        "forward punch", "forward kick",
        "medium punch",
    ]
    return random.choice(commands)


async def send_sse(session: LLMSession, data: Any) -> None:
    if not session.closed:
        await session.queue.put(data)


# ─────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────

@get("/health")
async def health() -> dict:
    return {"status": "ok"}


@get("/")
async def index_route() -> Response:
    html = (ROOT / "index.html").read_text()
    return Response(content=html, media_type="text/html")


@get("/room/{code:str}")
async def room_route(code: str) -> Response:
    """Serve the game page for a room join link (JS reads the URL to detect the room code)."""
    html = (ROOT / "index.html").read_text()
    return Response(content=html, media_type="text/html")


@post("/api/room/create")
async def room_create(request: Request) -> dict[str, str]:
    """Create a new multiplayer room. Returns the room code and shareable URL."""
    if room_manager is None:
        raise HTTPException(status_code=503, detail="Room manager not available")

    player_id = str(uuid.uuid4())
    room = await room_manager.create_room(player_id)

    # Build shareable URL from request origin
    base = str(request.base_url).rstrip("/")
    code = room["code"]

    return {
        "code": code,
        "playerId": player_id,
        "url": f"{base}/room/{code}",
    }


# ─────────────────────────────────────────────
# WebRTC signaling
# ─────────────────────────────────────────────


def _resolve_player_num(room_data: dict[str, str], player_id: str) -> int:
    """Determine player number (1 or 2) from a room's data and a player ID.

    Raises HTTPException if the player doesn't belong to this room.
    """
    if room_data["p1_id"] == player_id:
        return 1
    if room_data["p2_id"] == player_id:
        return 2
    raise HTTPException(status_code=403, detail="Player not in this room")


@get("/api/rtc/config")
async def rtc_config() -> dict[str, Any]:
    """Return WebRTC ICE server configuration and fallback strategy.

    Clients use this to configure RTCPeerConnection. If WebRTC fails,
    clients fall back to server-only relay via /ws/game/{code}.
    """
    return {
        "iceServers": ICE_SERVERS,
        "fallback": "server-relay",
    }


@post("/api/room/signal")
async def signal_send(data: dict[str, Any]) -> dict[str, bool]:
    """Relay a WebRTC signal (SDP offer/answer or ICE candidate) to the other peer.

    Validates the room exists in Redis and the sender belongs to it.

    Request body:
        room: str — room code
        playerId: str — sender's player ID (from room create/join)
        signal: dict — the WebRTC signal payload (type + sdp/candidate data)
    """
    if room_manager is None or signaling_manager is None:
        raise HTTPException(status_code=503, detail="Service not available")

    room_code: str = data.get("room", "")
    player_id: str = data.get("playerId", "")
    signal: dict[str, Any] = data.get("signal", {})

    if not room_code or not player_id or not signal:
        raise HTTPException(status_code=400, detail="room, playerId, and signal are required")

    # Validate room in Redis and resolve player number
    room_data = await room_manager.get_room(room_code)
    if room_data is None:
        raise HTTPException(status_code=404, detail="Room not found")

    from_player = _resolve_player_num(room_data, player_id)

    # Relay signal to the other player's SSE queue
    relayed = await signaling_manager.relay(room_code, from_player, signal)
    print(f"[signal:{room_code}] P{from_player} → P{2 if from_player == 1 else 1}: {signal.get('type', '?')} (relayed={relayed})")

    # Refresh room TTL on signaling activity
    await room_manager.refresh_ttl(room_code)

    return {"relayed": relayed}


@get("/api/room/signal/listen")
async def signal_listen(room: str, player_id: str) -> ServerSentEvent:
    """SSE stream for receiving WebRTC signals from the other peer.

    Query params:
        room: str — room code
        player_id: str — this player's ID (from room create/join)

    Sends ICE server config on connect, then relays signals as they arrive.
    """
    if room_manager is None or signaling_manager is None:
        raise HTTPException(status_code=503, detail="Service not available")

    # Validate room in Redis
    room_data = await room_manager.get_room(room)
    if room_data is None:
        raise HTTPException(status_code=404, detail="Room not found")

    player_num = _resolve_player_num(room_data, player_id)

    # Register signaling session
    session = signaling_manager.connect(room, player_num)
    print(f"[signal:{room}] P{player_num} SSE connected")

    async def event_generator() -> AsyncGenerator[dict[str, Any], None]:
        # First message includes ICE server config so the client can
        # create RTCPeerConnection immediately
        yield {"data": json.dumps({
            "type": "connected",
            "player": player_num,
            "iceServers": ICE_SERVERS,
        })}
        try:
            while not session.closed:
                try:
                    data = await asyncio.wait_for(session.queue.get(), timeout=30)
                    yield {"data": json.dumps(data)}
                except asyncio.TimeoutError:
                    yield {"comment": "keepalive"}
        finally:
            signaling_manager.disconnect(room, player_num)
            print(f"[signal:{room}] P{player_num} SSE disconnected")

    return ServerSentEvent(event_generator())


@get("/api/session/connect")
async def session_connect(mode: str | None = None, player: int = 1) -> ServerSentEvent:
    if mode != "llm":
        raise HTTPException(status_code=400, detail="mode must be 'llm'")

    session = LLMSession(id=str(uuid.uuid4()), player=player)
    llm_sessions[session.id] = session
    print(f"[llm:{session.id}] Session created for player {player}")

    async def event_generator() -> AsyncGenerator[dict[str, Any], None]:
        yield {"data": json.dumps({"type": "connected", "sessionId": session.id})}
        try:
            while not session.closed:
                try:
                    data = await asyncio.wait_for(session.queue.get(), timeout=30)
                    yield {"data": json.dumps(data)}
                except asyncio.TimeoutError:
                    yield {"comment": "keepalive"}
        finally:
            session.closed = True
            llm_sessions.pop(session.id, None)
            print(f"[llm:{session.id}] SSE disconnected, session cleaned up")

    return ServerSentEvent(event_generator())


@post("/api/session/send")
async def session_send(session: str | None = None, data: Any = None) -> dict:
    if not session:
        raise HTTPException(status_code=400, detail="session required")

    sess = llm_sessions.get(session)
    if not sess:
        raise HTTPException(status_code=404, detail="session not found")

    command = await query_llm(data)
    await send_sse(sess, {"type": "command", "command": command})
    return {"ok": True}


@post("/api/session/close")
async def session_close(session: str | None = None) -> dict:
    if session:
        sess = llm_sessions.get(session)
        if sess:
            sess.closed = True
            llm_sessions.pop(session, None)
            print(f"[llm:{session}] Session closed")
    return {"ok": True}


# ─────────────────────────────────────────────
# Phone mode (Twilio → Deepgram STT bridge)
# ─────────────────────────────────────────────

@dataclass
class PhoneSession:
    id: str
    player: int
    phone_number: str
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    closed: bool = False


phone_sessions: dict[str, PhoneSession] = {}
phone_number_to_session: dict[str, str] = {}


def _cleanup_phone_session(session_id: str) -> None:
    sess = phone_sessions.pop(session_id, None)
    if sess:
        sess.closed = True
        phone_number_to_session.pop(sess.phone_number, None)
        print(f"[phone:{session_id}] Session cleaned up, released {sess.phone_number}")


@post("/api/phone/allocate")
async def phone_allocate(data: dict[str, Any]) -> dict:
    """Allocate a Twilio phone number for a player."""
    player = data.get("player", 1)
    numbers = [n.strip() for n in os.environ.get("TWILIO_PHONE_NUMBERS", "").split(",") if n.strip()]
    for num in numbers:
        if num not in phone_number_to_session:
            session = PhoneSession(
                id=str(uuid.uuid4()),
                player=player,
                phone_number=num,
            )
            phone_sessions[session.id] = session
            phone_number_to_session[num] = session.id
            print(f"[phone:{session.id}] Allocated {num} for player {player}")
            return {"sessionId": session.id, "phoneNumber": num}
    raise HTTPException(status_code=409, detail="No phone numbers available")


@get("/api/phone/connect")
async def phone_connect(session: str) -> ServerSentEvent:
    """SSE stream for phone transcript events."""
    sess = phone_sessions.get(session)
    if not sess:
        raise HTTPException(status_code=404, detail="session not found")

    async def event_generator() -> AsyncGenerator[dict[str, Any], None]:
        yield {"data": json.dumps({"type": "connected", "sessionId": sess.id})}
        try:
            while not sess.closed:
                try:
                    data = await asyncio.wait_for(sess.queue.get(), timeout=30)
                    yield {"data": json.dumps(data)}
                except asyncio.TimeoutError:
                    yield {"comment": "keepalive"}
        finally:
            sess.closed = True
            _cleanup_phone_session(sess.id)
            print(f"[phone:{sess.id}] SSE disconnected, session cleaned up")

    return ServerSentEvent(event_generator())


@post("/api/twilio/incoming")
async def twilio_incoming(request: Request) -> Response:
    """TwiML webhook — Twilio calls this when someone dials a number."""
    body_bytes = await request.body()
    form = parse_qs(body_bytes.decode())
    called_number = form.get("To", [""])[0]
    session_id = phone_number_to_session.get(called_number)
    base_url = os.environ.get("BASE_URL", "").rstrip("/")
    print(f"[twilio] Incoming call to {called_number}, session={session_id}")

    if not session_id or session_id not in phone_sessions:
        twiml = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>No game in progress. Goodbye.</Say><Hangup/></Response>'
        return Response(content=twiml, media_type="application/xml")

    ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://")
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Connected to Stick Fighter. Shout your commands!</Say>
    <Connect>
        <Stream url="{ws_url}/ws/twilio-stream">
            <Parameter name="sessionId" value="{session_id}" />
        </Stream>
    </Connect>
</Response>"""
    return Response(content=twiml, media_type="application/xml")


@websocket("/ws/twilio-stream")
async def twilio_stream(socket: WebSocket) -> None:
    """Bridge Twilio Media Streams → Deepgram Flux v2 STT."""
    await socket.accept()
    sess = None
    audio_chunks = 0

    try:
        # Wait for Twilio "start" event to get session info
        while True:
            raw = await socket.receive_data(mode="text")
            msg = json.loads(raw)
            event = msg.get("event")
            if event == "connected":
                print("[twilio-stream] Twilio WebSocket connected")
                continue
            elif event == "start":
                params = msg.get("start", {}).get("customParameters", {})
                session_id = params.get("sessionId")
                sess = phone_sessions.get(session_id)
                if not sess:
                    print(f"[twilio-stream] No session for {session_id}")
                    return
                print(f"[twilio-stream] Stream started for session {session_id}")
                await sess.queue.put({"type": "call_connected"})
                break

        # Connect to Deepgram Flux v2 — mulaw/8kHz directly (no conversion needed)
        api_key = os.environ.get("DEEPGRAM_API_KEY")
        client = AsyncDeepgramClient(api_key=api_key)

        async with client.listen.v2.connect(
            model="flux-general-en",
            encoding="mulaw",
            sample_rate="8000",
            keyterm=STT_KEYTERMS,
        ) as dg:
            print("[twilio-stream] Connected to Deepgram Flux v2 (mulaw/8kHz)")

            async def on_message(message) -> None:
                if isinstance(message, ListenV2TurnInfo):
                    transcript = message.transcript or ""
                    if transcript:
                        print(f'[twilio-stream] {message.event}: "{transcript}"')
                    await sess.queue.put({
                        "type": "TurnInfo",
                        "event": message.event,
                        "turn_index": message.turn_index,
                        "transcript": transcript,
                    })
                elif isinstance(message, ListenV2Connected):
                    print(f"[twilio-stream] Deepgram connected: {message}")
                elif isinstance(message, ListenV2FatalError):
                    print(f"[twilio-stream] Deepgram FATAL: {message}")

            def on_error(error) -> None:
                print(f"[twilio-stream] Deepgram error: {type(error).__name__}: {error}")

            dg.on(EventType.MESSAGE, on_message)
            dg.on(EventType.ERROR, on_error)

            # Forward Twilio audio → Deepgram (base64 decode only, mulaw passthrough)
            async def forward_twilio_audio():
                nonlocal audio_chunks
                try:
                    while True:
                        raw = await socket.receive_data(mode="text")
                        msg = json.loads(raw)
                        evt = msg.get("event")
                        if evt == "media":
                            payload = msg["media"]["payload"]
                            audio_bytes = base64.b64decode(payload)
                            audio_chunks += 1
                            if audio_chunks == 1:
                                print(f"[twilio-stream] First audio chunk ({len(audio_bytes)} bytes)")
                            elif audio_chunks % 100 == 0:
                                print(f"[twilio-stream] Audio chunks: {audio_chunks}")
                            await dg.send_media(audio_bytes)
                        elif evt == "stop":
                            print("[twilio-stream] Twilio stream stopped")
                            break
                except Exception as e:
                    print(f"[twilio-stream] Audio forwarding ended: {type(e).__name__}: {e}")
                finally:
                    try:
                        await dg.send_close_stream()
                    except Exception:
                        pass

            audio_task = asyncio.create_task(forward_twilio_audio())
            try:
                await dg.start_listening()
            finally:
                audio_task.cancel()

    except Exception as e:
        print(f"[twilio-stream] Error: {type(e).__name__}: {e}")
    finally:
        if sess:
            await sess.queue.put({"type": "call_disconnected"})
        print(f"[twilio-stream] Disconnected (sent {audio_chunks} audio chunks)")


@post("/api/phone/close")
async def phone_close(data: dict[str, Any]) -> dict:
    """Release a phone session and its number."""
    session_id = data.get("session")
    if session_id:
        _cleanup_phone_session(session_id)
    return {"ok": True}


# ─────────────────────────────────────────────
# Game WebSocket (multiplayer input + state sync)
# ─────────────────────────────────────────────

@websocket("/ws/game/{code:str}")
async def game_ws(socket: WebSocket, code: str) -> None:
    """WebSocket for multiplayer game input and authoritative state broadcast.

    Query params:
        player: 1 or 2

    Client sends: {"actions": ["left","down"], "just_pressed": ["heavyKick"]}
    Server sends: state snapshots at 20Hz + round_over events
    """
    if game_loop_manager is None:
        await socket.close(code=4000, reason="Game loop manager not initialized")
        return

    # Parse player number from query string
    player_str = socket.query_params.get("player", "0")
    try:
        player = int(player_str)
    except (ValueError, TypeError):
        await socket.close(code=4001, reason="Invalid player number")
        return

    if player not in (1, 2):
        await socket.close(code=4001, reason="player must be 1 or 2")
        return

    await socket.accept()
    print(f"[game-ws:{code}] Player {player} connected")

    # Get or create the room loop
    room = game_loop_manager.get_room_loop(code)
    if room is None:
        room = game_loop_manager.create_room_loop(code)

    # Register this player
    conn = game_loop_manager.add_player(code, player, socket)

    # Start the game loop if both players are connected
    if len(room.players) >= 2 and room.task is None:
        game_loop_manager.start_loop(code)
    elif len(room.players) < 2:
        # Notify player they're waiting
        await socket.send_data(json.dumps({"type": "waiting", "player": player}), mode="text")

    try:
        while conn.connected and not room.stopped:
            raw = await socket.receive_data(mode="text")
            msg = json.loads(raw)

            if msg.get("type") == "input":
                await conn.input_queue.put({
                    "actions": msg.get("actions", []),
                    "just_pressed": msg.get("just_pressed", []),
                })

                # Refresh room TTL on input activity
                if room_manager is not None:
                    await room_manager.refresh_ttl(code)

            elif msg.get("type") == "start" and room.task is None:
                # Allow explicit start (e.g., after both players ready)
                if len(room.players) >= 2:
                    game_loop_manager.start_loop(code)

    except Exception as e:
        print(f"[game-ws:{code}] Player {player} disconnected: {type(e).__name__}")
    finally:
        game_loop_manager.remove_player(code, player)
        # If no players left, stop the loop
        if room and not room.players:
            await game_loop_manager.stop_loop(code)
        print(f"[game-ws:{code}] Player {player} cleaned up")


# ─────────────────────────────────────────────
# App
# ─────────────────────────────────────────────

app = Litestar(
    lifespan=[lifespan],
    route_handlers=[
        health,
        index_route,
        room_route,
        room_create,
        rtc_config,
        signal_send,
        signal_listen,
        stt_proxy,
        llm_command,
        voice_llm,
        voice_tts,
        session_connect,
        session_send,
        session_close,
        phone_allocate,
        phone_connect,
        twilio_incoming,
        twilio_stream,
        phone_close,
        game_ws,
        create_static_files_router(path="/src", directories=[ROOT / "src"]),
        create_static_files_router(path="/assets", directories=[ROOT / "assets"]),
    ],
)
