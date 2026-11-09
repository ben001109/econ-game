# Closed-beta promotion runbook

This runbook implements the local, reviewable portion of `O02-S-01`. It does not authorize or perform a deployment, create a cloud resource, read a credential, or apply a database migration.

## Promotion invariant

A candidate may be promoted only when the `Closed-beta candidate (no deploy)` workflow succeeds for the exact candidate commit. A failure or cancellation in any dependency blocks promotion. Never bypass the workflow by starting a service manually or by changing database schema at application startup.

Database changes must exist as reviewed migration files. The environment owner applies them as a separate, auditable release step with `prisma migrate deploy`; schema push is prohibited in development, CI, containers, and release operations.

## Required evidence

The release owner binds `closed-beta-gate-evidence.json` to the candidate commit and adds immutable CI artifact or drill links. Every entry must be `verified`:

1. format, lint, typecheck, build, and dependency installation;
2. unit and economic invariant tests;
3. API integration tests;
4. RLS cross-tenant isolation tests;
5. Web E2E and Discord E2E for the same gameplay contract;
6. concurrent mutation and redelivery/idempotency tests;
7. replay event hash and day-end snapshot hash tests;
8. rollback rehearsal for the target environment.
9. incident freeze／recovery、backup restore、market／replay rebuild 與 wipe fail／resume staging drills。

The evidence checker intentionally fails while any record is missing, still `blocked`, lacks evidence, or is not bound to a commit SHA. A promotion workflow success is therefore evidence collection, not permission to deploy.

## Candidate sequence

1. Select the candidate commit; do not reuse evidence from another SHA.
2. Confirm O-01 identifies account, billing, platform and backup owners, region, environment isolation, and secret rotation/revocation paths.
3. Run normal CI and retain its URLs/artifacts.
4. Complete integration, RLS, both client E2E, concurrency/redelivery, dual-hash, and rollback drills against the isolated staging environment.
5. Update the evidence registry in a reviewed change, rerun the candidate workflow, and require all checks to pass.
6. Obtain the external platform approval required by O-01. Deployment remains a separate owner action outside this workflow.

## Rollback boundary

Before any later deployment workflow is enabled, it must record the previous immutable application image/digest, the forward migration set, migration compatibility, feature flags, and rollback owner. Application rollback must not silently reverse a database migration. If the database change is not backward-compatible, promotion remains blocked until a tested forward-fix or restore procedure exists.

## Current blockers

- O-01 external ownership, region, billing, environment, and secrets decisions are not yet authorized.
- D-01 reviewable migrations and RLS tests are not yet present.
- API integration, Web/Discord E2E, concurrency/redelivery, dual-hash cross-client evidence, incident／restore／rebuild／wipe-resume drills, and a staging rollback drill are not yet present.
- The evidence registry therefore remains blocked and the candidate workflow must fail closed.
