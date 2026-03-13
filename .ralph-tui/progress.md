# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

- **Screen navigation**: All screens are sibling divs in index.html, toggled via `.hidden` class. `showScreen(name)` in main.js hides all screens and shows the target. State is tracked in a `state` variable.
- **URL routing**: Server serves index.html for all page routes (e.g., `/room/{code}`). JS reads `window.location.pathname` via `src/router.js` to detect the route on load.
- **Script paths**: Use absolute paths (`/src/main.js`) not relative (`./src/main.js`) in index.html to support nested URL routes like `/room/:code`.
- **Test infrastructure**: Python uses pytest + ruff + mypy (dev dependency group in pyproject.toml). JS uses Jest with ESM (`"type": "module"` in package.json, requires `NODE_OPTIONS=--experimental-vm-modules`).
- **Litestar test client**: Use `from litestar.testing import TestClient` with `with TestClient(app=app) as client:` for route tests.
- **Jest ESM**: `npx jest --experimental-vm-modules` doesn't work (that's a Node flag, not Jest). Use `node --experimental-vm-modules node_modules/.bin/jest` or `NODE_OPTIONS='--experimental-vm-modules' npx jest`.
- **Python game engine**: `game_engine/` package mirrors JS client logic. Import from `game_engine` for `Fighter`, `GameEngine`, `Actions`, `ATTACK_DATA`. `GameEngine.tick()` is the headless equivalent of `Game._update()`.
- **Redis async typing**: `redis.asyncio.Redis` methods return `Awaitable[T] | T` unions — mypy can't narrow these, so `# type: ignore[misc]` is needed on `await` calls. Standard practice for redis-py async code.
- **fakeredis for testing**: Use `fakeredis.aioredis.FakeRedis(decode_responses=True)` as a drop-in for `redis.asyncio.Redis` in tests. No real Redis needed.
- **Room manager pattern**: `room_manager.py` encapsulates all Redis room ops. Import `RoomManager` + `generate_room_code`. Server creates instance via lifespan context manager.
- **Game loop pattern**: `game_loop.py` manages per-room asyncio tasks. `GameLoopManager` creates/starts/stops room loops. Each `RoomLoop` has a `GameEngine`, player connections with input queues, and broadcasts state at 20Hz. Mock WebSockets with `MagicMock` + `AsyncMock(send_data=...)` for testing.
- **TestClient + global state**: Litestar's `TestClient` runs the app lifespan on `__enter__()`, which sets globals like `room_manager`. To test endpoints with fakeredis, inject the mock *after* `with TestClient(app=app) as client:` — not before — or the lifespan will overwrite it.
- **fakeredis shared server for sync+async**: Use `fakeredis.FakeServer()` shared between sync `FakeRedis` and async `FakeRedis(server=...)` to manipulate test data from sync code without event loop conflicts. Essential when sync tests need to set up room state (e.g., joining P2) before hitting endpoints.
- **Signaling pattern**: `signaling.py` manages in-memory signal sessions per room. POST `/api/room/signal` relays SDP/ICE to peer via SSE. GET `/api/room/signal/listen` delivers signals. GET `/api/rtc/config` returns STUN/TURN config. Player identity validated against Redis room hash (`p1_id`/`p2_id`).

---

## 2026-03-13 - stick-fighter-d4c.1
- Implemented Redis room state management for multiplayer rooms
- RoomManager class with create/join/get/delete rooms, controller selection, status transitions, TTL refresh
- Room data stored as Redis hash with fields: code, p1_id, p2_id, p1_controller, p2_controller, status, created_at
- 5-minute TTL auto-expiry, refreshed on every activity
- Status state machine: waiting → selecting → fighting → finished (invalid transitions rejected)
- 3-word room code generator (adjective-noun-verb, 13k+ combinations)
- Litestar lifespan context manager for Redis connection lifecycle
- 36 async tests using fakeredis (no real Redis needed)
- Files changed:
  - `room_manager.py` — New: RoomManager class, word lists, code generation, all CRUD + transition ops
  - `server.py` — Added redis.asyncio import, RoomManager import, lifespan context manager, lifespan=[lifespan] on app
  - `pyproject.toml` — Added redis[hiredis] dep, pytest-asyncio + fakeredis dev deps
  - `tests/test_room_manager.py` — New: 36 tests across 8 test classes (create, get, join, controller, transitions, TTL, delete, structure)
- **Learnings:**
  - redis-py async returns `Awaitable[T] | T` unions — mypy needs `# type: ignore[misc]` on await calls
  - fakeredis.aioredis.FakeRedis is a perfect drop-in for redis.asyncio.Redis in tests
  - Litestar `lifespan` parameter takes a list of async context managers
  - pytest-asyncio 1.x uses `mode=Mode.STRICT` — fixtures need `@pytest_asyncio.fixture` decorator
---

## 2026-03-13 - stick-fighter-d4c.3
- Implemented landing page with mode selection (Multiplayer / Single Player)
- Added multiplayer menu with Create Room, Join Room, Matchmaking options
- Added Join Room screen with code input field
- Added client-side URL routing (`/room/:code` → auto-fills join room)
- Added server-side `/room/{code}` route in Litestar
- Set up full test infrastructure: pytest, ruff, mypy, Jest
- Files changed:
  - `index.html` — Added landing, multiplayer-menu, join-room screens + CSS; fixed script src to absolute path
  - `src/main.js` — Refactored to multi-screen state machine with `showScreen()`, added click/keyboard handlers for new screens, URL routing on load
  - `src/router.js` — New module: parses URL pathname, returns `{ type: 'home' | 'room', code? }`
  - `server.py` — Added `/room/{code:str}` route, registered in app, fixed two F541 ruff warnings
  - `pyproject.toml` — Added dev dependency group (pytest, ruff, mypy), tool configs
  - `package.json` — New: jest + @jest/globals devDependencies, ESM test script
  - `jest.config.js` — New: ESM-compatible Jest config
  - `tests/test_server.py` — New: 4 tests (health, index, room route)
  - `tests/router.test.js` — New: 6 tests (parseRoute for home, room codes, edge cases)
  - `tests/__init__.py` — New: empty init for test package
- **Learnings:**
  - `load_dotenv()` before imports causes ruff E402; ignore in config since it's intentional
  - Script `src` attributes must be absolute paths when using client-side URL routing with nested paths
  - Jest ESM requires Node flag `--experimental-vm-modules`, not a Jest CLI flag
  - Litestar `TestClient` is straightforward — no special setup needed for route testing
---

## 2026-03-13 - stick-fighter-d4c.2
- Ported core game logic from JavaScript to Python `game_engine/` package
- Fighter class with identical physics, state machine, skeleton, hitbox/hurtbox system
- GameEngine class with headless game loop, facing updates, clash detection, hit detection
- 65 unit tests covering physics, state transitions, combat, dash, hit detection, determinism
- Files changed:
  - `game_engine/__init__.py` — Package init, public API exports
  - `game_engine/actions.py` — Actions StrEnum + AttackData dataclass + ATTACK_DATA dict
  - `game_engine/fighter.py` — Fighter class (physics, state machine, 7 skeleton builders, hitbox/hurtbox system)
  - `game_engine/game.py` — GameEngine class (headless game loop, clash/hit detection)
  - `tests/test_game_engine.py` — 65 tests across 8 test classes
- **Learnings:**
  - StrEnum allows plain string lookup in dicts/sets (`"lightPunch" in ATTACK_ACTIONS` works)
  - mypy infers `int` from `f * 6` (int * int); must use `float()` when other branches assign `float` to same variable
  - Skeleton building is needed server-side for hitbox computation (not just rendering)
  - `_localToWorld` flip rotation must be ported exactly for somersault hitbox accuracy
---

## 2026-03-13 - stick-fighter-d4c.6
- Implemented server game loop with input processing and state broadcast
- GameLoopManager runs one asyncio task per active room at 20Hz tick rate
- Player inputs arrive via WebSocket, buffered in asyncio.Queues, consumed each tick
- Input merging: held actions use latest frame, edge-triggered accumulate across buffered frames
- Authoritative state snapshots broadcast to all connected players each tick
- State includes: fighter positions, health, velocity, state, attacks, stun, dash, flipping, events
- Round over detection with winner determination (KO, timeout, draw)
- Disconnected players auto-removed; empty rooms auto-cleaned
- WebSocket endpoint `/ws/game/{code}?player=1|2` for multiplayer game sessions
- GameLoopManager integrated into server lifespan (created on startup, stop_all on shutdown)
- 34 new tests covering: input draining, serialization, snapshots, CRUD, lifecycle, tick behavior, determinism, winner logic
- Files changed:
  - `game_loop.py` — New: GameLoopManager, RoomLoop, PlayerConnection, input draining, state serialization, 20Hz broadcast loop
  - `server.py` — Added GameLoopManager import, global instance, lifespan integration, `/ws/game/{code}` WebSocket endpoint, registered in app routes
  - `tests/test_game_loop.py` — New: 34 tests across 9 test classes
- **Learnings:**
  - `asyncio.Queue.get_nowait()` in a while loop is the cleanest way to drain buffered inputs without blocking
  - Mock WebSockets for testing: `MagicMock()` with `send_data = AsyncMock()` — no need for real server
  - `time.monotonic()` for tick timing is more reliable than `time.time()` (immune to system clock changes)
  - Input merging strategy matters: held actions (directional) use latest frame, edge-triggered (attacks) must accumulate to prevent dropped inputs
---

## 2026-03-13 - stick-fighter-d4c.5
- Implemented POST `/api/room/create` endpoint for multiplayer room creation
- Added room-lobby screen to index.html (displays room code + shareable URL + copy button)
- Wired "Create Room" button in main.js to call API and navigate to lobby screen
- Room data stored in localStorage (roomCode, playerId, playerNum) for later WebSocket use
- 6 new Python tests for the endpoint (code format, player ID, URL, uniqueness, 503 guard)
- Files changed:
  - `server.py` — Added `room_create` POST endpoint at `/api/room/create`, registered in app routes
  - `index.html` — Added room-lobby screen div with code display, URL input, copy button, waiting text; added CSS
  - `src/main.js` — Added roomLobby to screens dict, wired Create Room fetch + lobby back/copy handlers, Escape for lobby
  - `tests/test_server.py` — Added `room_client` fixture (fakeredis injected after lifespan), 6 TestRoomCreate tests, removed unused imports
- **Learnings:**
  - Litestar `TestClient` runs the app lifespan, which overrides global state (like `room_manager`). Inject test state *after* `TestClient.__enter__()`, not before.
  - Litestar POST handlers default to HTTP 201, not 200
  - fakeredis instances are bound to the event loop they were created in — can't use `asyncio.get_event_loop().run_until_complete()` from sync test code to access them
  - `request.base_url` in Litestar returns the request origin (e.g., `http://testserver.local`), useful for building shareable URLs dynamically
---

## 2026-03-13 - stick-fighter-d4c.9
- Implemented WebRTC signaling server for peer-to-peer connection establishment
- POST `/api/room/signal` relays SDP offers/answers and ICE candidates between peers
- GET `/api/room/signal/listen` SSE stream delivers signals to each player
- GET `/api/rtc/config` returns STUN server configuration and fallback strategy
- Player identity validated against Redis room hash (p1_id/p2_id) — prevents signal injection
- SignalingManager class: connect/disconnect/relay/cleanup with in-memory queues per player
- ICE servers: Google public STUN (stun.l.google.com:19302, stun1.l.google.com:19302)
- Fallback: server-relay via existing `/ws/game/{code}` WebSocket when WebRTC fails
- Signaling activity refreshes room TTL (prevents expiry during connection setup)
- 36 new tests (21 unit for SignalingManager, 15 integration for endpoints)
- Files changed:
  - `signaling.py` — New: SignalingManager, SignalSession, ICE_SERVERS constant
  - `server.py` — Added SignalingManager import/global/lifespan, 3 endpoints (rtc_config, signal_send, signal_listen), _resolve_player_num helper, registered in app routes
  - `tests/test_signaling.py` — New: 36 tests across 9 test classes
- **Learnings:**
  - `fakeredis.FakeServer()` enables shared state between sync and async FakeRedis clients — solves the event loop mismatch when sync tests need to manipulate Redis data
  - SSE + POST relay pattern works well for WebRTC signaling — matches existing codebase patterns (LLM/phone sessions)
  - Player authentication via UUID player ID is sufficient for signaling — no separate auth needed since IDs are server-generated secrets
  - Room TTL refresh on signaling activity prevents room expiry during WebRTC handshake (ICE negotiation can take several seconds)
---
