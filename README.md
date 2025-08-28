# Econ Game (Containerized Scaffold)

A starter monorepo for a tycoon/management game with a real-world-like economic system. Includes:

- API (TypeScript + Fastify + Prisma)
- Worker (TypeScript + BullMQ for scheduled economic ticks)
- PostgreSQL (persistent DB)
- Redis (cache + queue backend)
- Frontend (Next.js with basic i18n stub)
- Adminer (DB UI) + Redis Commander (Redis UI)

## Quick Start

Prerequisites:

- Docker + Docker Compose

## Setup

Cross-platform setup script (Node 20+):

```
node scripts/setup.mjs --docker           # build + start containers
node scripts/setup.mjs --docker --dev     # dev profile (hot reload)

node scripts/setup.mjs --local            # install deps + prisma generate
node scripts/setup.mjs --local --start-db # start Postgres+Redis via Docker
node scripts/setup.mjs --local --db-push  # prisma db push (DB must be up)

# auto-pick (prefers docker dev if available)
node scripts/setup.mjs
```

Run:

```bash
cd econ-game
docker compose up --build
```

Services:

- API: http://localhost:4000 (Swagger at `/docs`)
- Frontend: http://localhost:3000
- Adminer: http://localhost:8080 (connect to `postgres`, user `game`, pass `gamepass`, DB `game`)
- Redis Commander: http://localhost:8081

## Local Development (iterate API/worker)

You can edit files and rebuild the service image, or use the dev profile for hot reload of API/Worker inside containers.

Dev profile (hot reload with ts-node-dev):

```bash
# ensure Node 20 locally if you run tools: see .nvmrc
nvm use || true

# start only dev API/Worker (avoid port conflicts with prod services)
docker compose --profile dev up --build postgres redis api-dev worker-dev frontend-dev adminer redis-commander

# Services:
# - api-dev: runs `npm run dev` with Prisma generate + db push
# - worker-dev: runs `npm run dev`
# - frontend-dev: runs Next.js dev server
```

Alternatively, run API/Worker directly on your host (Node 20) and point to the Compose Postgres/Redis using the provided `.env` files in each service.

### Windows Notes (no Docker)

- Use local installs of Postgres/Redis:
  - winget: `winget install -e --id PostgreSQL.PostgreSQL` and `winget install -e --id tporadowski.Redis-64`
  - choco: `choco install postgresql redis-64`
- Update `.env` to use localhost hosts:
  - `DATABASE_URL=postgresql://game:gamepass@localhost:5432/game?schema=public`
  - `REDIS_URL=redis://localhost:6379`
- Then run local dev: `node scripts/setup.mjs --local`
- Environment check: `node scripts/doctor.mjs`

## Lint & Format

Each service has lint/format scripts:

```bash
cd services/api && npm run lint && npm run format
cd services/worker && npm run lint && npm run format
cd services/frontend && npm run lint && npm run format
```

## CI

GitHub Actions runs on push/PR:
- Node job: installs deps, lints and builds for api/worker/frontend.
- Docker job: builds images for each service (no push).

## Secrets & Env

- Do not commit secrets. Place sensitive values in `.env.local` per service; these files are git-ignored.
- Compose overlays service envs: each service loads `.env` then `.env.local` (overrides).
- Examples are provided as `services/*/.env.example` — copy to `.env.local` and fill values.

Discord Bot Token example (worker):

```
cp services/worker/.env.example services/worker/.env.local
echo "DISCORD_BOT_TOKEN=YOUR_NEW_TOKEN" >> services/worker/.env.local
```

GitHub Actions: store secrets under Repo → Settings → Secrets and variables → Actions, e.g. `DISCORD_BOT_TOKEN`. If a job needs it, inject via `env: DISCORD_BOT_TOKEN: ${{ secrets.DISCORD_BOT_TOKEN }}`.

## Tech Overview

- Architecture: modular monolith (API + Worker), evented via Redis/BullMQ. Postgres is source-of-truth; Redis is cache + queue.
- Economics: double-entry ledger tables to guarantee accounting correctness; worker schedules periodic ticks to evolve markets.
- i18n: frontend demonstrates locale routing and string catalogs; backend returns code-based messages for client-side localization.

## Next Steps

- Implement domain modules (markets, commodities, production chains).
- Add auth/session, rate limiting, and per-locale pricing/tax models.
- Introduce event sourcing and snapshotting for audit/history at scale.
