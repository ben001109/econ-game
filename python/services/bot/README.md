# Econ Game Discord Bot (Python)

Slash commands:
- `/ping` – health check.
- `/init` – calls the Python API to provision a player using the caller's Discord username.

## Running locally

```bash
uv sync
DISCORD_BOT_TOKEN=... API_BASE_URL=http://localhost:4000 uv run --project python/services/bot bot-dev
```

Variables are loaded from `.env` if present.
