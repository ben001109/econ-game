---
name: econ-game-node-quality-gate
description: Run or review Econ Game's default-safe Node/TypeScript quality-gate preflight across API, worker, bot, and frontend. Use when validating a change to existing Node service tooling, manifests, lint/build/test scripts, or CI parity without changing product behavior, database state, migrations, secrets, or environment files.
---

# Econ Game Node Quality Gate

Use the repository quality-gate runner for the four existing Node services. Treat this as a developer-tooling workflow only; it does not approve product behavior or replace architecture, database, security, or deployment review.

Read [the developer-platform roadmap](../../developer-platform-roadmap.md) and [source map](../../source-map.md) before changing the workflow or its service list.

## Guardrails

- Do not read `.env` files or credentials.
- Do not invoke `prisma db push`, any Prisma migration command, a service start command, Docker Compose, `lint:fix`, `format`, or package installation.
- Do not treat `--if-present` as test coverage. Report which services lack a `test` script.
- Do not use a passing quality gate as proof that API, database, queue, Discord, authentication, or observability behavior works.
- Stop and hand off deployment/migration concerns to the Database/Platform owner. The current deployment paths containing `db push` are a documented blocker, not permission to run them.

## Run the workflow

1. From the repository root, inspect the exact commands without running them:

   ```bash
   node scripts/quality-gate.mjs --dry-run
   ```

2. Before a non-dry run, confirm dependencies already exist in all four service directories. Do not install them as part of this workflow.

3. Do not run the real gate under this skill. `--execute` delegates to the existing npm scripts and can have transitive side effects (including environment-file reads) that this scaffold cannot prove absent. Route a requested real run to the Build／CI owner for a separate authorization and script audit.

   ```bash
   node scripts/quality-gate.mjs --execute
   ```

4. The runner invokes, for each of `api`, `worker`, `frontend`, and `bot`:

   ```text
   npm run prisma:generate --if-present
   npm run lint --if-present
   npm run build --if-present
   npm run test --if-present
   ```

5. Record the exact service and step for every non-zero exit. Distinguish a missing script skipped by `--if-present` from a passing test suite.

6. After any allowed docs/tooling change, run:

   ```bash
   git diff --check
   ```

## Completion checklist

- State that the default-safe preflight ran; do not report a real run from this skill.
- List executed and skipped service scripts.
- State that no migration, database connection, service startup, `.env` read, or credential access occurred.
- Report the remaining CI test-gap and Node 20 lifecycle gap when relevant.
