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

You can edit files and rebuild the service image, or run services locally (Node 20) pointing to the Compose Postgres/Redis by using the `.env` values.

## Tech Overview

- Architecture: modular monolith (API + Worker), evented via Redis/BullMQ. Postgres is source-of-truth; Redis is cache + queue.
- Economics: double-entry ledger tables to guarantee accounting correctness; worker schedules periodic ticks to evolve markets.
- i18n: frontend demonstrates locale routing and string catalogs; backend returns code-based messages for client-side localization.

## Next Steps

- Implement domain modules (markets, commodities, production chains).
- Add auth/session, rate limiting, and per-locale pricing/tax models.
- Introduce event sourcing and snapshotting for audit/history at scale.

