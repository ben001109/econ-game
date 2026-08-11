---
name: econ-game-sdk-maintenance
description: Maintain and verify Econ Game's internal TypeScript SDK when a current Node/Fastify route declaration or Python preview route changes, or when a consumer needs a typed SDK example or error-handling guidance. Use for source-surface drift checks, SDK type/test/documentation updates, and safe package verification; do not use it to decide future game contracts, alter service behavior, access environment files, or run data-changing workflows.
---

# Econ Game SDK Maintenance

Maintain the repository-local `packages/econ-game-sdk` snapshot of currently implemented HTTP routes. Treat it as an internal 0.x client package, not as the Architecture-approved product API.

Read [the SDK HTTP surface](../../../sdk/current-http-surface.md), [the SDK README](../../../../packages/econ-game-sdk/README.md), [source map](../../source-map.md), and [developer-platform roadmap](../../developer-platform-roadmap.md) before changing a client.

## Guardrails

- Do not read `.env` files, credentials, or connection strings; do not start services, connect to a database, invoke Prisma, run migrations, deploy, or call `prisma db push`.
- Do not make a Node route and a Python preview route appear interchangeable. Use `createPythonPreviewApiClient` only for the isolated preview endpoints.
- Do not add product rules, money conversion, authorization, retry/idempotency behavior, identity, or compatibility policy. Stop for Architecture/API owner review when a request needs any of them.
- Do not automatically install dependencies. If a clean checkout lacks package dependencies, report that `npm ci` requires separate Build/user authorization.
- Keep a mutation single-shot. Never add automatic retries for create, payment, KDS, player, or bootstrap calls.

## Maintenance workflow

1. Read the route declaration and identify whether it belongs to `services/api/src/index.ts` or `python/services/api/src/econ_api/routes.py`.
2. Confirm the requested route is already implemented and its semantics are decided. If it is only a future architecture proposal, document the gap instead of adding an SDK method.
3. Update the smallest affected client module under `packages/econ-game-sdk/src/`, preserving `ApiMoney` as `string | number` and encoding path segments through `encodePathSegment`.
4. Keep `scripts/check-source-surface.mjs`, mock-fetch tests, `packages/econ-game-sdk/README.md`, and `docs/sdk/current-http-surface.md` aligned with the route set.
5. If package dependencies already exist, run from `packages/econ-game-sdk`:

   ```bash
   npm run verify
   ```

   It performs only static route comparison, TypeScript compilation, and mocked HTTP tests. It does not start a service or use credentials.

6. Optionally check package contents without writing to the shared npm cache:

   ```bash
   ECON_SDK_NPM_CACHE="$(mktemp -d)" && npm_config_cache="$ECON_SDK_NPM_CACHE" npm pack --dry-run
   ```

7. Run `git diff --check` from the repository root. Report skipped verification separately from passing verification.

## Consumer guidance and common failures

Read [usage and troubleshooting](references/usage-and-troubleshooting.md) when adding a consumer, handling a non-2xx response, deciding how to display `ApiMoney`, diagnosing a surface mismatch, or resolving an npm cache permission error.

## Completion checklist

- State which client changed: Node restaurant scaffold or Python preview.
- State that no configuration file, credential, service, database, queue, migration, or deployment was touched.
- Record `npm run verify` result, or why it was not safe/available to run.
- State whether the static route surface, types, tests, package README, and SDK HTTP-surface document were updated together.
- Keep all future game-contract decisions as Architecture/API-owner follow-up items.
