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

## 2026-03-13 - stick-fighter-d4c.7
- Implemented POST `/api/room/join` endpoint for joining rooms as Player 2
- Endpoint validates room existence (404), fullness (409), and missing code (400)
- Wired frontend JOIN button to call `/api/room/join` and navigate to room lobby
- URL auto-join: navigating to `/room/:code` auto-calls `joinRoom(code)` on page load
- Room lobby screen adapts for P1 (shows URL + copy) vs P2 (hides URL row, shows "joined" context)
- Error display on join-room screen for invalid/expired/full rooms (red text)
- Enter key submits on join room input field
- Back button clears error state
- Room code normalized to lowercase before API call
- 8 new Python tests (join success, P2 in Redis, 404, 409, 400 empty/missing, 503, case normalization)
- Files changed:
  - `server.py` — Added `room_join` POST endpoint at `/api/room/join`, registered in app routes
  - `index.html` — Added join-error element, room-lobby-title/hint/url-row IDs, CSS for error + hidden url-row
  - `src/main.js` — Added `joinRoom()` async function, wired JOIN button + Enter key + URL auto-join, P1/P2 lobby modes, error handling
  - `tests/test_server.py` — Added `room_client_with_sync` fixture (shared FakeServer), `_create_waiting_room` helper, 8 TestRoomJoin tests
- **Learnings:**
  - `fakeredis.FakeServer()` shared between sync + async clients is essential for pre-populating test data in sync test contexts
  - Litestar POST returns 201 by default — the join endpoint follows this naturally
  - Room manager's `join_room` ValueError messages are specific enough to map to distinct HTTP status codes (404 vs 409 vs 400)
  - URL auto-join shows the join screen first (with code pre-filled) so errors are visible if the room is invalid
---

## 2026-03-13 - stick-fighter-d4c.4
- Implemented optional OAuth2/OIDC login via id.dx.deepgram.com
- Auth module (`auth.py`) with OIDCConfig, token exchange, refresh, userinfo, JWT payload decoding
- Server endpoints: GET `/api/auth/config`, POST `/api/auth/token`, POST `/api/auth/refresh`, GET `/api/auth/me`, GET `/auth/callback`
- Frontend auth module (`src/auth.js`): login flow, handleCallback, token storage in localStorage, session restore, auto-refresh
- Header shows login button (when OIDC configured) or user display name + logout
- Router updated to detect `/auth/callback` route
- CSRF protection via `state` parameter (generated with crypto.randomUUID, stored in sessionStorage)
- Anonymous players can play without logging in — auth is fully optional
- 28 Python tests + 5 JS tests, all passing
- Files changed:
  - `auth.py` — New: OIDCConfig dataclass, JWT decode, exchange_code, refresh_tokens, fetch_userinfo, extract_user_from_id_token
  - `server.py` — Added auth imports, oidc_config global, lifespan init, 5 new endpoints (auth_callback_route, auth_config, auth_token, auth_refresh, auth_me), registered in app routes
  - `src/auth.js` — New: getAuthConfig, login, handleCallback, refreshToken, logout, isLoggedIn, getUser, checkAuth
  - `src/router.js` — Added auth-callback route detection
  - `src/main.js` — Added auth imports, updateAuthUI, initAuth, wired into route handling
  - `index.html` — Added header-auth section, auth CSS (login/logout buttons, user name display)
  - `tests/test_auth.py` — New: 28 tests across 8 test classes
  - `tests/auth.test.js` — New: 5 tests for auth-callback routing
- **Learnings:**
  - Litestar POST endpoints default to 201 status — token exchange and refresh endpoints follow this naturally
  - `unittest.mock.patch("server.exchange_code")` works for mocking imported functions in the server module scope
  - JWT payload decoding (base64url) needs padding normalization — urlsafe_b64decode is strict about `=` padding
  - Auth init is async but route handling must be immediate — use a promise chain that returns whether the auth callback was handled
  - OIDC endpoints (authorize, token, userinfo) can be derived from issuer URL as convention but should be overridable via env vars
  - `sessionStorage` for CSRF state parameter is better than `localStorage` — it's scoped to the tab and auto-clears on close
---

## 2026-03-13 - stick-fighter-d4c.14
- Implemented ELO rating system with Redis persistence
- Standard ELO formula: expected score E = 1/(1 + 10^((Rb-Ra)/400)), K-factor 32 (new) / 16 (established, ≥30 matches)
- New players start at ELO 1000
- Separate ELO tracked per input category: "voice" (mic/phone) and "keyboard"
- ELO stored in Redis with no TTL (persistent): hash `elo:{user_id}:{category}` + sorted set `leaderboard:{category}`
- Player display names stored at `player:{user_id}` hash for leaderboard
- Atomic updates via Redis pipeline (both players updated in one transaction)
- `controller_to_category()` maps input controllers to ELO categories (voice/phone→voice, keyboard→keyboard, sim/llm→None)
- Server endpoints: GET `/api/leaderboard` (with category filter), GET `/api/elo/{user_id}` (with optional category)
- EloManager integrated into server lifespan (shares Redis pool with RoomManager)
- 43 new tests: pure functions (expected score, K-factor, ELO calc, category mapping), async manager (ratings, names, updates, leaderboard, ranks), server endpoints
- Files changed:
  - `elo.py` — New: EloManager class, ELO calculation functions, controller-to-category mapping, Redis key helpers
  - `server.py` — Added EloManager import/global/lifespan, GET `/api/leaderboard` + GET `/api/elo/{user_id}` endpoints, registered in app routes
  - `tests/test_elo.py` — New: 43 tests across 12 test classes
- **Learnings:**
  - mypy widens `dict[str, str | float | int]` to `dict[str, object]` when mixing literal types in inline dict construction — use `dict[str, Any]` instead
  - Redis sorted sets (`ZADD`/`ZREVRANGE`) are ideal for leaderboards — O(log N) insert, O(log N + M) range query
  - Redis pipelines guarantee atomicity for multi-key updates without MULTI/EXEC overhead
  - `controller_to_category` utility is exported for use by match flow (US-012) but not imported in server.py yet to avoid ruff F401
---

## 2026-03-13 - stick-fighter-d4c.12
- Implemented controller selection per player in multiplayer rooms
- POST `/api/room/controller` sets a player's input mode (validated against VALID_CONTROLLERS set)
- GET `/api/room/status` polls room state (status, controllers, readiness)
- `room_join` now auto-transitions room status from "waiting" → "selecting" when P2 joins
- When both controllers confirmed, status transitions from "selecting" → "fighting"
- New `room-controller` screen in index.html (single player card with mode pills + confirm button)
- Polling mechanism in main.js: 2s interval on `/api/room/status`, drives screen transitions
- P1 flow: create room → lobby → poll → P2 joins → controller selection → confirm → fight
- P2 flow: join room → controller selection (direct, skips lobby) → confirm → fight
- `startMultiplayerFight()` creates local input for current player + no-op InputManager for remote (networking wired in US-012)
- 13 new tests: join-transitions-to-selecting, 4 room status tests, 8 room controller tests (P1/P2 set, both→fighting, invalid, missing, 404, 403, 503, all valid controllers)
- Files changed:
  - `server.py` — Added `room_status` GET + `room_controller` POST endpoints, `VALID_CONTROLLERS` set, auto-transition on join, registered in app routes
  - `index.html` — Added room-controller screen div (player card, mode pills, confirm btn, status text), CSS for `.room-controller` and `.room-ctrl-status`
  - `src/main.js` — Added roomController screen, room polling (startRoomPolling/stopRoomPolling/handleRoomStatusUpdate), showRoomControllerScreen, updateRoomControllerUI, controller confirm POST, startMultiplayerFight, LLM provider pill handling, Escape key for new screen
  - `tests/test_server.py` — Added `_create_selecting_room` helper, TestRoomStatus (4 tests), TestRoomController (9 tests), test_join_transitions_to_selecting
- **Learnings:**
  - Room status transitions are the backbone of multiplayer flow — "waiting" → "selecting" → "fighting" maps cleanly to lobby → controller selection → game
  - Polling is simpler than SSE for one-time state transitions (controller readiness) and avoids extra connection lifecycle management
  - `_resolve_player_num` helper (from signaling) reuses well for any endpoint that needs to validate player identity against a room
  - The multiplayer fight start needs a placeholder InputManager for the remote player — networking comes in US-008/US-012
  - Auto-transitioning room status on join (inside the join endpoint) keeps the client logic simpler — P2 immediately knows it's time to select controllers
---
