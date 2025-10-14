Pterodactyl Eggs for Econ Game (Bun)

Usage
- Import one of the JSON eggs under `pterodactyl/eggs/` into your panel.
- Pick a Bun yolk image (e.g. `ghcr.io/parkervcp/yolks:bun_latest`).
- Set `WORK_DIR` to the service folder if you clone the whole repo, or leave `.` if you upload only that service.
- Set environment variables as needed (e.g. API: `DATABASE_URL`, `REDIS_URL`, `PORT`).

Detailed setup
1. In the Pterodactyl panel, go to `Admin` > `Nests` > `Import Egg` and upload the JSON file for the service you need (`pterodactyl/eggs/*.json`).
2. Assign the imported egg to a node that has the Bun yolk image pulled, or update the egg to point at `ghcr.io/parkervcp/yolks:bun_latest`.
3. Create a new server from the egg. On the server creation form:
   - Set `Allocation` to the port you want the service to listen on (match `PORT` if you override it).
   - Leave `Default Startup Command` as provided unless you have a custom script.
   - In `Server Owner` and `Description`, fill in whatever helps you recognize the service later.
4. After the server is created, open the `Startup` tab and adjust:
   - `WORK_DIR` to the service folder (see table below) if the repository root is mounted.
   - Any required environment variables. At minimum the API needs `DATABASE_URL`, `REDIS_URL`, and `PORT`; the worker needs queue endpoints; the bot needs Discord credentials.
5. Deploy the application code:
   - If you cloned the whole repository into the node, point the server's SFTP path to the repo root; the egg runs from that working directory.
   - If you only upload a single service, keep `WORK_DIR` as `.` and upload the corresponding `services/<name>` contents via SFTP.
6. Start the server. On first boot the egg runs `bun install --production` and any service-specific bootstrap (`bun prisma generate` / `db push` for the API). Watch the console to confirm each step completes.
7. Once the server is running, hit the service's HTTP port (or relevant queue/bot endpoints) to verify it responds, then enable automatic restarts or schedules as needed.

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
- For production, set `NODE_ENV=production` and provide any external API keys in the Startup tab.
- If migrations or seed data are required, add a Pterodactyl schedule to run the corresponding `bun` script after deploys.
