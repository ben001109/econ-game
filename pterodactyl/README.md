Pterodactyl Eggs for Econ Game (Bun)

Usage
- Import one of the JSON eggs under `pterodactyl/eggs/` into your panel.
- Pick a Bun yolk image (e.g. `ghcr.io/parkervcp/yolks:bun_latest`).
- Set `WORK_DIR` to the service folder if you clone the whole repo, or leave `.` if you upload only that service.
- Set environment variables as needed (e.g. API: `DATABASE_URL`, `REDIS_URL`, `PORT`).

Recommended WORK_DIR values
- API: `services/api`
- Worker: `services/worker`
- Bot: `services/bot`
- Frontend: `services/frontend`

Startup defaults
- API/Worker/Bot: `START_CMD=bun:start` (defined in each service package.json)
- Frontend: `START_CMD=bun:start` (build runs before start via egg command)

Notes
- Eggs run `bun install --production` on startup; API runs Prisma generate/db push via its `bun:start` script.
- Ensure your DB/Redis endpoints are reachable from the node that hosts the server.
