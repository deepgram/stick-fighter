## Project: Stick Fighter
Basic Street Fighter clone using HTML5 Canvas with stick figure fighters.

### Run
```sh
uv run uvicorn server:app --reload --port 3000
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
