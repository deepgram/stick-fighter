FROM python:3.11-slim

WORKDIR /app

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Install dependencies
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# Copy application
COPY server.py .
COPY auth.py .
COPY characters.py .
COPY elo.py .
COPY game_loop.py .
COPY matchmaking.py .
COPY room_cleanup.py .
COPY room_manager.py .
COPY signaling.py .
COPY game_engine/ game_engine/
COPY index.html .
COPY src/ src/
COPY assets/ assets/
COPY public/ public/

EXPOSE 8080

CMD [".venv/bin/uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
