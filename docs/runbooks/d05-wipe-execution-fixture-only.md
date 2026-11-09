# D05-D wipe execution: fixture-only operator contract

## Authorization boundary

D05-D destructive execution is authorized only inside an **execution-created, nonce-marked disposable PostgreSQL fixture**. Existing developer databases, shared test databases, staging, production, arbitrary connection strings, Docker-created targets, and externally provisioned databases are outside this batch's authority.

The API may issue a `202` lease only when all three values match before any write:

1. the executor's configured environment;
2. the immutable `WipeBatch.scope.environment` (scope contract `d05-wipe-scope/v2`);
3. the privileged fixture bootstrap's singleton `WipeExecutionFixtureMarker.environment` and SHA-256 nonce.

The application role has `SELECT` only on the marker. It cannot insert or replace the marker and therefore cannot bless an arbitrary database. A missing marker, missing/ambiguous batch environment, nonce mismatch, environment mismatch, authority-hash mismatch, expired lease, wrong tenant, or wrong batch fails closed before destructive SQL.

## D05-D0 lease-only contract

- `POST /closed-beta/tenants/:tenantId/wipe-batches/:batchId/clear-leases`
- `POST /closed-beta/tenants/:tenantId/wipe-batches/:batchId/verify-leases`
- Both use the D02 command envelope. In normal/production composition they fail closed with `WIPE_EXECUTION_PERSISTENCE_REQUIRED`; only an explicitly injected fixture-test service may return `202` with a one-time lease identity.
- Clear leases require a successful `ISOLATED` checkpoint and DB-UTC `clearEligibleAt`.
- Verify leases may be requested only after `CLEARED`; execution remains D05-E because retained-FK/replay/ledger/consent verification is outside this batch.
- Lease expiry never starts work. An operator must explicitly request the next attempt after the prior lease is terminal or expired.

The future clear order is declared, but not executable in D05-D0: `Payment → TaxLine → Tip → OrderItem → MenuSelection → Order tombstone → InventoryStock tombstone → Employee tombstone → CompetitiveSave tombstone`, followed by account-guard evaluation. D05-D0 contains no callable clear executor and no SQL that deletes or redacts application data. External Clerk identity remains a non-effect.

Lease expiry may append sanitized lease/checkpoint evidence, but it never starts clear work. Resume is manual and advances the attempt exactly once. Destructive transaction and rollback behavior remain deferred until the separately authorized disposable-fixture runner exists and passes runtime security review.

## Runtime evidence gap

No PostgreSQL connection, fixture bootstrap, migration application, clear, rollback, concurrency test, or verify execution was run in this batch. Runtime evidence is intentionally missing until a runner creates a new disposable fixture, proves its nonce marker and target identity, and receives separate authorization for that exact fixture. Source/static evidence is not proof that a destructive run succeeded, and D05-D0 must not be described as a completed clear implementation.
