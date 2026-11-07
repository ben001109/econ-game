# Econ Game Discord Bot (Python)

Slash commands:
- `/ping` – health check.
- `/init` – calls the Python API to provision a player using the caller's Discord username.

## Running locally

```bash
uv sync
uv run --project python/services/bot bot-dev
```

Provide `DISCORD_BOT_TOKEN` through an owner-only, untracked `.env` or the deployment platform's protected secret mechanism. `API_BASE_URL` is also required. Do not place credentials in the command line.
