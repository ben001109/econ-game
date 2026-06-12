<img
  src="https://github-readme-stats.hackclub.dev/api/wakatime?username=813&api_domain=hackatime.hackclub.com&&custom_title=Hackatime+Stats&layout=compact&cache_seconds=0&langs_count=8&theme=transparent"
  alt="Ben001109 WakaTime Activity"
/>

# Econ Game (Godot-first Economic Simulation)

A current TypeScript service scaffold for a planned Godot-first economic and industry-chain simulation game. Restaurants are the first playable business loop, with NPC suppliers first and a roadmap toward supplier risk, player markets, and playable industry roles. Includes:

- Planned Godot primary Steam client direction for the main player experience
- Current API (TypeScript + Fastify + Prisma) for the restaurant/POS/KDS scaffold; planned Godot/BOT-facing endpoints will be added later
- Current Worker (TypeScript + BullMQ) schedules/logs an `econ-tick` heartbeat; settlement, supplier events, and notifications are planned worker jobs
- PostgreSQL as the source-of-truth persistent database
- Redis as the cache, queue backend, and event/job coordination layer
- Frontend admin/dev tooling (Next.js) for content, operations, and internal testing
- Current Discord bot command modules exist for dev/test flows, but the runtime currently clears slash commands and exits on startup; planned companion scope covers lightweight operations, notifications, leaderboards, and community events
- Standalone shared foundation packages for gameplay rules, content data, and API contracts; services are not yet wired to import them
- Adminer (DB UI) + Redis Commander (Redis UI)

## Quick Start

Prerequisites:

- Docker + Docker Compose
- Node 20+ for the interactive console, setup wizard, and local tooling

## Setup

Interactive console (Node 20+):

```bash
node scripts/console.mjs
# Before Docker/dev Compose, create required env files from examples,
# or use console env-file options first if available.
# Then run the setup/dev workflow from the console.
```

Linux-only convenience script (interactive in a terminal, with non-TTY defaults) mirrors the wizard prompts:

```bash
bash scripts/setup-linux.sh
```

Run the dev profile services:

```bash
docker compose --profile dev up --build -d postgres redis api-dev worker-dev frontend-dev bot-dev adminer redis-commander
```

The default Compose services only start Postgres, Redis, Adminer, and Redis Commander. App services live behind profiles: use `--profile dev` for hot-reload development or `--profile prod` for built service images.

Services:

- API: http://localhost:4000 (Swagger at `/docs`)
- Frontend: http://localhost:3000
- Adminer: http://localhost:8080 (connect to `postgres`, user `game`, pass `gamepass`, DB `game`)
- Redis Commander: http://localhost:8081
- Bot: Discord bot runtime (no HTTP port; currently clears slash commands and exits on startup)

## Logging

- API, worker, and bot write structured pino output to both the terminal and fixed `.log` files under `logs/` (`*-dev.log` when `NODE_ENV !== production`) for direct host runs. Docker Compose disables in-process file logging for those app services because their stdout is already appended to files in `logs/` via `tee`.
- Override the destination directory with `LOG_DIR` or point to an exact file with `LOG_FILE`. Paths can be absolute or resolved relative to the service directory.
- Use `LOG_TO_FILE=false` (or `0`/`off`) to disable file writes entirely; helpful for ephemeral CI environments.
- `LOG_LEVEL` controls both console and file verbosity, while `LOG_FILE_SUFFIX` lets you customise the filename suffix if the `-dev` default is not desired.

## Components (各服務用途)

### API（後端服務）

- Framework: Fastify + Prisma（TypeScript）
- 用途：目前提供 restaurant/POS/KDS scaffold 的 REST API，處理業務邏輯與資料存取；planned Godot/BOT-facing endpoints 會在後續接上 shared/game-core 邊界。
- 目前功能：健康檢查（`GET /health`）、餐廳/菜單瀏覽（`GET /restaurants`, `GET /menus`）、Demo bootstrap（`POST /bootstrap`）、POS 訂單/加菜/付款/查詢端點（`POST /orders`, `POST /orders/:id/items`, `POST /orders/:id/payments`, `GET /orders/:id`）、KDS tickets/actions（`GET /kds/tickets`, `POST /kds/tickets/:id/start`, `POST /kds/tickets/:id/serve`）。
- 文件：Swagger UI at `/docs`。

### Worker（背景工作/排程）

- Framework: BullMQ + Redis（TypeScript）
- 用途：目前提供背景排程 scaffold；settlement、supplier events、notifications 與批次運算是 planned worker jobs。
- 目前功能：每隔一段時間（環境變數 `TICK_INTERVAL_MS`）排程 `econ-tick` queue 的 `tick` job，worker 處理後只記錄 heartbeat-style log。

### Bot（Discord 機器人）

- Framework: discord.js（TypeScript）
- Runtime state：`/ping`、`/ops`、`/pos`、`/kds` command modules exist, but current startup cleanup clears slash commands for guild/global scopes and exits, so companion behavior is not operational yet.
- 用途：planned BOT companion 方向是輕量操作、notifications、leaderboards 與 community events，主要玩家體驗將由 Godot/Steam 承載。
- 邊界：不承載完整 POS/KDS、配方編輯、建造/地圖、玩家市場或全產業鏈管理 UI。
- Command modules：
  - `/ping`：回應 Pong
  - `/ops`：健康檢查與 demo bootstrap 等營運/開發輔助
  - `/pos`：目前的內部 dev/test POS 指令，用於驗證訂單、加菜與付款流程
  - `/kds`：目前的內部 dev/test KDS 指令，用於檢視、start、serve tickets
- 產品方向：planned future bot 仍維持 companion-only，聚焦狀態查詢、低庫存、供應商 deals、補貨、leaderboards、notifications 與 community events。
- i18n：支援 en/zh 簡單字串。
- 設定：需要 `DISCORD_BOT_TOKEN`；registration handler supports `GUILD_ID` for guild-scoped slash command registration, but the earlier cleanup startup currently clears commands and exits, so that cleanup must be fixed/removed before normal command serving。

### Frontend（前端）

- Framework: Next.js（TypeScript）
- 用途：admin/dev tooling，用於內容、營運、除錯、Demo bootstrap 與內部測試；不是主要玩家入口。

### PostgreSQL（資料庫）

- 用途：持久化資料，為系統唯一事實來源（source of truth）。
- Prisma schema：目前是 restaurant/POS/KDS foundation，包含 Restaurant、Branch、Table、MenuItem、Order、OrderItem、Payment、TaxLine、Tip，以及 OrderType、OrderStatus、PaymentMethod enums。
- 存取：目前由 API 經 Prisma 存取；Worker 現階段只使用 Redis/BullMQ heartbeat，planned settlement/supplier jobs 才會需要 DB/Prisma access。

### Redis（快取／佇列）

- 用途：
  - BullMQ 佇列後端（Worker 用於背景任務、排程）
  - 之後可加入快取、發布/訂閱等用途

### Shared Packages（共享遊戲邊界）

- Status：these packages currently exist as standalone foundation package boundaries and are not yet wired into API、Worker、Bot、Frontend 或 planned Godot client code.
- `packages/game-core`：pure gameplay rules、state transitions、economy calculations 與 validation；future service integration point for API、Worker、Bot 與 planned Godot endpoints，避免 route handlers 或 companion commands 擁有核心規則。
- `packages/content`：目前包含 base ingredients、one NPC supplier（Morning Market）與 menu items；regions、events 與 DLC-style packs 是 planned future content。
- `packages/shared`：API DTOs、status codes 與 shared types；future integration point for keeping Godot、BOT、Frontend admin/dev tooling 與後端服務的 contract 一致。

### Adminer（資料庫 UI）

- 用途：瀏覽/查詢 Postgres 內容（方便開發/除錯）。
- 連線資訊：連到 `postgres`，使用者 `game`、密碼 `gamepass`、DB `game`。

### Redis Commander（Redis UI）

- 用途：可視化檢視 Redis keys/values。

### Docker Compose（本地環境/Dev Profile）

- 無 profile：啟動 `postgres`、`redis`、Adminer 與 Redis Commander 等共用基礎服務。
- Dev Profile：`api-dev`、`worker-dev`、`frontend-dev`、`bot-dev` 以 hot reload 執行，利於快速開發；支援 Adminer 與 Redis Commander。
- Prod Profile：`api`、`worker`、`frontend`、`bot` 使用各服務 Dockerfile 建置後執行。

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

Alternatively, run API/Worker directly on your host (Node 20) while Postgres/Redis stay in Compose: copy the service env files first, then change Docker service hostnames to localhost (`postgres` -> `localhost`, `redis` -> `localhost`) as shown in the Windows/local notes below.

When running `bot-dev` in the dev profile, set `API_BASE_URL=http://api-dev:4000` in `services/bot/.env.local` because `bot-dev` depends on the `api-dev` service name inside the Compose network. For the prod profile use `http://api:4000`; for the Bun profile use `http://api-bun:4000`.

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

Services have lint and format scripts:

```bash
(cd services/api && npm run lint && npm run format)
(cd services/worker && npm run lint && npm run format)
(cd services/frontend && npm run lint && npm run format)
(cd services/bot && npm run lint && npm run format)
```

Shared packages participate in build/lint/test where scripts exist. Formatting scripts are not defined for every package, so use the package-specific scripts accurately:

```bash
(cd packages/game-core && npm run lint && npm run build && npm test)
(cd packages/content && npm run lint && npm run build)
(cd packages/shared && npm run lint && npm run build)
```

## CI

GitHub Actions runs on push/PR:

- Current Node CI jobs: install deps, lint, run tests if present, and build `api`, `worker`, `frontend`, `bot`, plus `packages/game-core`, `packages/content`, and `packages/shared` on Linux and Windows matrices.
- Current Docker CI job: builds default and Bun service images for `api`, `worker`, `frontend`, and `bot` with `push: false`; shared packages are validated by the Node matrix.
- Roadmap CI work may add image publishing/push steps when release automation is ready.

## Secrets & Env

- Do not commit secrets. Place sensitive values in `.env.local` per service; these files are git-ignored.
- API, worker, and frontend Compose services require both their service `.env` and `.env.local` files because `docker-compose.yml` lists both in `env_file`; create `.env` from each `.env.example` and create `.env.local` files even if they are empty local overrides.
- For `frontend-bun`, `NEXT_PUBLIC_API_URL` is different from normal runtime env because Next.js bakes `NEXT_PUBLIC_*` values into browser code during the Docker image build. Compose passes it through `build.args` using root Compose interpolation (`${NEXT_PUBLIC_API_URL:-http://localhost:4000}`), so editing only `services/frontend/.env` or `.env.local` is not enough for the Bun image. Before running `docker compose --profile bun build frontend-bun` or `docker compose --profile bun up --build frontend-bun`, either export it in your shell (`export NEXT_PUBLIC_API_URL=http://localhost:4000`) or define it in the root Compose `.env` file.
- Bot Compose services currently load only `services/bot/.env.local` because `services/bot/.env` is commented out in `docker-compose.yml`; create `services/bot/.env.local` from its example and fill the token/API URL values there.
- Examples are provided as `services/*/.env.example`.

API/worker/frontend Compose env setup:

```bash
cp services/api/.env.example services/api/.env
cp services/worker/.env.example services/worker/.env
cp services/frontend/.env.example services/frontend/.env
touch services/api/.env.local services/worker/.env.local services/frontend/.env.local
```

Discord Bot service:

```bash
cp services/bot/.env.example services/bot/.env.local
# Edit existing DISCORD_BOT_TOKEN= and API_BASE_URL= values in services/bot/.env.local.
# Dev profile: API_BASE_URL=http://api-dev:4000
# Prod profile: API_BASE_URL=http://api:4000
# Bun profile: API_BASE_URL=http://api-bun:4000
# GUILD_ID= is supported by the registration handler for guild-scoped commands,
# but current runtime cleanup must be fixed/removed before normal serving.
```

GitHub Actions: store secrets under Repo → Settings → Secrets and variables → Actions, e.g. `DISCORD_BOT_TOKEN`. If a job needs it, inject via `env: DISCORD_BOT_TOKEN: ${{ secrets.DISCORD_BOT_TOKEN }}`.

## Tech Overview

- Planned client direction: Godot/Steam is the primary client. The planned Godot application will own startup, UI flow, runtime state, and the main restaurant management loop.
- Planned companion direction: Discord bot stays companion-only for lightweight operations, notifications, leaderboards, and community events; current `/pos` and `/kds` commands are internal dev/test tools.
- Architecture: modular monorepo with API + Worker handling the current restaurant/POS/KDS scaffold and heartbeat jobs; planned settlement/supplier jobs should be wired to `packages/game-core` rules and deterministic state transitions. Postgres is the source of truth; Redis is cache + queue.
- Shared boundaries: `packages/game-core`, `packages/content`, and `packages/shared` are standalone foundation packages, not yet wired into services. `packages/content` currently carries ingredients, menu data, and one NPC supplier; planned content includes regions, events, and DLC-style packs.
- Economics: starts with the restaurant loop and NPC supplier procurement, then expands into supplier risk, regional variation, player markets, and playable industry roles such as farms, fisheries, logistics, wholesalers, and central kitchens.
- i18n: frontend admin/dev tooling demonstrates locale routing and string catalogs; backend returns code-based messages for Godot/BOT/Frontend localization.

## Next Steps

- Wire restaurant simulation and supplier actions from `packages/game-core` into API, Worker, Bot, and planned Godot-facing endpoints so they share one rule boundary.
- Add planned Godot-facing endpoints for restaurant state, supplier deals, restock actions, settlement results, unlock progress, and save/sync metadata.
- Keep future product Discord bot scope focused on companion commands such as `/status`, `/daily`, `/inventory low`, `/supplier deals`, `/restock`, `/leaderboard`, and event notifications.
- Continue API + Worker persistence/jobs around Postgres source-of-truth and Redis cache/queue semantics.

## Bun + Pterodactyl

You can run services with Bun (lighter, faster cold starts) and deploy on Pterodactyl using a Bun yolk image.

- Added Bun scripts per service:
  - API: `bun:setup`, `bun:dev`, `bun:start`
  - Worker: `bun:dev`, `bun:start`
  - Bot: `bun:dev`, `bun:start`
  - Frontend: `bun:dev`, `bun:build`, `bun:start`

Local with Bun:

```bash
(cd services/api && bun install && bun run bun:start)
(cd services/worker && bun install && bun run bun:start)
(cd services/bot && bun install && bun run bun:start)
(cd services/frontend && bun install && bun run bun:build && bun run bun:start)
```

Pterodactyl (recommended gist):

- Image: choose a Bun yolk (e.g. a `bun` image from pterodactyl/yolks). Set service-specific env vars: API needs `DATABASE_URL` and `PORT` (`REDIS_URL` is optional/future for API); frontend needs `NEXT_PUBLIC_API_URL` set before build if the API is not localhost or reverse-proxied, and its egg starts Next with `bunx next start -p {{PORT}}`; worker needs `REDIS_URL` plus database settings as applicable; bot needs `DISCORD_BOT_TOKEN` and `API_BASE_URL` pointing to a reachable API service once normal startup serving is fixed.
- Installer: Git clone this repo into the server directory (or upload), set `WORK_DIR` to the target service directory, and run install/start commands inside that service directory.
- Startup command examples (per service directory):
  - API: `bun install --production && bun run bun:start`
  - Worker: `bun install --production && bun run bun:start`
  - Bot: `bun install --production && bun run bun:start`
  - Frontend: `bun install && bun run bun:build && bunx next start -p {{PORT}}`

Notes:

- API will auto-run Prisma generate + db push via `bun:setup` before starting.
- Ensure required Postgres/Redis services are reachable from your Pterodactyl node; current API runtime needs `DATABASE_URL` and `PORT`, while worker queue processing needs `REDIS_URL`.
- Bot has no HTTP port; do not set `PORT` for it unless a future bot HTTP listener is added. Its `API_BASE_URL` should not use `localhost` unless the API is colocated on the same server/network namespace.
- The frontend build needs a full `bun install` before `bun run bun:build` because Next/TypeScript build tooling lives in devDependencies. `NEXT_PUBLIC_API_URL` is a Next.js public build-time value, so Docker Compose passes it as a Bun frontend build arg (`${NEXT_PUBLIC_API_URL:-http://localhost:4000}`) from the shell or root Compose `.env`; service-level `services/frontend/.env` and `.env.local` are runtime `env_file` inputs and do not change the already-built browser bundle. Pterodactyl users must also set it before the egg runs the build.
