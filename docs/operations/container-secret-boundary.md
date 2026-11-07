# Local container secret boundary

The Compose definition binds published ports to `127.0.0.1` by default. Postgres, Redis, API, and opt-in administration tools are therefore reachable only from the local machine unless an operator deliberately changes `ECON_BIND_ADDRESS`.

The root `.env` is used only for Compose interpolation and does not automatically inject its contents into every service. For the Node stack, place `POSTGRES_PASSWORD` in that private, untracked root file. The `dev` profile also explicitly maps its shared development-only `DATABASE_URL` from the root file into `api-dev` and `worker-dev`; no other root value is broadcast to Node services.

Node production profiles load runtime credentials from service-owned files. Put API-only values in `services/api/.env.local`, worker-only values in `services/worker/.env.local`, and Discord/Bot-to-API credentials in `services/bot/.env.local`. Each credential-bearing file must be untracked, owner-readable only, and contain only the values required by that service. Do not print these files or pass their values as command-line arguments.

The administration UIs are disabled by default. Start them only with the `tools` profile and retain the loopback bind. Production-like Node services run with `NODE_ENV=production`; their runtime validators reject missing or partial required configuration instead of substituting credentials or remote endpoints.

For a local Node developer stack, use the `dev` profile with a development-only database URL and Postgres password in the private root `.env`; the explicit Compose mapping overrides any same-named entry in the API or worker env files. Keep unrelated service credentials in their service-specific `.env.local` files. The console creates or updates credential-bearing environment files with owner-only permissions and hides sensitive interactive input.

Before a production-like launch, verify permissions on every credential file and provision production secrets through the deployment platform's protected secret mechanism. Do not use Compose environment interpolation as a hosted production secret manager.
