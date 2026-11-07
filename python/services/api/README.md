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

Provide `DATABASE_URL` and `REDIS_URL` through an owner-only, untracked `.env` or the deployment platform's protected secret mechanism. `PORT` and `LOG_LEVEL` are non-secret runtime settings. Do not place connection credentials in commands or documentation.

## Scripts

- `uv run --project python/services/api api-dev` – reload server (uvicorn)
- `uv run --project python/services/api api-prod` – production server (no autoreload)
- `uv run --project python/services/api pytest` – run tests once you add them
