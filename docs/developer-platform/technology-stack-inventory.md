# Technology Stack Inventory

> **Status:** active inventory; does not authorize product implementation
>
> **Owner:** Build/CI maintains runtime evidence; service owners maintain manifest evidence; Docs maintains this inventory and the [source map](../skills/source-map.md)
>
> **Last checked:** 2026-08-01
>
> **Method:** read non-secret source, manifests, lockfiles, CI, Docker/Compose, Pterodactyl eggs, and the accessible Econ Game task histories. No environment files, credentials, services, databases, queues, migrations, or deployments were accessed.

## Adoption boundary

The architecture record names the Node/TypeScript line as the formal product direction. The Python/uv files are a parallel preview and are inventoried for maintenance visibility, not adopted as an alternative product line. The current Node restaurant routes are also a scaffold rather than the approved future game contract. See [the Architecture decision register](../architecture/decision-register.md) and [the SDK boundary](../sdk/current-http-surface.md).

## Runtime and package management

| Area | Evidence and observed version | Maintenance note |
|---|---|---|
| Node.js | `.nvmrc`, CI, Compose, and Node Dockerfiles declare Node 20; local inspection observed Node 22.23.1 | Node 20 reached EOL on 2026-03-24; local/CI drift needs a Build/Architecture decision before changing supported runtime. |
| npm | Four independent Node service lockfiles use lockfile v3; local npm observed 10.9.8 | No root npm workspace or shared dependency policy exists. The SDK is deliberately an independent package. |
| TypeScript | All Node services declare TypeScript 5.9.3; the SDK pins 5.9.3 | Service tsconfigs target ES2022. API/worker/bot use bundler resolution; SDK uses NodeNext ESM declarations. |
| Bun | Node service manifests have Bun scripts; Bun Dockerfiles and Pterodactyl eggs exist | Pterodactyl eggs offer `bun_latest` and `bun_canary`, so no stable Bun version is pinned; Bun has no CI matrix. |
| Python | Root uv workspace requires Python >=3.12; Dockerfiles and Python eggs use Python 3.12 | Preview only. `uv.lock` records resolved versions; do not treat this as a migration instruction. |
| Containers | Node 20 Alpine/Bullseye/Bookworm images; Postgres 16 Alpine; Redis 7 Alpine; Adminer 4; Redis Commander latest | Deployment/startup paths containing `db push` remain unsafe for production and are not verification commands. |

## Node/TypeScript services

All versions below come from each service's `package.json`; a caret indicates the declared range, not a proof of the installed newest version. Lockfiles provide the reproducible resolution for that service.

| Service | Runtime libraries | Tooling | Current responsibility / implementation evidence |
|---|---|---|---|
| API (`services/api`) | Fastify ^5.6.1; `@fastify/cors` ^11.1.0; `@fastify/swagger` ^9.5.2; Swagger UI ^5.2.3; Prisma/client ^6.18.0; ioredis ^5.8.2; Zod ^4.1.12; Pino ^10.1.0; Sentry Node ^10.22.0; New Relic ^13.6.2; dotenv ^17.2.3 | TypeScript ^5.9.3; tsx ^4.20.6; ESLint ^9.39.0 plus TypeScript/import/Prettier configs; Prettier ^3.6.2; Node types ^24.9.2 | Fastify REST/Swagger route host; current scaffold exposes restaurant, POS, payment, and KDS endpoints; Prisma schema is PostgreSQL-specific. |
| Worker (`services/worker`) | BullMQ ^5.63.0; ioredis ^5.8.2; Prisma/client ^6.18.0; Pino ^10.1.0; Sentry Node ^10.22.0; New Relic ^13.6.2; dotenv ^17.2.3 | Same TypeScript/ESLint/Prettier/tsx family as API | Redis-backed scheduled `econ-tick` placeholder. Current worker does not define a completed game-economy contract. |
| Bot (`services/bot`) | discord.js ^14.24.2; Pino ^10.1.0; Sentry Node ^10.22.0; New Relic ^13.6.2; dotenv ^17.2.3 | TypeScript ^5.9.3; ESLint/Prettier/tsx; `@types/newrelic` and Node types | Discord command host. Current commands directly call the Node API; this is repeated consumer evidence for the internal SDK. |
| Frontend (`services/frontend`) | Next.js ^16.0.1; React/React DOM ^19.2.0; Sentry Next.js ^10.22.0 | TypeScript ^5.9.3; ESLint ^9.39.0 with Next/TypeScript/import/Prettier configs; Prettier ^3.6.2 | Pages-router UI and locale JSON. POS/KDS pages currently call Node API routes directly. |

### Node data, queue, and observability dependencies

- Prisma points at PostgreSQL in `services/api/prisma/schema.prisma`; Compose provisions PostgreSQL 16 and Redis 7. The formal platform target is Supabase PostgreSQL, but Supabase client packages and RLS/migration workflow are not yet in service manifests.
- BullMQ plus ioredis are used by the Node worker; Redis also exists as API runtime dependency.
- Pino, Sentry, and New Relic appear in API/worker/bot; Sentry Next.js appears in frontend. CI verifies lint/build only, not telemetry delivery.
- Runtime Swagger is useful for local discovery but is not a version-controlled contract artifact. The SDK's `check:surface` reads current route declarations instead of treating Swagger UI as a stable source.

## Python/uv preview

Resolved versions below are from `uv.lock`; declared lower bounds are in the service `pyproject.toml` files.

| Preview service | Main runtime packages | Development packages | Current implementation |
|---|---|---|---|
| API (`python/services/api`) | FastAPI 0.121.1; Uvicorn 0.38.0; SQLModel 0.0.27; SQLAlchemy 2.0.44; asyncpg 0.30.0; Redis 7.0.1; Pydantic 2.12.4 / Settings 2.12.0; python-json-logger 4.0.0 | pytest 9.0.0; HTTPX 0.28.1; AnyIO 4.11.0; Ruff 0.14.4 | Health plus create/read player routes; separate shape from Node API. |
| Worker (`python/services/worker`) | SQLModel/SQLAlchemy; asyncpg; Redis; Pydantic Settings; python-json-logger | pytest; AnyIO; Ruff | Async loop records and publishes preview economic ticks. |
| Bot (`python/services/bot`) | discord.py 2.6.4; HTTPX; Pydantic Settings | Ruff | Python Discord client calls the preview player API. |
| Frontend (`python/services/frontend`) | FastAPI; Uvicorn; Jinja2 3.1.6; HTTPX; Pydantic Settings | Ruff | Small server-rendered health UI. |

The resolved workspace also includes common HTTP/ASGI support such as Starlette 0.49.3, HTTP Core 1.0.9, h11 0.16.0, uvloop 0.22.1, watchfiles 1.1.1, and websockets 15.0.1. This detail is inventory only; no Python service was run.

## Build, CI, deployment, and developer tooling

| Component | Current fact | Gap or safety boundary |
|---|---|---|
| GitHub Actions | Ubuntu and Windows matrix for API, worker, frontend, bot; Node from `.nvmrc`; installs with `--ignore-scripts`; Prisma generate when a script exists; lint and build; then Linux Docker image build | CI does not run service tests, SDK verification, Bun, or Python preview checks. Do not claim CI parity beyond the listed commands. |
| Docker Compose | Node compose defines prod/dev/Bun profiles plus Postgres, Redis, Adminer, Redis Commander; Python compose mirrors preview services | Review statically unless a separately authorized environment run is requested. Current API startup uses `db push`, which is not a production-safe migration command. |
| Pterodactyl | Eight eggs: four Bun and four Python 3.12; Python eggs invoke `uv sync --frozen --no-dev` when lock exists | Eggs are deployment templates, not evidence of successful deployment or an approved runtime policy. |
| Repository scripts | `scripts/quality-gate.mjs` has a default-safe Node command preflight; `console.mjs`, `doctor.mjs`, and Linux setup script contain broader local orchestration | Use only the documented quality-gate preflight without separate authorization. Do not run interactive or stateful helpers as SDK verification. |
| Internal SDK | `packages/econ-game-sdk`: dependency-free TypeScript ESM, declaration output, mock-fetch tests, source-only route check, package dry-run | It is private/internal and 0.x. It does not supply a public OpenAPI artifact, shared persistence model, or future game contract. |

## Official documentation and update triggers

The [source map](../skills/source-map.md) links official vendor/project documentation for Node, TypeScript, Fastify, Prisma, PostgreSQL, Supabase, Clerk, Discord, BullMQ, Redis, Next.js, React, npm, GitHub Actions, Docker, Bun, Pterodactyl, uv, and FastAPI. Update this inventory and the source map together when any of the following changes:

1. A service manifest, lockfile, Docker base image, Compose profile, Pterodactyl egg, CI matrix, or `.nvmrc` changes.
2. A runtime reaches EOL, a major version changes, or the Build owner changes the supported runtime policy.
3. The formal product line adopts or removes a platform (especially Python preview, Supabase, Clerk, or Bun).
4. The SDK route surface, package topology, compatibility policy, or consumer boundary changes.

For a no-service verification sequence, use [the safe development runbook](../runbooks/development-environment-and-safe-validation.md), then `npm run verify` from `packages/econ-game-sdk` when its pinned development dependency is installed. Run `git diff --check` after documentation or SDK changes.
