# Econ Game Worker (Python)

A lightweight async process that executes recurring economic ticks. Each tick writes a ledger row to Postgres and broadcasts its completion over Redis pub/sub so downstream services (bot, frontend) can react.

## Running locally

```bash
uv sync
uv run --project python/services/worker worker-dev
```

Configuration variables live in `.env.example`.
