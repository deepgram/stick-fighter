# Stick Fighter

> **This app is part of the Deepgram DX stack.** When working in this repo, you must follow cross-stack documentation rules. A PostToolUse hook will remind you when you edit cross-stack files, but you are also responsible for catching changes the hook doesn't cover.

## DX Stack Rules

1. **Incremental changes, comprehensive reviews.** Make changes incrementally. But before finishing any task, do a comprehensive review to spot architectural misses — port conflicts, auth flow breakage, env var mismatches, or contract changes that affect other services.

2. **Update dx-stack docs when you change cross-stack behavior.** If your change affects ports, auth flows, env vars, redirect URIs, API contracts, or deployment config, update the reference docs at `/Users/lukeoliff/Projects/deepgram/dx-stack/` before finishing.

3. **Know the architecture.** Read `/Users/lukeoliff/Projects/deepgram/dx-stack/CLAUDE.md` for the full stack context — port map, auth flows, service-to-service communication, and environment matrix.

### What requires dx-stack updates

| Change | Update |
|--------|--------|
| Port changes | `dx-stack/CLAUDE.md` port map + `docs/runbook.md` |
| Auth flow / session changes | `dx-stack/docs/auth.md` |
| OIDC client changes | `dx-stack/docs/auth.md` client table |
| Env var changes | `dx-stack/docs/environments.md` |
| New cross-service endpoints | `dx-stack/CLAUDE.md` cross-service section |
| Deployment / Fly config changes | `dx-stack/CLAUDE.md` deployment section |
| Database schema changes | `dx-stack/docs/auth.md` schema section |
| Redirect URI changes | `dx-stack/docs/auth.md` + seed.ts |

## Project: Stick Fighter
Basic Street Fighter clone using HTML5 Canvas with stick figure fighters.

### Run
```sh
uv run uvicorn server:app --reload --host 0.0.0.0 --port 3007
```

### Structure
- `server.py` — Litestar/uvicorn entry point (SSE, Deepgram proxy, static files)
- `index.html` — Game page, canvas 800x400
- `src/input.js` — Abstract input system (InputManager + adapters, Command Pattern)
- `src/fighter.js` — Fighter class: physics, state machine, stick figure rendering
- `src/game.js` — Game loop, stage, hit detection, HUD
- `src/sfx.js` — Sound effects (pre-decoded MP3 AudioBuffers)
- `assets/` — Sound effect MP3 files

### Input System
Abstract input via adapters. Game logic only sees `Actions` enum, never raw keys.
- `InputManager` holds adapters, merges actions
- `KeyboardAdapter` maps key codes → actions
- Designed for extension: gamepad, voice, etc.

---

Default to using uv for Python package management.

- Use `uv run <command>` to run Python scripts
- Use `uv add <package>` to add dependencies
- Use `uv sync` to install dependencies from pyproject.toml
- uv automatically manages virtual environments

## Backend

- Python with Litestar (ASGI framework) + uvicorn
- SSE via `ServerSentEvent` response class
- Static files via `create_static_files_router()`
- WebSocket proxy to Deepgram via `websockets` library
- Environment variables loaded from `.env` via python-dotenv

## Frontend

Pure HTML/JS served as static files. No bundler needed — browser-native ES modules.
- `index.html` loaded at `/`
- `src/` served at `/src/`
- `assets/` served at `/assets/`
