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
