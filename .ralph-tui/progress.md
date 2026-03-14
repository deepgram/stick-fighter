# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

- **BASE_URL env var pattern**: Use `os.environ.get("BASE_URL", "").rstrip("/") or str(request.base_url).rstrip("/")` for canonical URL generation. Already used in Twilio webhooks and room creation.
- **Jest invocation**: Must use `node --experimental-vm-modules node_modules/.bin/jest` (not `npx jest --experimental-vm-modules`).
- **TestClient fixtures**: `room_client` fixture injects fakeredis-backed RoomManager. Use `monkeypatch` for env var tests.

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

