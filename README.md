<img
  src="https://github-readme-stats.hackclub.dev/api/wakatime?username=813&api_domain=hackatime.hackclub.com&&custom_title=Hackatime+Stats&layout=compact&cache_seconds=0&langs_count=8&theme=transparent"
  alt="Ben001109 WakaTime Activity"
/>
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

Interactive console (Node 20+):

```
node scripts/console.mjs
# Choose option 12 “Setup Wizard” to run the former Docker/local bootstrap flow,
# seed monitoring secrets (New Relic/Sentry), and generate env files.
```

Linux-only convenience script (non-interactive) still mirrors the wizard prompts:

```
bash scripts/setup-linux.sh
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
- Bot: Discord bot (no HTTP port; connects to Discord)

## Logging

- API, worker, and bot now stream their pino output to both the terminal and rotating `.log` files under `logs/` (`*-dev.log` when `NODE_ENV !== production`).
- Override the destination directory with `LOG_DIR` or point to an exact file with `LOG_FILE`. Paths can be absolute or resolved relative to the service directory.
- Use `LOG_TO_FILE=false` (or `0`/`off`) to disable file writes entirely; helpful for ephemeral CI environments.
- `LOG_LEVEL` controls both console and file verbosity, while `LOG_FILE_SUFFIX` lets you customise the filename suffix if the `-dev` default is not desired.

## Components (各服務用途)

### API（後端服務）
- Framework: Fastify + Prisma（TypeScript）
- 用途：提供 REST API，處理業務邏輯與資料存取。
- 目前功能：建立玩家（`POST /players`）、健康檢查（`GET /health`）。
- 文件：Swagger UI at `/docs`。

### Worker（背景工作/排程）
- Framework: BullMQ + Redis（TypeScript）
- 用途：定期執行經濟系統 tick、長時間任務、批次運算。
- 目前功能：每隔一段時間（環境變數 `TICK_INTERVAL_MS`）跑一個 `econ-tick` 工作並記錄心跳；未來將在此計算市場價格、帳務批次等。

### Bot（Discord 機器人）
- Framework: discord.js（TypeScript）
- 用途：透過 Discord slash commands 與遊戲互動、呼叫 API 以管理玩家資料。
- 指令：
  - `/ping`：回應 Pong
  - `/init`：為目前 Discord 使用者建立玩家（呼叫 API 的 `POST /players`）
- i18n：支援 en/zh 簡單字串。
- 設定：需要 `DISCORD_BOT_TOKEN`；可選用 `GUILD_ID` 以在指定伺服器快速註冊指令（開發便利）。

### Frontend（前端）
- Framework: Next.js（TypeScript）
- 用途：玩家與管理 UI（目前為基本 i18n 範例與骨架）。未來會串接 API 呈現市場、資產、訂單等資訊。

### PostgreSQL（資料庫）
- 用途：持久化資料，為系統唯一事實來源（source of truth）。
- Prisma schema：玩家、帳戶、總分類帳（double-entry）等。
- 存取：由 API/Worker 經 Prisma 存取。

### Redis（快取／佇列）
- 用途：
  - BullMQ 佇列後端（Worker 用於背景任務、排程）
  - 之後可加入快取、發布/訂閱等用途

### Adminer（資料庫 UI）
- 用途：瀏覽/查詢 Postgres 內容（方便開發/除錯）。
- 連線資訊：連到 `postgres`，使用者 `game`、密碼 `gamepass`、DB `game`。

### Redis Commander（Redis UI）
- 用途：可視化檢視 Redis keys/values。

### Docker Compose（本地環境/Dev Profile）
- 一般模式：啟動 `api`、`worker`、`frontend`、`postgres`、`redis` 等服務。
- Dev Profile：`api-dev`、`worker-dev`、`frontend-dev`、`bot-dev` 以 hot reload 執行，利於快速開發；支援 Adminer 與 Redis Commander。

## Local Development (iterate API/worker)

You can edit files and rebuild the service image, or use the dev profile for hot reload of API/Worker inside containers.

Dev workflow (recommended: interactive console):

```bash
# ensure Node 20 locally if you run tools: see .nvmrc
nvm use || true

# Open the interactive console to start/stop dev, clean, purge, drop dev schema, logs, etc.
node scripts/console.mjs

# Alternatively (non-interactive):
# - Start Docker dev profile without console
docker compose --profile dev up --build -d postgres redis api-dev worker-dev frontend-dev bot-dev adminer redis-commander

# - Only remove dev app containers, keep DB/tools (manual maintenance)
docker compose rm -s -f api-dev worker-dev frontend-dev bot-dev
```

Alternatively, run API/Worker directly on your host (Node 20) and point to the Compose Postgres/Redis using the provided `.env` files in each service.

### Windows Notes (no Docker)

- Use local installs of Postgres/Redis:
  - winget: `winget install -e --id PostgreSQL.PostgreSQL` and `winget install -e --id tporadowski.Redis-64`
  - choco: `choco install postgresql redis-64`
- Update `.env` to use localhost hosts:
  - `DATABASE_URL=postgresql://game:gamepass@localhost:5432/game?schema=public`
  - `REDIS_URL=redis://localhost:6379`
- Then run local dev via the console wizard (choose Local workflow) or manually run `npm install` inside each service.
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

Discord Bot service:

```
cp services/bot/.env.example services/bot/.env.local
echo "DISCORD_BOT_TOKEN=YOUR_NEW_TOKEN" >> services/bot/.env.local
# Optional: fast slash-command updates in one guild
# echo "GUILD_ID=YOUR_DEV_GUILD_ID" >> services/bot/.env.local
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

## Bun + Pterodactyl

You can run services with Bun (lighter, faster cold starts) and deploy on Pterodactyl using a Bun yolk image.

- Added Bun scripts per service:
  - API: `bun:setup`, `bun:dev`, `bun:start`
  - Worker: `bun:dev`, `bun:start`
  - Bot: `bun:dev`, `bun:start`
  - Frontend: `bun:dev`, `bun:build`, `bun:start`

Local with Bun:

```bash
cd services/api && bun install && bun run bun:start
cd services/worker && bun install && bun run bun:start
cd services/bot && bun install && bun run bun:start
cd services/frontend && bun install && bun run bun:build && bun run bun:start
```

Pterodactyl (recommended gist):

- Image: choose a Bun yolk (e.g. a `bun` image from pterodactyl/yolks). Set your env vars (e.g. `DATABASE_URL`, `REDIS_URL`, `DISCORD_BOT_TOKEN`, `PORT`).
- Installer: Git clone this repo into the server directory (or upload) and run `bun install` on first boot.
- Startup command examples (per service directory):
  - API: `bun install --production && bun run bun:start`
  - Worker: `bun install --production && bun run bun:start`
  - Bot: `bun install --production && bun run bun:start`
  - Frontend: `bun install --production && bun run bun:build && bun run bun:start`

Notes:
- API will auto-run Prisma generate + db push via `bun:setup` before starting.
- Ensure Postgres/Redis are reachable from your Pterodactyl node; set correct URLs in env.
