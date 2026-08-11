# Econ Game API (Python)

Feature parity goals:
- `GET /health` for readiness/liveness probes.
- `POST /players` to create players backed by Postgres.
- (stub) `GET /players/{player_id}` for quick verification.

## Development

```bash
# At repo root
uv sync
uv run --project python/services/api api-dev
```

## Environment

Copy `.env.example` to `.env` or set vars some other way.

```
DATABASE_URL=postgresql+asyncpg://game:gamepass@localhost:5432/game
REDIS_URL=redis://localhost:6379/0
PORT=4000
LOG_LEVEL=info
```

## Scripts

- `uv run --project python/services/api api-dev` – reload server (uvicorn)
- `uv run --project python/services/api api-prod` – production server (no autoreload)
- `uv run --project python/services/api pytest` – run tests once you add them
