# Pterodactyl Eggs for Econ Game (Bun)

## Usage
- Import one of the JSON eggs under `pterodactyl/eggs/` into your panel.
- Pick a Bun yolk image (e.g. `ghcr.io/parkervcp/yolks:bun_latest`).
- If you clone or mount the whole repo, set `WORK_DIR` to `services/api`, `services/worker`, `services/bot`, or `services/frontend`. Leave `WORK_DIR=.` only when you upload a single service directory.
- When uploading a single service with `WORK_DIR=.`, set `LOG_DIR=./logs` or `LOG_TO_FILE=false` for API, worker, and bot deployments. Their logger defaults write to `../../logs`, which is correct from `services/<name>` in a full repo but resolves outside the Pterodactyl server directory when only service contents are uploaded.
- Set environment variables as needed (e.g. API: `DATABASE_URL`, `REDIS_URL`, `PORT`).

## Detailed setup
1. In the Pterodactyl panel, go to `Admin` > `Nests` > `Import Egg` and upload the JSON file for the service you need (`pterodactyl/eggs/*.json`).
2. Assign the imported egg to a node that has the Bun yolk image pulled, or update the egg to point at `ghcr.io/parkervcp/yolks:bun_latest`.
3. Create a new server from the egg. On the server creation form:
   - Set `Allocation` to the port you want the service to listen on (match `PORT` if you override it).
   - Leave `Default Startup Command` as provided unless you have a custom script.
   - In `Server Owner` and `Description`, fill in whatever helps you recognize the service later.
4. After the server is created, open the `Startup` tab and adjust:
   - `WORK_DIR` to the service folder (see table below) when the whole repo is cloned or mounted. Use `WORK_DIR=.` only for single-service uploads.
   - Any required environment variables. At minimum the API needs `DATABASE_URL`, `REDIS_URL`, and `PORT`; the worker needs queue endpoints; the bot needs `DISCORD_BOT_TOKEN` plus `API_BASE_URL`; the frontend needs `NEXT_PUBLIC_API_URL` before `bun run bun:build` if the API is not localhost or reverse-proxied to the same origin.
   - For API, worker, and bot single-service uploads with `WORK_DIR=.`, set `LOG_DIR=./logs` or `LOG_TO_FILE=false` so log files stay inside the server directory or are disabled.
5. Deploy the application code:
   - If you cloned the whole repository into the node, point the server's SFTP path to the repo root and set `WORK_DIR` to that server's service folder, such as `services/api`.
   - If you only upload a single service, keep `WORK_DIR` as `.` and upload the corresponding `services/<name>` contents via SFTP. For API, worker, and bot single-service uploads, also set `LOG_DIR=./logs` or `LOG_TO_FILE=false`; otherwise the default `../../logs` path can resolve outside the server directory.
6. Start the server. On first boot the frontend egg runs a full `bun install` before `bun run bun:build` so Next/TypeScript build tooling from devDependencies is available. API, worker, and bot eggs can use `bun install --production`, then any service-specific bootstrap (`bun prisma generate` / `db push` for the API). Watch the console to confirm each step completes.
7. Once the server is running, hit the service's HTTP port (or relevant queue/bot endpoints) to verify it responds, then enable automatic restarts or schedules as needed.

## Recommended WORK_DIR values
- API: `services/api`
- Worker: `services/worker`
- Bot: `services/bot`
- Frontend: `services/frontend`

## Startup defaults
- API/Worker/Bot: `START_CMD=bun:start` (defined in each service package.json)
- Frontend: build runs before start via the egg command, then starts with `bunx next start -p {{PORT}}` so the Pterodactyl `PORT` variable controls the listener.

## Logging variables
- API, worker, and bot eggs expose `LOG_DIR` (default `../../logs`) and `LOG_TO_FILE` (default empty, which enables file logging). Set `LOG_DIR=./logs` for single-service uploads with `WORK_DIR=.` to keep logs under the Pterodactyl server directory.
- Set `LOG_TO_FILE=false` (or `0`/`off`) if you only want console logs and do not want the service to create log files.

## Notes
- Frontend runs a full `bun install` before build; API, worker, and bot can use `bun install --production` on startup. API runs Prisma generate/db push via its `bun:start` script.
- Bot deployments need `DISCORD_BOT_TOKEN` and `API_BASE_URL` (default `http://localhost:4000`) so commands can call the API.
- Frontend deployments need `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`) when the API is not localhost or reverse-proxied to the same origin; Next.js bakes this public value into the browser bundle during `bun run bun:build`, so set it before the build runs.
- Ensure your DB/Redis endpoints are reachable from the node that hosts the server.
- For production, set `NODE_ENV=production` and provide any external API keys in the Startup tab.
- If migrations or seed data are required, add a Pterodactyl schedule to run the corresponding `bun` script after deploys.
