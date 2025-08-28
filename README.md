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
- Bot: Discord bot (no HTTP port; connects to Discord)

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

Dev profile (hot reload with ts-node-dev):

```bash
# ensure Node 20 locally if you run tools: see .nvmrc
nvm use || true

# start only dev API/Worker/Bot (avoid port conflicts with prod services)
docker compose --profile dev up --build postgres redis api-dev worker-dev frontend-dev bot-dev adminer redis-commander

# Services:
# - api-dev: runs `npm run dev` with Prisma generate + db push
# - worker-dev: runs `npm run dev`
# - frontend-dev: runs Next.js dev server
# - bot-dev: runs Discord bot with hot reload
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

Discord Bot service:

```
cp services/bot/.env.example services/bot/.env.local
echo "DISCORD_BOT_TOKEN=YOUR_NEW_TOKEN" >> services/bot/.env.local
# Optional: fast slash-command updates in one guild
# echo "GUILD_ID=YOUR_DEV_GUILD_ID" >> services/bot/.env.local
```
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
