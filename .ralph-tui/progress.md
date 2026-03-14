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
- **INPUT_MODES flag pattern**: Add boolean flags (e.g., `p1Only`, `p2Disabled`, `mpDisabled`) to `INPUT_MODES` entries in `ui.js` — all UI, keyboard nav, and click handlers check these flags to exclude modes per-player or per-screen-context.
- **MP controller validation**: `VALID_MP_CONTROLLERS` (server.py) is a strict subset of `VALID_CONTROLLERS` — use it in MP endpoints (`room_controller`). Matchmaking already rejects bot controllers via `controller_to_category() → None`.
- **Server-authoritative timer pattern**: Use `asyncio.create_task()` with module-level `dict[str, asyncio.Task]` for per-room async timers. Timer tasks check room state on wake (idempotent) and clean up their own dict entry. Cancel via `task.cancel()` and `dict.pop()`. Used for controller wait/forfeit timer.
- **Room state transitions**: `selecting → finished` is valid (controller wait forfeit). Existing: `waiting → selecting → fighting → finished`.

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

## 2026-03-14 - stick-fighter-j3r.3
- Restricted MP controller selection to keyboard, voice, and phone only
- Added `mpDisabled: true` flag to simulated and LLM entries in `INPUT_MODES`
- Room controller and matchmaking screens hide mpDisabled pills (`display: none`) and reject clicks
- Server-side validation: added `VALID_MP_CONTROLLERS` set, `room_controller()` rejects simulated/LLM with 400
- Single-player mode (onboarding) unaffected — still shows all 5 modes
- Files changed:
  - `src/ui.js` — Added `mpDisabled: true` to simulated and LLM INPUT_MODES entries
  - `src/main.js` — Updated `updateRoomControllerUI()`, `updateMatchmakingControllerUI()`, and their click handlers to hide/reject mpDisabled modes
  - `server.py` — Added `VALID_MP_CONTROLLERS` set; added mp-specific validation in `room_controller()`
  - `tests/test_server.py` — Renamed `test_all_valid_controllers_accepted` → `test_all_valid_mp_controllers_accepted`; added `test_simulated_rejected_in_mp` and `test_llm_rejected_in_mp`
  - `tests/ui.test.js` — Added 5 tests in new `INPUT_MODES MP controller restriction` describe block
- **Learnings:**
  - The `mpDisabled` flag is a screen-context flag (unlike `p1Only`/`p2Disabled` which are player-context flags) — same pattern, different axis
  - Matchmaking already had implicit server-side rejection via `controller_to_category()` returning None; room_controller was the gap
  - Using `display: none` (vs opacity 0.3) since AC says "hidden" — cleaner UX than showing disabled options the player can't use
  - All quality gates: 434 Python tests, ruff, mypy, 98 JS tests pass
---

## 2026-03-14 - stick-fighter-j3r.4
- Implemented controller-select-then-wait flow with 60s server-authoritative forfeit timer
- After confirming controller, player enters "waitingInArena" state: canvas shows their fighter idle, ghost silhouette for opponent, pulsing "Waiting for opponent..." text, and 60s countdown
- Server starts asyncio forfeit timer when first controller is set; cancels when second player confirms
- If timer expires: server transitions room `selecting → finished`, stores `forfeit_winner` in Redis
- Frontend polls room status, detects `finished` + `forfeitWinner`, shows result screen with "OPPONENT FORFEITED"
- If opponent confirms in time: transition to real multiplayer fight (3-2-1-FIGHT)
- Files changed:
  - `room_manager.py` — Added `"finished"` to valid transitions from `"selecting"`
  - `server.py` — Added `CONTROLLER_WAIT_TIMEOUT`, `_controller_wait_tasks` dict, `_controller_wait_timer()` asyncio task, `_start_controller_wait_timer()`, `_cancel_controller_wait_timer()`; updated `room_controller()` to start/cancel timer; updated `room_status()` to include `controllerWaitDeadline` and `forfeitWinner`; updated `room_rematch()` to clear timer/deadline
  - `src/main.js` — Added `startWaitingInArena()` (canvas render loop with Fighter, ghost, countdown), `stopWaitingInArena()`, `handleControllerForfeit()`; updated `handleRoomStatusUpdate()` to handle `waitingInArena` → `fighting` and `waitingInArena` → `finished` transitions; updated controller confirm handler to enter waiting state when `!bothReady`
  - `tests/test_room_manager.py` — Added `test_selecting_to_finished_forfeit` to `TestTransitionStatus`
  - `tests/test_server.py` — Added `test_first_controller_returns_wait_deadline`, `test_both_controllers_clears_deadline` to `TestRoomController`; added `TestControllerWaitForfeit` class (3 tests: deadline in status, forfeit winner in status, no forfeit by default)
  - `tests/waiting-arena.test.js` — New file (9 tests: state transitions, countdown computation, forfeit result determination)
- **Learnings:**
  - The `room` dict from `set_controller()` doesn't include fields set directly via `hset` after the call — use a local variable for the response instead of `room.get()`
  - `asyncio.create_task()` tasks need idempotent guards: check room status on wake since state may have changed while sleeping
  - The `selecting → finished` transition required updating `_VALID_TRANSITIONS` in room_manager.py — easy to miss since the test for invalid transitions would catch attempts to use it otherwise
  - Canvas rendering in the waiting state reuses `Fighter.draw()` directly with a standalone Fighter instance — no need for a full Game object
  - All quality gates: 440 Python tests, ruff, mypy, 109 JS tests pass
---

## 2026-03-14 - stick-fighter-j3r.8
- Added status feedback for all async operations (US-006)
- Room creation: "Create Room" button shows "Creating..." with pulsing loading state during API call
- Room join: "JOIN" button shows "JOINING..." with loading state; restores on error
- Controller confirm: button shows "Confirming..." during API call, then "CONFIRMED" on success
- Matchmaking search: button shows "SEARCHING..." during join API call; "MATCH FOUND!" flash with scale animation before transitioning to fight
- LLM thinking: subtle pulsing "AI thinking..." indicator on canvas while LLM adapter requests a plan; suppressed when error toast is active
- Files changed:
  - `index.html` — Added `.loading` CSS class for buttons (pulse animation + pointer-events:none), `.mm-match-found` class with scale-in keyframe animation
  - `src/main.js` — Added loading states to room create, room join, controller confirm, matchmaking search handlers; added "Match found!" flash with 1.2s delay in `handleMatchFound()`
  - `src/llm.js` — Added `_setThinking()` method; `_requestPlan()` sets thinking=true on entry, false on all exit paths (success, fallback, error, early return)
  - `src/game.js` — Added `p1LlmThinking`/`p2LlmThinking` boolean properties, `_drawLlmThinking()` method with pulsing opacity; drawn only when no error toast is active
  - `tests/status-feedback.test.js` — New file (10 tests: thinking set/cleared on success/fallback/error/HTTP error/null state, correct player key, suppressed by toast, shows without toast)
- **Learnings:**
  - The existing `pulse` CSS keyframe animation (`0%→50%→100%` opacity) is reusable for loading button states — just add `pointer-events: none` to prevent double-clicks
  - Using a separate boolean (`p1LlmThinking`) rather than reusing the timed toast for "thinking" state is cleaner — the toast timer would need constant refreshing, while the boolean is just set/cleared
  - Button text restoration in `finally` blocks ensures consistent UI state even on error paths — important for the join button where `disabled` state also depends on input length
  - All quality gates: 440 Python tests, ruff, mypy, 119 JS tests pass
---

