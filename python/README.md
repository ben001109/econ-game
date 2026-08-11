# Econ Game Python Workspace

This directory hosts the Python re-implementation of the Econ Game stack. It mirrors the existing TypeScript services (API, worker, frontend, and Discord bot) but is managed entirely with [uv](https://docs.astral.sh/uv/), Docker, and Pterodactyl-ready artifacts.

## Structure

```
python/
  services/
    api/         # FastAPI service exposing REST endpoints
    worker/      # Async tick runner that coordinates economic loops
    frontend/    # FastAPI + Jinja UI shell for prototyping dashboards
    bot/         # Discord bot that proxies actions into the API
```

Each service is an isolated `pyproject` member that shares the root uv workspace defined in `/pyproject.toml`.

## Common Tasks

```bash
# Install/resolve all Python dependencies
uv sync

# Run an app (example: API) from the repo root
uv run --project python/services/api api-dev
```

Once you add tooling (pytest, Ruff, etc.) to a given service, run it with the same `--project` flag, e.g. `uv run --project python/services/api pytest`.

Services expose scripts in their `pyproject.toml` via `tool.uv.scripts`, so you can also issue:

```bash
uv run --project python/services/api api-dev
uv run --project python/services/worker worker-dev
uv run --project python/services/bot bot-dev
uv run --project python/services/frontend frontend-dev
```

## Unified Supervisor

To launch multiple services at once, use the helper script:

```bash
python python/main.py                  # start api, worker, frontend, bot (dev mode)
python python/main.py api worker       # start a subset
python python/main.py --mode prod bot  # run the bot with its prod script
python python/main.py --list           # show available service names
```

The supervisor shells out to `uv run --project ...` for each service, wiring graceful shutdown on `Ctrl+C`.

## Docker

The `docker-compose.python.yml` file declares build targets for every Python service alongside Postgres/Redis/Adminer. Use:

```bash
docker compose -f docker-compose.python.yml up --build
```

The compose file reuses the same persistent volumes and port mappings as the original Node setup so you can flip between stacks without dropping data.

## Pterodactyl

Python-specific eggs live under `pterodactyl/eggs/*python*.json`. Each egg relies on a Python 3.12 yolk and executes `uv sync --frozen` before starting the relevant script (API, worker, frontend, or bot). See `pterodactyl/README.md` for detailed steps.
