<img
  src="https://github-readme-stats.hackclub.dev/api/wakatime?username=813&api_domain=hackatime.hackclub.com&&custom_title=Hackatime+Stats&layout=compact&cache_seconds=0&langs_count=8&theme=transparent"
  alt="Ben001109 WakaTime Activity"
/>
# Econ Game

A restaurant tycoon game with a real-world-like economic system, played through Discord first.

- **Bot**: Discord slash commands (discord.js), the only player interface until milestone M1 is done
- **API**: TypeScript, Fastify, Prisma
- **Worker**: TypeScript, BullMQ (market ticks, day replay verification)
- **PostgreSQL** (source of truth) and **Redis** (cache and queue)
- Optional tools: Adminer (DB UI), Redis Commander (Redis UI)

Direction, milestones, and where the frontend, Bun, Python, and Godot work went: [docs/roadmap.md](docs/roadmap.md).

## Setup

Prerequisites: Node 22 (see `.nvmrc`), Docker with Docker Compose.

Interactive console:

```bash
node scripts/console.mjs
# Choose "Setup Wizard" to bootstrap Docker or local development,
# seed monitoring settings (New Relic/Sentry), and generate env files.
```

Linux convenience script with the same prompts:

```bash
bash scripts/setup-linux.sh
```

Create a private, untracked root `.env` with the required connection credentials described in [the container secret-boundary guide](docs/operations/container-secret-boundary.md), then run:

```bash
docker compose --profile prod up --build
```

Services:

- API: http://localhost:4000 (Swagger at `/docs`)
- Bot: connects to Discord (no HTTP port)
- Adminer and Redis Commander: disabled by default; enable the `tools` profile explicitly and keep the loopback bind

## Local development

Dev profile with hot reload:

```bash
nvm use || true
docker compose --profile dev up --build -d postgres redis api-dev worker-dev bot-dev
# remove only the dev app containers, keep DB/tools
docker compose rm -s -f api-dev worker-dev bot-dev
```

Or run the services on your host against the Compose Postgres/Redis using each service's env files. Environment check: `node scripts/doctor.mjs`.

Windows without Docker: install Postgres and Redis locally (`winget install -e --id PostgreSQL.PostgreSQL`, `winget install -e --id tporadowski.Redis-64`), point the private `.env` URLs at localhost, then use the console's Local workflow.

## Components（各服務用途）

### Bot（Discord 機器人）
- `/game status|open|advance|settle|replay|replay-status`：查看狀態、開店、推進營業時段、日結、請求與查詢 Day replay
- `/ops health`：檢查 API 健康狀態
- `/ping`
- 需要 `DISCORD_BOT_TOKEN`；可選用 `GUILD_ID` 在指定伺服器快速註冊指令

### API（後端服務）
- Fastify + Prisma。統一 command envelope（idempotency key、expected version）、server 端推導身份與權限、雙分錄 ledger、outbox 與 replay
- Swagger UI at `/docs`

### Worker（背景工作）
- BullMQ + Redis。market tick、Day replay 驗證等非同步 job

### PostgreSQL／Redis
- PostgreSQL 為唯一事實來源，經 Prisma migrations 管理；schema 變更只能透過審查過的 migration（`npm run db:migrate:deploy`），啟動時不會改 schema
- Redis 為 BullMQ 佇列後端與快取

## Logging

- API, worker, and bot stream pino output to the terminal and to rotating `.log` files under `logs/` (`*-dev.log` when `NODE_ENV !== production`).
- `LOG_DIR` overrides the directory and `LOG_FILE` sets an exact file; paths can be absolute or relative to the service directory.
- `LOG_TO_FILE=false` (or `0`/`off`) disables file writes.
- `LOG_LEVEL` controls verbosity; `LOG_FILE_SUFFIX` replaces the `-dev` suffix.

## Lint, test, CI

```bash
cd services/api && npm run lint && npm run typecheck && npm test
cd services/worker && npm run lint && npm run typecheck && npm test
cd services/bot && npm run lint && npm run typecheck && npm test
cd packages/econ-game-sdk && npm run verify
```

GitHub Actions runs supply-chain policy, migration safety, per-service format/lint/typecheck/test/build, SDK verification, and Docker image builds (no push).

## Secrets & Env

- Never commit secrets. Put sensitive values in each service's `.env.local`; all `.env*` files except examples are git-ignored.
- Compose loads each service's `.env` then `.env.local`.
- Copy `services/*/.env.example` to `.env.local` and fill in values.
- The worker does not use a Discord token. Do not copy Bot credentials into worker env files.

Create the Bot's env file with owner-only permissions:

```bash
install -m 600 services/bot/.env.example services/bot/.env.local
```

Edit it without putting the token in shell history. Hosted deployments must inject it through the platform's protected secret field. For GitHub Actions, store it under Repo → Settings → Secrets and variables → Actions and inject it with `env: DISCORD_BOT_TOKEN: ${{ secrets.DISCORD_BOT_TOKEN }}`.
