Pterodactyl Eggs for Econ Game (Bun + Python/uv)

Usage
- Import one of the JSON eggs under `pterodactyl/eggs/` into your panel (Bun eggs use the `*_bun.json` suffix, Python/uv eggs use `*_python.json`).
- Pick the yolk image that matches the stack you are deploying:
  - Bun stack: `ghcr.io/parkervcp/yolks:bun_latest`
  - Python stack: `ghcr.io/parkervcp/yolks:python_3.12` (ships with `uv`)
- Set `WORK_DIR` to the service folder if you clone the whole repo, or leave `.` if you upload only that service.
- Set non-secret environment variables as needed. An administrator must inject each required secret through its protected server-owned variable before startup.

Detailed setup
1. In the Pterodactyl panel, go to `Admin` > `Nests` > `Import Egg` and upload the JSON file for the service you need (`pterodactyl/eggs/*.json`).
2. Assign the imported egg to a node that has the Bun yolk image pulled, or update the egg to point at `ghcr.io/parkervcp/yolks:bun_latest`.
3. Create a new server from the egg. On the server creation form:
   - Set `Allocation` to the port you want the service to listen on (match `PORT` if you override it).
   - Leave `Default Startup Command` as provided unless you have a custom script.
   - In `Server Owner` and `Description`, fill in whatever helps you recognize the service later.
4. Before assigning the server to a client, configure it as an administrator:
   - Set non-secret values such as `WORK_DIR`, `API_BASE_URL`, and `PORT`.
   - Inject credentials only through server-owned variables that have both `user_viewable=false` and `user_editable=false`. Never put Git, database, Discord, Clerk, Supabase, or Bot credentials in a client-visible variable.
   - Leave a required protected variable unset if no secret has been provisioned. The service must fail closed; do not use placeholder or demonstration credentials.
5. Deploy the application code:
   - Every egg clones only public HTTPS repositories and rejects URLs containing credentials, query data, or fragments. For private repositories, set `USER_UPLOAD=1` and deploy code through a server-side checkout or artifact workflow outside the egg; never place a token in a clone URL or command.
   - If the whole repository is present on the node, point the server's SFTP path to the repo root; the egg runs from that working directory.
   - If you only upload a single service, keep `WORK_DIR` as `.` and upload the corresponding `services/<name>` contents via SFTP.
6. Start the server. On first boot the egg runs `bun install --production` and any service-specific bootstrap (`bun prisma generate` / `db push` for the API). Watch the console to confirm each step completes.
7. Once the server is running, hit the service's HTTP port (or relevant queue/bot endpoints) to verify it responds, then enable automatic restarts or schedules as needed.

Recommended WORK_DIR values
- API: `services/api`
- Worker: `services/worker`
- Bot: `services/bot`
- Frontend: `services/frontend`
- Python API: `python/services/api`
- Python Worker: `python/services/worker`
- Python Bot: `python/services/bot`
- Python Frontend: `python/services/frontend`

Startup defaults
- API/Worker/Bot: `START_CMD=bun:start` (defined in each service package.json)
- Frontend: `START_CMD=bun:start` (build runs before start via egg command)

Notes
- Eggs install their locked runtime dependencies on startup and then invoke the administrator-owned service script.
- Ensure your DB/Redis endpoints are reachable from the node that hosts the server.
- For production, keep `NODE_ENV=production`. Provision secrets with protected, administrator-owned server variables; client-visible Startup fields are for non-secret configuration only.
- If migrations or seed data are required, add a Pterodactyl schedule to run the corresponding `bun` script after deploys.
- Python eggs call `uv sync --no-dev` (or `--frozen` if `uv.lock` exists) before executing the script named by `START_CMD`.
