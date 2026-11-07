import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, 'utf8');
const migration = read('services/api/prisma/migrations/20260817000200_d05_wipe_execution_lease/migration.sql');
const rollback = read('services/api/prisma/migrations/20260817000200_d05_wipe_execution_lease/rollback.sql');
const d05b = read('services/api/prisma/migrations/20260817000100_d05_wipe_batch_persistence/migration.sql');
const schema = read('services/api/prisma/schema.prisma');
const source = read('services/api/src/closed-beta/wipe-execution.ts');
const routes = read('services/api/src/closed-beta/wipe-execution-routes.ts');
const app = read('services/api/src/app-composition.ts');
const production = read('services/api/src/production-api-composition.ts');
const batch = read('services/api/src/closed-beta/wipe-batch.ts');
const repository = read('services/api/src/closed-beta/prisma-wipe-batch-repository.ts');
const runbook = read('docs/runbooks/d05-wipe-execution-fixture-only.md');

test('D05-D migration is additive, paired, service constrained, and rollback guarded', () => {
  assert.match(migration, /CREATE TABLE "WipeExecutionFixtureMarker"/);
  assert.match(migration, /CREATE TABLE "WipeExecutionLease"/);
  assert.match(migration, /WHERE "status" = 'CLAIMED'/);
  assert.match(migration, /D05-D lease attempt must advance manually and exactly once/);
  assert.match(migration, /GRANT SELECT ON TABLE "WipeExecutionFixtureMarker" TO service_role/);
  assert.doesNotMatch(migration, /GRANT (?:INSERT|UPDATE|DELETE)[^;]+WipeExecutionFixtureMarker/);
  assert.doesNotMatch(migration, /\b(?:DELETE|TRUNCATE)\s+(?:FROM\s+)?"?(?:Player|Order|CompetitiveSave)"?/i);
  assert.match(rollback, /EXISTS \(SELECT 1 FROM "WipeExecutionLease"\)/);
  assert.match(rollback, /EXISTS \(SELECT 1 FROM "WipeExecutionFixtureMarker"\)/);
  assert.match(rollback, /"evidence"->>'version' = 'd05-lease-expiry\/v1'/);
  assert.match(rollback, /rollback refused: fixture marker or lease evidence exists/);
  assert.match(rollback, /DROP TABLE "WipeExecutionLease"/);
  assert.match(schema, /model WipeExecutionLease/);
});

test('environment triple and immutable authority reject before lease mutation', () => {
  const authorityRead = source.indexOf('const authority = await executionAuthority');
  const idempotencyMutation = source.indexOf('UPDATE "WipeExecutionLease" SET "status" = \'EXPIRED\'');
  assert.ok(authorityRead >= 0 && idempotencyMutation > authorityRead);
  assert.match(source, /row\.scopeEnvironment !== environment/);
  assert.match(source, /marker\?\.environment !== environment/);
  assert.match(source, /marker\.fixtureNonceHash !== fixtureNonceHash/);
  assert.match(source, /WIPE_EXECUTION_ENVIRONMENT_MISMATCH/);
  assert.match(migration, /batch_record\."scope"->>'environment'/);
  assert.match(migration, /disposable fixture marker mismatch/);
  assert.match(migration, /CURRENT_TIMESTAMP < batch_record\."clearEligibleAt"/);
});

test('batch scope environment is server-derived and replay-bound', () => {
  assert.match(batch, /WIPE_SCOPE_VERSION = 'd05-wipe-scope\/v2'/);
  assert.match(batch, /environment,/);
  assert.match(repository, /SELECT DISTINCT "environment" FROM "TestCohort"/);
  assert.match(repository, /WIPE_SCOPE_ENVIRONMENT_AMBIGUOUS/);
});

test('lease request is fixture-harness-only, durable idempotent, and expiry is manual-only', () => {
  assert.match(routes, /reply\.status\(202\)/);
  assert.match(routes, /WIPE_EXECUTION_PERSISTENCE_REQUIRED/);
  assert.match(app, /testOnlyWipeExecutionLeaseService/);
  assert.doesNotMatch(app, /wipeExecutionLeaseService\?:/);
  assert.doesNotMatch(production, /WipeExecutionLeaseService|PrismaWipeExecutionRepository/);
  assert.match(source, /INSERT INTO "IdempotencyRecord"/);
  assert.match(source, /LEASE_EXPIRED_MANUAL_RESUME_REQUIRED/);
  assert.match(source, /expireClaimedLease/);
  assert.match(source, /'FAILED',\$6,\$7,\$8::jsonb,\$9/);
  assert.match(source, /WIPE_REQUEST_\$\{phase\}/);
  assert.doesNotMatch(source, /setInterval|setTimeout|cron|auto.?retry/i);
});

test('D05-D0 declares the future order but exposes no clear executor or game-data mutation SQL', () => {
  const expected = [
    'Payment', 'TaxLine', 'Tip', 'OrderItem', 'MenuSelection',
    'Order:TOMBSTONE', 'InventoryStock:TOMBSTONE', 'Employee:TOMBSTONE',
    'CompetitiveSave:TOMBSTONE',
  ];
  for (const entry of expected) assert.match(source, new RegExp(`'${entry}'`));
  assert.doesNotMatch(source, /DedicatedWipeExecutor|executeClear|DELETE\s+FROM/i);
  assert.doesNotMatch(source, /UPDATE\s+"(?:Player|RestaurantMembership|CompetitiveSave|Order|InventoryStock|Employee)"/i);
  assert.doesNotMatch(source, /SimulationJob|ClerkJwtVerifier|clerk\.com|fetch\(/);
});

test('30-day eligibility remains DB-clock derived and operator contract stays fixture-only', () => {
  assert.match(d05b, /NEW\."clearEligibleAt" := \(\(NEW\."isolatedAt" AT TIME ZONE 'UTC'\) \+ INTERVAL '30 days'\)/);
  assert.match(migration, /CURRENT_TIMESTAMP < batch_record\."clearEligibleAt"/);
  assert.match(runbook, /execution-created, nonce-marked disposable PostgreSQL fixture/);
  assert.match(runbook, /Runtime evidence gap/);
  assert.match(runbook, /External Clerk identity remains a non-effect/i);
  assert.doesNotMatch(runbook, /DATABASE_URL=/);
});
