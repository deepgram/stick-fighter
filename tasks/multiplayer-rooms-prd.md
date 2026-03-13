# PRD: Multiplayer Game Rooms & Leaderboard

## Overview
Transform Stick Fighter from a single-player experience into a multiplayer game with room-based matchmaking, ELO rankings, and leaderboards. Players can create/join rooms via shareable word-based codes, enter ELO matchmaking queues, or play single-player against AI opponents with distinct personalities. The game uses WebRTC data channels for low-latency P2P communication with server-authoritative conflict resolution. Optional login via id.dx.deepgram.com enables persistent ELO tracking across voice and keyboard leaderboards.

## Goals
- Enable real-time multiplayer fights between any two players regardless of location or input mode
- Provide three multiplayer entry points: create room, join room (code), join matchmaking (ELO)
- Implement ELO rating system with global leaderboard split by input mode
- Offer single-player mode with named AI characters backed by different LLM providers
- Maintain all existing input modes (keyboard, voice, phone, simulated, LLM) in both modes
- Deploy Redis on Fly.io for room state and player session management

## Quality Gates

These commands must pass for every user story:
- `uv run pytest` — Python unit tests
- `uv run ruff check .` — Python linting
- `uv run mypy .` — Python type checking
- `npx jest --experimental-vm-modules` — Frontend unit tests

For UI stories, also include:
- Verify in browser using dev-browser skill

## User Stories

### US-001: Redis room state management
**Description:** As the system, I need Redis to store active room data so rooms work across server instances.

**Acceptance Criteria:**
- [ ] Redis provisioned on Fly.io (Upstash or Fly Redis)
- [ ] Room data stored as Redis hash: code, player IDs, player controllers, status, created_at
- [ ] Rooms expire via Redis TTL (5 minutes from last activity)
- [ ] Room status transitions: `waiting` → `selecting` → `fighting` → `finished`
- [ ] Activity (any player action) refreshes the TTL
- [ ] Python Redis client (e.g., `redis-py` with async support) integrated into server.py

### US-002: Room creation with word-based codes
**Description:** As a player, I want to create a game room and get a shareable code so I can invite a friend.

**Acceptance Criteria:**
- [ ] POST `/api/room/create` generates a room and returns a 3-word code (e.g., `red-tiger-paw`)
- [ ] Word list contains common, distinct English words (no homophones, no offensive words)
- [ ] Room code is unique among active rooms
- [ ] Room stored in Redis with TTL (5 minute idle expiry)
- [ ] Player receives shareable URL: `fight.dx.deepgram.com/room/red-tiger-paw`
- [ ] Creator is assigned as Player 1 and enters controller selection

### US-003: Room joining via code or URL
**Description:** As a player, I want to join a friend's room by entering a code or clicking a link so we can fight.

**Acceptance Criteria:**
- [ ] GET `/room/:code` route loads the game and auto-joins the room
- [ ] Manual code entry field on "Join Room" screen accepts 3-word codes (hyphen-separated)
- [ ] Error shown if room code is invalid, expired, or full (2 players max)
- [ ] Joining player is assigned as Player 2 and enters controller selection
- [ ] Both players see a "waiting for opponent" state until both have selected controllers

### US-004: Room auto-expiry and cleanup
**Description:** As the system, rooms must clean up automatically so Redis doesn't fill with stale data.

**Acceptance Criteria:**
- [ ] Rooms have a 5-minute idle TTL in Redis
- [ ] Any player action (input, chat, controller selection) refreshes the TTL
- [ ] When TTL expires, room is deleted from Redis
- [ ] Active WebRTC connections closed gracefully on room expiry
- [ ] Matchmaking queue entries expire if player disconnects without canceling

### US-005: Port core game logic to Python
**Description:** As the system, the server needs a Python implementation of the core game logic (fighter physics, state machine, hit detection) for authoritative simulation.

**Acceptance Criteria:**
- [ ] Python module `game_engine/` with Fighter class mirroring src/fighter.js physics
- [ ] State machine transitions (idle, walking, jumping, attacking, blocking, hit, KO) match JS
- [ ] Hit detection logic ported with identical hitbox calculations
- [ ] Deterministic: given same inputs and state, Python produces same result as JS
- [ ] Unit tests covering physics, state transitions, and hit detection

### US-006: Server game loop with input processing and state broadcast
**Description:** As the system, the server must run a headless game loop per active room to arbitrate state.

**Acceptance Criteria:**
- [ ] Server runs asyncio task per active room using Python game engine
- [ ] Receives player inputs via WebSocket and processes them in tick order
- [ ] Broadcasts authoritative state snapshots at 20Hz
- [ ] State includes: fighter positions, health, active attacks, hit confirmations
- [ ] Conflicting simultaneous hits resolved deterministically
- [ ] Game loop cleans up when room expires or match ends

### US-007: WebRTC signaling server
**Description:** As the system, I need a signaling server so that two clients can establish a WebRTC data channel connection.

**Acceptance Criteria:**
- [ ] POST `/api/room/signal` endpoint relays SDP offers/answers and ICE candidates between peers
- [ ] Signaling uses the existing room's Redis state to identify peers
- [ ] STUN/TURN server configuration provided to clients (use public STUN, configure TURN if needed)
- [ ] Connection established within 5 seconds on typical networks
- [ ] Fallback behavior defined if WebRTC connection fails (server relay)

### US-008: WebRTC data channel for peer input exchange
**Description:** As the system, clients need to exchange inputs over WebRTC data channels for low-latency gameplay.

**Acceptance Criteria:**
- [ ] Client creates RTCPeerConnection and data channel on room join
- [ ] Signaling flow: offer → answer → ICE candidates via `/api/room/signal`
- [ ] Each client sends local inputs to peer via data channel (JSON messages)
- [ ] Each client also sends inputs to server via WebSocket for authoritative validation
- [ ] Data channel reconnects automatically if connection drops
- [ ] Fallback to server-only relay if WebRTC fails

### US-009: Client-side prediction and rollback reconciliation
**Description:** As the system, clients must predict game state locally and reconcile with server authority for responsive gameplay.

**Acceptance Criteria:**
- [ ] Client runs full game loop locally (immediate input feedback)
- [ ] Client receives authoritative state snapshots from server at 20Hz
- [ ] On state mismatch, client rewinds to last confirmed state and replays buffered inputs
- [ ] Input buffer maintains recent inputs for replay (rolling window)
- [ ] Game feels responsive locally despite network latency
- [ ] Visual smoothing prevents jarring snaps on correction

### US-010: Landing page with mode selection
**Description:** As a player, I want to choose between multiplayer and single-player when I load the game so that I can pick the experience I want.

**Acceptance Criteria:**
- [ ] Landing page at `fight.dx.deepgram.com` shows two primary paths: "Multiplayer" and "Single Player"
- [ ] Multiplayer path shows three options: "Create Room", "Join Room", "Join Matchmaking"
- [ ] Single Player path flows into existing opponent selection (SIM or LLM)
- [ ] Existing onboarding HTML/CSS style is preserved (Deepgram design tokens)
- [ ] URL routing supports `/room/:code` for direct join links

### US-011: Controller selection per player in rooms
**Description:** As a player, I want to pick my own input mode independently so that I can use voice while my opponent uses keyboard.

**Acceptance Criteria:**
- [ ] After joining a room, each player sees controller selection screen
- [ ] All input modes available: keyboard, voice (mic), phone (Twilio), simulated, LLM
- [ ] Each player's choice is independent — any combination works
- [ ] Selection is communicated to server and stored in room state
- [ ] Game starts when both players have confirmed their controller choice

### US-012: Multiplayer match flow end-to-end
**Description:** As two players, I want the full multiplayer match flow to work seamlessly from room join to fight completion.

**Acceptance Criteria:**
- [ ] Both players in room → both select controllers → countdown → fight starts
- [ ] During fight: inputs synced via WebRTC, server arbitrates state
- [ ] Match ends when one fighter's health reaches 0
- [ ] Results screen shows winner, ELO change (if both logged in), and rematch option
- [ ] "Rematch" resets fighters and starts a new round in the same room
- [ ] "Leave" returns player to landing page; if room empty, room expires via TTL
- [ ] Disconnect during match → disconnected player forfeits after 10-second grace period

### US-013: Optional login via id.dx.deepgram.com
**Description:** As a player, I want to optionally log in so my wins are tracked on the leaderboard.

**Acceptance Criteria:**
- [ ] "Log In" button on landing page (non-blocking — can play without logging in)
- [ ] OAuth2/OIDC flow with id.dx.deepgram.com as the identity provider
- [ ] On success, store user ID and display name in session
- [ ] Logged-in state shown in header (display name + optional logout)
- [ ] Anonymous players can play multiplayer but don't appear on leaderboard
- [ ] Login state persisted in localStorage (with token refresh)

### US-014: ELO rating system
**Description:** As a logged-in player, I want an ELO rating so I can see how I rank against others.

**Acceptance Criteria:**
- [ ] New players start at ELO 1000
- [ ] ELO calculated using standard formula (K-factor = 32 for new players, 16 for established)
- [ ] Rating updated after each completed multiplayer match between logged-in players
- [ ] ELO stored in Redis (persistent — no TTL) keyed by user ID
- [ ] Separate ELO tracked per input category: "voice" (mic or Twilio) and "keyboard"
- [ ] ELO visible to all players on leaderboard

### US-015: ELO matchmaking queue
**Description:** As a player, I want to join a matchmaking queue so I can be paired with someone near my skill level.

**Acceptance Criteria:**
- [ ] "Join Matchmaking" button on multiplayer screen
- [ ] Player added to Redis sorted set (score = ELO) for their input category
- [ ] Server matches closest ELO within +/-100 threshold initially
- [ ] Threshold widens by 50 every 10 seconds if no match found
- [ ] Match found → auto-create room and notify both players
- [ ] "Play while you wait" option launches single-player with SIM opponent
- [ ] Queue position / estimated wait time shown to player
- [ ] Player can cancel matchmaking at any time

### US-016: Global leaderboard page
**Description:** As a player, I want to see a leaderboard so I know how I rank against other fighters.

**Acceptance Criteria:**
- [ ] GET `/api/leaderboard` returns top players sorted by ELO
- [ ] Leaderboard page accessible from landing screen
- [ ] Global view shows all players ranked by ELO (highest first)
- [ ] Filter by input mode: "All", "Voice" (mic + Twilio), "Keyboard"
- [ ] Each entry shows: rank, display name, ELO, W-L record, input mode badge
- [ ] Logged-in player's own rank highlighted if not in top view
- [ ] Leaderboard updates in real-time or on page load

### US-017: Single-player LLM character selection
**Description:** As a player, I want to choose which AI character to fight in single-player so I can pick my challenge level.

**Acceptance Criteria:**
- [ ] Single-player screen shows named AI characters as selectable opponents
- [ ] Characters: at minimum "Haiku the Swift" (Claude Haiku) and "GPT the Tank" (GPT-4o)
- [ ] Each character has a portrait/icon, name, and short personality description
- [ ] Characters have distinct fighting styles: aggression level, preferred moves, taunt frequency
- [ ] Selected character determines which LLM API is called in `/api/llm/command`
- [ ] Character personality reflected in the system prompt sent to the LLM

### US-018: Distinct AI fighting personalities
**Description:** As the system, each LLM character needs a unique fighting style so they feel different to play against.

**Acceptance Criteria:**
- [ ] "Haiku the Swift" — high aggression, favors quick attacks, frequent dashes, taunts about speed
- [ ] "GPT the Tank" — defensive, favors blocking and counter-attacks, taunts about patience
- [ ] Fighting style encoded in system prompt and optionally in temperature/parameter tuning
- [ ] Each character's move distribution measurably differs (e.g., Haiku attacks 2x more often)
- [ ] New characters can be added by creating a new personality config (no code changes to game loop)

## Functional Requirements
- FR-1: The system must support concurrent game rooms (minimum 50 simultaneous)
- FR-2: WebRTC data channels must carry player inputs with sub-100ms latency on typical connections
- FR-3: Server must run headless game simulation for each active room
- FR-4: Redis must be the single source of truth for room state, ELO, and matchmaking queues
- FR-5: The system must handle asymmetric input modes (e.g., voice vs keyboard in same match)
- FR-6: OAuth2 login must not block gameplay — anonymous play is always available
- FR-7: Room codes must be generated from a curated 3-word dictionary (no offensive/ambiguous words)
- FR-8: ELO changes must be atomic (both players updated in same Redis transaction)
- FR-9: The system must degrade gracefully if WebRTC fails (server relay fallback)
- FR-10: Matchmaking must produce a match within 60 seconds or notify the player of extended wait

## Non-Goals (Out of Scope)
- Spectator mode / live viewing of other players' matches
- Tournament brackets or organized competition features
- In-game chat or messaging between players
- Replay recording or playback
- Mobile-specific responsive layout
- More than 2 players per room (1v1 only)
- Custom fighter cosmetics or unlockables
- Cross-match persistent game state (each match is independent)
- Server-side rendering — frontend remains vanilla JS

## Technical Considerations
- **WebRTC:** Use `RTCPeerConnection` with data channels. Signaling via server WebSocket. Public STUN servers for NAT traversal; consider Fly.io TURN if needed.
- **Rollback netcode:** Port core game logic (fighter.js physics, hit detection) to run identically on client and server. Server Python port must produce identical results to JS client simulation.
- **Redis on Fly.io:** Use Upstash Redis (serverless, Fly-native) or Fly Redis (managed). Async client via `redis.asyncio`.
- **Game loop on server:** Python headless game loop must match JS tick rate. Consider using `asyncio` task per room.
- **Auth:** id.dx.deepgram.com likely supports OIDC — need to verify available scopes and token format.
- **Determinism:** Both client and server game simulations must be deterministic given the same inputs. Avoid floating-point inconsistencies between Python and JS.
- **Test setup:** Jest with `--experimental-vm-modules` for frontend ESM tests. pytest for Python. May need jsdom for DOM-dependent modules.

## Success Metrics
- Two players can complete a full match via room code with <100ms perceived input latency
- Matchmaking produces a match within 30 seconds at active times
- ELO ratings converge to meaningful skill differentiation after 10+ matches
- Leaderboard loads in <1 second
- Room cleanup prevents Redis memory growth (no stale rooms after 5 minutes)
- All five input modes work in multiplayer without regression

## Open Questions
- What OIDC scopes/claims does id.dx.deepgram.com expose? (need user ID + display name minimum)
- Do we need TURN servers for restrictive corporate networks, or is STUN sufficient?
- Should the Python headless game loop share logic with the JS client via WASM, or maintain parallel implementations?
- What's the Fly.io Redis plan/budget? Upstash free tier may suffice initially.
- Should ELO be reset seasonally or persist indefinitely?
- K-factor adjustment: at what match count does a player transition from K=32 to K=16?
