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
