# PRD: Post-Launch Fixes & UX Polish

## Overview
Address seven issues discovered after the multiplayer launch: broken LLM fighters, incorrect room share URLs, restricted MP controller options, broken controller-to-game flow, missing UI feedback/instructions, keyboard navigation gaps, missing P2 keyboard option removal in classic mode, and leaderboard league separation. These fixes improve reliability, usability, and accessibility across the game.

## Goals
- Restore LLM fighter functionality with resilient error handling
- Fix room share URLs to use the canonical domain (fight.dx.deepgram.com)
- Restrict and streamline MP controller selection to keyboard, voice, and phone
- Implement proper join-then-wait flow with 1-minute forfeit timer
- Add clear instructions, status feedback, and step indicators on every screen
- Make all menu screens fully keyboard-navigable with arrow keys
- Remove P2 keyboard option in classic (single-player local) mode
- Split leaderboard into distinct voice and keyboard leagues

## Quality Gates

These commands must pass for every user story:
- `uv run pytest` — Python unit tests
- `uv run ruff check .` — Python linting
- `uv run mypy .` — Python type checking
- `npx jest --experimental-vm-modules` — Frontend unit tests

For UI stories, also include:
- Verify in browser using dev-browser skill

## User Stories

### US-001: Fix LLM fighter API integration
**Description:** As a player, I want LLM fighters to work reliably so I can play single-player against AI opponents.

**Acceptance Criteria:**
- [ ] Diagnose and fix the current LLM fighter regression (characters not sending commands)
- [ ] Verify both "Haiku the Swift" (Anthropic) and "GPT the Tank" (OpenAI) respond with valid fight commands
- [ ] Add error handling: if LLM API returns error or times out (>3s), log the error and retry once
- [ ] If retry also fails, fall back to a random command (like SimulatedAdapter) rather than doing nothing
- [ ] Display a brief toast/indicator when LLM is unavailable ("AI thinking..." or "AI connection lost")
- [ ] Add a test that verifies the LLM command endpoint returns a valid action for a sample game state

### US-002: Fix room share URL domain
**Description:** As a player, I want the share URL to show the correct domain so my friends can actually join.

**Acceptance Criteria:**
- [ ] Room creation returns share URL using `fight.dx.deepgram.com` instead of `stick-fighter.fly.dev`
- [ ] The share URL domain is read from the `BASE_URL` environment variable (already set to `https://fight.dx.deepgram.com`)
- [ ] If `BASE_URL` is not set, fall back to the request's Host header
- [ ] Share URL format: `fight.dx.deepgram.com/room/red-tiger-paw`
- [ ] Verify the URL is correct in the room creation API response and in the frontend copy-to-clipboard UI

### US-003: Restrict MP controller selection to keyboard, voice, and phone
**Description:** As a multiplayer player, I want to see only the valid MP controller options so I don't pick an unsupported mode.

**Acceptance Criteria:**
- [ ] MP controller selection screen shows only: Keyboard, Voice (mic), Phone (Twilio)
- [ ] Simulated and LLM options are hidden in multiplayer mode
- [ ] Single-player mode continues to show all controller options (keyboard, voice, phone, simulated, LLM)
- [ ] Server validates controller choice — rejects simulated/LLM in MP rooms

### US-004: Controller select joins game with opponent wait timer
**Description:** As a player, I want to join the game immediately after picking my controller and wait for my opponent, with a 1-minute forfeit countdown.

**Acceptance Criteria:**
- [ ] After selecting a controller, player immediately enters the game arena (canvas visible)
- [ ] Player's fighter is visible and idle; opponent side shows "Waiting for opponent..." placeholder
- [ ] A visible countdown timer starts at 60 seconds
- [ ] If opponent selects their controller within 60s, the fight countdown begins (3-2-1-FIGHT)
- [ ] If opponent does not select within 60s, they forfeit — waiting player wins by default
- [ ] Forfeit triggers room transition to `finished` and shows result screen
- [ ] If the waiting player leaves before timeout, the room cleans up normally

### US-005: Add step indicators and instructions to all screens
**Description:** As a player, I want clear instructions on every screen so I know what to do next.

**Acceptance Criteria:**
- [ ] Landing page: brief tagline explaining the game modes ("Fight online or train against AI")
- [ ] Multiplayer screen: step indicator showing "Step 1: Create or Join → Step 2: Pick Controller → Step 3: Fight!"
- [ ] Room creation screen: instruction text "Share this code with your opponent" + copy button with "Copied!" feedback
- [ ] Room join screen: placeholder text in code input showing format "e.g. red-tiger-paw"
- [ ] Controller selection: brief label per option ("Keyboard — use arrow keys and Z/X", "Voice — speak commands into your mic", "Phone — call in from your phone")
- [ ] Matchmaking queue: status text showing "Searching for opponent... (15s)" with live timer and queue size
- [ ] Waiting for opponent: "Waiting for opponent to pick a controller... (45s remaining)"

### US-006: Add status feedback for async operations
**Description:** As a player, I want visual feedback when something is loading or processing so I don't think the game is frozen.

**Acceptance Criteria:**
- [ ] Room creation: button shows spinner/loading state while API call is in flight
- [ ] Room join: button shows spinner while validating code; error message appears inline if invalid
- [ ] Matchmaking: pulsing animation or spinner while searching; "Match found!" flash before transitioning
- [ ] Controller selection: "Confirming..." state after selection before transitioning to game
- [ ] LLM thinking: subtle indicator when AI opponent is processing a move

### US-007: Keyboard navigation for all menu screens
**Description:** As a player, I want to navigate all menus with arrow keys and Enter so I can play without a mouse.

**Acceptance Criteria:**
- [ ] Landing page: Up/Down arrows move focus between Multiplayer / Single Player; Enter selects
- [ ] Multiplayer options: Up/Down arrows move focus between Create Room / Join Room / Join Matchmaking; Enter selects
- [ ] Controller selection: Up/Down arrows move focus between controller options; Enter confirms
- [ ] Room code input: auto-focused on page load; Enter submits
- [ ] Leaderboard: Up/Down scrolls entries; Left/Right switches league tabs; Escape goes back
- [ ] Visible focus indicator (highlight/border) on the currently selected option
- [ ] Tab order is logical and matches visual layout
- [ ] Escape key navigates back one screen from any menu

### US-008: Remove P2 keyboard option in classic mode
**Description:** As a single-player user, I want the P2 controller selection to not offer keyboard since most keyboards don't have a numpad.

**Acceptance Criteria:**
- [ ] In classic (local single-player) mode, P2 controller options exclude "Keyboard"
- [ ] P2 options in classic mode: Voice, Phone, Simulated, LLM
- [ ] If P1 picks keyboard, P2 still does not get keyboard as an option
- [ ] Multiplayer mode is unaffected (each remote player picks their own controller independently)

### US-009: Distinct voice and keyboard leaderboard leagues
**Description:** As a player, I want the leaderboard to show separate voice and keyboard leagues so rankings are fair within each input mode.

**Acceptance Criteria:**
- [ ] Leaderboard page defaults to showing two league tabs: "Voice League" and "Keyboard League"
- [ ] Remove the "All" merged view — each league is independent
- [ ] Voice League shows only players who earned ELO via voice or phone controllers
- [ ] Keyboard League shows only players who earned ELO via keyboard controllers
- [ ] Each league has its own rank numbers (both start at #1)
- [ ] The viewer's rank is shown per-league (if ranked in that league)
- [ ] API endpoint `/api/leaderboard` no longer accepts `category=all` — returns 400 for that value
- [ ] Frontend default tab is the league matching the player's most recent controller, or Voice if unknown

## Functional Requirements
- FR-1: LLM fighter must produce a valid command within 5 seconds or fall back to random
- FR-2: Share URLs must always use the canonical domain from BASE_URL
- FR-3: MP controller validation must be enforced server-side (not just hidden in UI)
- FR-4: Forfeit timer must be server-authoritative (not just client-side countdown)
- FR-5: All interactive menu elements must be reachable via keyboard (arrow keys + Enter + Escape)
- FR-6: Leaderboard must display two independent leagues with no merged "All" view
- FR-7: Status feedback must appear within 200ms of user action (no perceived lag)
- FR-8: Classic mode must never offer keyboard for P2

## Non-Goals (Out of Scope)
- Redesigning the game's visual theme or branding
- Adding new controller types (gamepad, etc.)
- Mobile/touch navigation
- Replay or spectator features
- Changing ELO calculation or matchmaking algorithm
- Adding new LLM providers beyond existing Anthropic + OpenAI

## Technical Considerations
- The LLM regression may be related to API key rotation, model ID changes, or prompt format — check server logs first
- BASE_URL is already set as a Fly.io secret; the room creation endpoint in server.py and/or room_manager.py likely has a hardcoded domain
- Keyboard navigation can use a shared MenuNavigator class in JS that manages focus index and key handlers
- The forfeit timer should use a server-side asyncio task per room that fires after 60s, not rely on client timers
- Leaderboard "All" removal is a breaking API change — update frontend before or simultaneously with backend

## Success Metrics
- LLM fighters respond to every game tick within 5 seconds (0% silent failures)
- Share URLs resolve correctly to fight.dx.deepgram.com
- All menu screens navigable via keyboard without mouse
- Players see status feedback within 200ms of every action
- Leaderboard shows distinct league rankings with no merged view
- No P2 keyboard option visible in classic mode

## Open Questions
- Should the forfeit result count toward ELO? (Probably yes for the waiting player, but confirm)
- Should the LLM fallback-to-random be visible to the player or silent?
- When phone (Twilio) is selected in MP, does the existing phone allocation flow work for both players simultaneously?
