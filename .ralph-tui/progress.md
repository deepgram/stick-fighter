# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

- **BASE_URL env var pattern**: Use `os.environ.get("BASE_URL", "").rstrip("/") or str(request.base_url).rstrip("/")` for canonical URL generation. Already used in Twilio webhooks and room creation.
- **Jest invocation**: Must use `node --experimental-vm-modules node_modules/.bin/jest` (not `npx jest --experimental-vm-modules`).
- **TestClient fixtures**: `room_client` fixture injects fakeredis-backed RoomManager. Use `monkeypatch` for env var tests.
- **LLM endpoint retry pattern**: `llm_command()` uses a for-loop retry (2 attempts), catching all exceptions from provider functions. On double failure, returns `{"plan": [...], "fallback": true}` with random commands. Frontend checks `fallback` flag for toast display.
- **LLM provider mocking**: Patch `server._llm_anthropic` or `server._llm_openai` (AsyncMock) — the `_call_llm_provider` wrapper delegates to these.
- **Leaderboard mock fixture**: `lb_client` fixture uses `MagicMock` + `AsyncMock` for EloManager methods. Useful for testing endpoint validation without a real PostgreSQL connection.
- **INPUT_MODES flag pattern**: Add boolean flags (e.g., `p1Only`, `p2Disabled`) to `INPUT_MODES` entries in `ui.js` — all UI, keyboard nav, and click handlers check these flags to exclude modes per-player.

---

## 2026-03-14 - stick-fighter-j3r.5
- Removed P2 keyboard option in classic (single-player) mode
- Added `p2Disabled: true` flag to keyboard entry in `INPUT_MODES`
- `updateModeSelection` now dims and disables both `p1Only` and `p2Disabled` pills
- Init guard bumps saved P2 mode from keyboard to simulated (idx 3)
- Keyboard nav (ArrowLeft/Right) skips `p2Disabled` modes for P2
- Click handler also rejects `p2Disabled` clicks for P2
- Files changed:
  - `src/ui.js` — Added `p2Disabled: true` to keyboard INPUT_MODE; updated pill disable condition in `updateModeSelection`
  - `src/main.js` — Updated init guard, keyboard nav skip conditions, click handler guard
  - `tests/ui.test.js` — New test file (6 tests: flag exists, non-keyboard modes clean, valid P2 modes, P1 unaffected, keyboard nav skip, init guard)
- **Learnings:**
  - The `p1Only` pattern was already well-established — `p2Disabled` follows the exact same pattern in reverse
  - `updateModeSelection` sets `pointerEvents: 'none'` which makes pills unclickable, but the click handler still needs a guard for programmatic/keyboard-triggered mode changes
  - Minimal DOM stubs (`globalThis.document` with `createElement`) are sufficient to import `ui.js` in node test environment without jsdom
  - All quality gates: 432 Python tests, ruff, mypy, 93 JS tests pass
---

## 2026-03-14 - stick-fighter-j3r.6
- Split leaderboard into distinct Voice League and Keyboard League tabs
- Removed the merged "All" view — `category=all` now returns 400
- Frontend defaults to the league matching the player's most recent controller (or voice if unknown)
- Files changed:
  - `server.py` — Removed `category=all` merge logic from `/api/leaderboard`, default changed to `voice`, error message updated
  - `index.html` — Removed "All" filter button, renamed tabs to "Voice League" / "Keyboard League"
  - `src/main.js` — Added `defaultLeaderboardCategory()` function that reads `sf_p1Mode` from localStorage, changed default from `'all'` to dynamic category
  - `tests/test_server.py` — Added `lb_client` fixture with mocked EloManager; added `TestLeaderboardEndpoint` class (7 tests: all returns 400, invalid returns 400, voice/keyboard returns 200, default is voice, viewer included when ranked, 503 without manager)
- **Learnings:**
  - The backend already tracked ELO separately per category — the "All" view was computed on-the-fly by merging both leaderboards. Removing it was purely subtractive on the server side.
  - `MagicMock` with `AsyncMock` methods works well for testing Litestar endpoints that call async database methods, avoiding the need for a real PostgreSQL connection in unit tests.
  - `mypy` flags `server.elo_manager.some_method = AsyncMock(...)` as `method-assign` + `union-attr` — work around by assigning to a local variable with an assert-not-None guard.
  - All quality gates: 432 Python tests, ruff, mypy, 87 JS tests pass
---

## 2026-03-14 - stick-fighter-j3r.2
- Fixed room share URL to use `BASE_URL` env var instead of `request.base_url`
- Falls back to request Host header when `BASE_URL` is not set
- Files changed:
  - `server.py` — 1 line changed in `room_create()` endpoint (line 640)
  - `tests/test_server.py` — 3 new tests added to `TestRoomCreate`
- **Learnings:**
  - The `BASE_URL` env var was already used for Twilio webhooks in the same file — just wasn't wired into room creation
  - Frontend copy-to-clipboard simply uses the `url` field from the API response, so fixing the backend was sufficient
  - All quality gates: 421 Python tests, ruff, mypy, 81 JS tests pass
---

## 2026-03-14 - stick-fighter-j3r.1
- Fixed LLM fighter regression: silent failure loop when API is unavailable
- Added retry-once with 3s timeout on server-side LLM calls
- On double failure, server returns random commands with `fallback: true` flag
- Client-side fallback generates random plan when server is unreachable
- Toast indicator ("AI connection lost") shown on canvas near player's controller
- Files changed:
  - `server.py` — Refactored `llm_command()` into retry loop + `_call_llm_provider()`, `_parse_llm_plan()`, `_generate_random_plan()`, `FALLBACK_COMMANDS`; reduced httpx timeout from 10s to 3s
  - `src/llm.js` — Added `FALLBACK_COMMANDS`, `_generateFallbackPlan()`, `_setToast()`, `_applyPlan()`; removed `_sleep()`; added `_consecutiveFailures` tracking
  - `src/game.js` — Added `p1LlmToast`/`p2LlmToast` properties, `_drawLlmToast()` method, toast countdown in `_update()`
  - `tests/test_characters.py` — Added `TestLLMCommandRetryAndFallback` (4 tests: success, retry, fallback, openai fallback)
  - `tests/characters.test.js` — Added "LLMAdapter retry and fallback" describe block (6 tests: success, server fallback flag, network error, HTTP error, recovery, plan generation)
- **Learnings:**
  - The "regression" was a silent failure loop — no code bug per se, but missing resilience. When API fails, adapter retried infinitely with no visible feedback.
  - httpx timeout changed from 10s to 3s; this is aggressive for LLM calls but matches PRD spec. The retry provides a second chance.
  - Litestar `@post` returns 201 by default (not 200) — tests must assert `status_code == 201`
  - All quality gates: 425 Python tests, ruff, mypy, 87 JS tests pass
---

