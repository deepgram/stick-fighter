---
title: How I Built a Multiplayer Fighting Game with Claude in 3 Days
author: Luke Oliff <luke.oliff@deepgram.com> (https://lukeocodes.dev)
---

**TL;DR:** We built a fully playable multiplayer Street Fighter clone — with voice controls, AI opponents, ELO matchmaking, and rollback netcode — using Claude Code as our primary development tool. The entire game went from zero to deployed in about 3 days.

## The Idea

We wanted to build something fun at Deepgram that could showcase our speech-to-text API in an unexpected way. The pitch: a Street Fighter clone where you can literally yell "HADOUKEN" at your screen. But instead of stopping there, we kept going — and Claude kept up.

## Day 1: Stick Figures Come to Life (March 11)

### Morning: Scaffolding to Skeleton

We started at 9 AM with an empty directory. By 9:25 we had a canvas, Deepgram-branded onboarding UI, and CSS design tokens. By 10:50 we had our first fighter on screen.

The fighter rendering was... interesting at first. We went with procedural stick figure animation — a skeleton of connected line segments rather than sprites. Each fighter has a hip, knees, shoulders, elbows, hands, and a head, all calculated from physics state every frame.

The first version of the kick animation had a problem. The attacking leg would extend forward while both standing legs stayed in place. Three lines radiating from the hip. It looked... anatomically unfortunate. Let's just say the silhouette was not family-friendly. We quickly fixed the back leg to tuck during kicks.

The skeleton approach turned out to be one of our best decisions. Because everything is procedurally generated, we got smooth transitions between states for free — idle breathing, walk cycles, jump arcs, attack windups. No sprite sheets, no animation tools, no asset pipeline. Just math.

### Afternoon: Five Ways to Fight

Here's where it got interesting. We built an abstract input system using the Command Pattern:

```
Actions enum → InputManager → Adapters → Fighter
```

The game loop never sees raw key codes or audio data. It just asks "what actions are active?" This let us build five completely different input modes that all plug into the same interface:

1. **Keyboard** — arrow keys and attack buttons, with double-tap dash detection
2. **Voice** — your microphone feeds into Deepgram's Flux v2 STT, which transcribes commands in real-time. Say "forward dash heavy punch" and your fighter does it
3. **Phone** — call a Twilio number, and your voice commands come through via the phone line. Same STT pipeline, different audio source
4. **Simulated** — a random bot that fires commands via SSE, useful for testing
5. **LLM** — Claude Haiku 4.5 and GPT-4o analyze the game state and return tactical 5-move plans

The voice mode uses Deepgram's Flux v2 API, which gives us interim transcripts with extremely low latency. We detect attack commands from partial transcripts so you don't have to wait for a full sentence — yell "PUNCH" and it fires as soon as the P in "punch" is confident enough. The fighter also has a personality: an Anthropic LLM generates trash talk based on combat events, spoken back through Deepgram's Aura 2 TTS.

### The Sound of Impact

We added procedural sound effects — whooshes on attack startup, different slap/punch impacts for different zones, a metallic ring for clashes, swoosh for somersaults. Each category has multiple variants chosen randomly to prevent that repetitive-game-audio feeling. Headshots and... lower hits... get their own distinct sound effects.

## Day 2: The Phone Rings (March 12)

Day 2 was shorter. We added Twilio phone integration — you can literally call a phone number and fight by voice over the phone. The audio path is: Twilio Media Streams → base64 decode → mulaw/8kHz → Deepgram Flux → transcript → CommandAdapter. It's absurd and delightful.

We also deployed to Fly.io. This involved the classic deployment dance: IPv6 binding, proxy compatibility, port configuration. Three commits in quick succession tell the story: "bind to IPv6", "revert to IPv4", "restore IPv6". We got there.

## Day 3: Multiplayer Everything (March 13)

This is where things got ambitious. We used Claude Code with ralph-tui (our AI task orchestrator) to plan and execute an 18-story epic that added:

- **Room system** with word-based codes (e.g., `red-tiger-paw`) — easy to share, easy to remember
- **WebRTC data channels** for peer-to-peer input exchange
- **Server-authoritative game state** with a Python port of the entire game engine
- **Rollback netcode** with client-side prediction and visual smoothing
- **ELO rating system** with separate voice and keyboard leagues
- **Matchmaking queue** with adaptive ELO thresholds
- **OAuth login** via our internal identity provider

### The Netcode: Rollback and Reconciliation

This deserves its own section because it's the most technically interesting part.

Fighting games are uniquely demanding for networked play. Unlike an RPS or turn-based game, a fighting game needs to feel instant — you press punch, you see punch. Any perceptible delay and it feels broken.

We use a dual-path synchronization model:

**Path 1: WebRTC (fast, unreliable)**
Both players send their inputs directly to each other via a WebRTC data channel configured for unreliable, unordered delivery. This means: no retransmits, no head-of-line blocking, just raw speed. If a frame's input gets lost, the next frame's input arrives 16ms later and overwrites it anyway.

**Path 2: Server WebSocket (slower, authoritative)**
Both players also send their inputs to the server, which runs the exact same game engine in Python. The server processes inputs at 20Hz and broadcasts authoritative state snapshots.

**The reconciliation:**
Each client runs the full game loop locally for instant feedback. When the server snapshot arrives (~50ms later), the client compares its predicted state against the server's truth. If they match — great, keep going. If they don't:

1. Rewind both fighters to the server's state
2. Replay all unconfirmed local inputs from the buffer
3. Apply visual smoothing to hide the position correction over 5-8 frames

The thresholds are tuned to avoid unnecessary corrections: 3 pixels of position drift or 0.1 HP of health difference before triggering a rollback. This means minor floating-point drift between Python and JavaScript doesn't cause constant jitter.

If WebRTC fails entirely (corporate firewalls, symmetric NAT), the system falls back to server-only relay. Higher latency, but it still works.

### Porting the Game Engine to Python

For the server to be authoritative, it needs to run the same simulation as the client. We ported the core fighter physics, state machine, and hit detection from JavaScript to Python in the `game_engine/` package.

The key challenge is **determinism**. Given identical inputs and starting state, both implementations must produce identical results. Floating-point arithmetic between Python and JavaScript can diverge, so we had to be careful with rounding and threshold comparisons. The 3-pixel tolerance in rollback detection absorbs any minor drift.

### Redis + PostgreSQL: Ephemeral vs. Permanent

We initially put everything in Redis. Then we realized that ELO ratings probably shouldn't vanish if Redis restarts. So we split:

- **Redis** — rooms, matchmaking queue, signaling state. Ephemeral, TTL-based, fast.
- **PostgreSQL** — ELO ratings, player profiles, match history. Permanent, ACID, queryable.

Room codes use Redis TTLs for automatic cleanup (5 minutes of inactivity). ELO updates use Postgres transactions so both players' ratings are always updated atomically. Match history is recorded for future analytics.

## The AI Agents Built Most of It

Here's the part that still surprises us. The entire multiplayer system — 18 user stories covering WebRTC, rollback netcode, ELO matchmaking, Redis/Postgres infrastructure, OAuth, and deployment — was planned in a single conversation and executed by AI agents via ralph-tui.

The workflow:
1. We described what we wanted in plain English
2. Claude generated a PRD with user stories, acceptance criteria, and quality gates
3. We converted the PRD to task beads with dependency ordering
4. ralph-tui executed each story autonomously, one agent instance per story
5. Each story had to pass: pytest, ruff, mypy, and Jest before closing

The agents worked through the dependency graph — starting with Redis setup, Python game port, and landing page UI in parallel, then building the networking layer, then integration, then features like matchmaking and leaderboard.

Not everything was perfect on the first pass. Post-launch we found seven issues: LLM fighters stopped working, share URLs pointed to the wrong domain, controller selection needed restriction for multiplayer, the join flow was clunky, UI needed better feedback, keyboard navigation was incomplete, and the leaderboard needed proper league separation. We created another epic for these fixes and the agents are working through them now.

## What We Learned

**Procedural animation over sprites.** No asset pipeline, no sprite sheets, no animation tools. The stick figure aesthetic is charming AND practical — everything is just line segments and circles computed from physics state.

**The Command Pattern pays off.** By abstracting inputs behind an Actions enum, we could add five completely different control schemes (keyboard, voice, phone, bot, AI) without touching the game loop. Each new adapter is just a class that produces the same action sets.

**WebRTC data channels aren't just for video.** Unreliable, unordered data channels are perfect for game inputs. You want the latest state, not guaranteed delivery of stale frames.

**AI can build real systems.** The multiplayer infrastructure — WebRTC signaling, rollback netcode, ELO matchmaking, server-authoritative game simulation — was planned and implemented primarily by Claude. Not toy examples. Production systems with tests, type checking, and deployment.

**Speech-to-text as a game controller is genuinely fun.** There's something deeply satisfying about screaming "HEAVY KICK" at your laptop and watching your stick figure deliver. The interim transcript detection makes it feel almost as responsive as a button press.

## Try It

The game is live at [fight.dx.deepgram.com](https://fight.dx.deepgram.com). Challenge a friend via room code, queue into ELO matchmaking, or yell at an AI opponent.

The entire codebase is at [github.com/deepgram/stick-fighter](https://github.com/deepgram/stick-fighter). Built with Claude Code, Deepgram, Litestar, and an unreasonable amount of enthusiasm.

---

*Built by the Deepgram Developer Experience team with Claude Code, March 2026.*
