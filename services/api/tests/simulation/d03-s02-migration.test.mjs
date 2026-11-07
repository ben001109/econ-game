import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const migration = readFileSync(
  `${repositoryRoot}/services/api/prisma/migrations/20260814000500_d03_durable_simulation/migration.sql`,
  'utf8',
);
const rollback = readFileSync(
  `${repositoryRoot}/services/api/prisma/migrations/20260814000500_d03_durable_simulation/rollback.sql`,
  'utf8',
);
const worker = readFileSync(`${repositoryRoot}/services/worker/src/index.ts`, 'utf8');
const workerRuntimeEnvironment = readFileSync(
  `${repositoryRoot}/services/worker/src/runtime-env.ts`,
  'utf8',
);
const platform = readFileSync(
  `${repositoryRoot}/services/worker/src/simulation-platform.ts`,
  'utf8',
);

test('migration owns durable jobs, immutable versions, replay executions, and market ticks', () => {
  for (const table of [
    'SimulationVersionArtifact',
    'SimulationJob',
    'SimulationJobAudit',
    'VersionedReplayExecution',
    'MarketTick',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
  }
  assert.match(migration, /SimulationJob_source_event_scope_fkey/);
  assert.match(migration, /SimulationJob_source_transaction_scope_fkey/);
  assert.match(migration, /OutboxEvent_simulation_dispatch_idx/);
  assert.match(rollback, /DROP INDEX IF EXISTS "OutboxEvent_simulation_dispatch_idx"/);
  assert.match(
    migration,
    /'SimulationVersionArtifact', 'SimulationJobAudit',\s*'VersionedReplayExecution', 'MarketTick'/,
  );
  assert.match(migration, /table_name \|\| '_append_only'/);
});

test('claim is atomic, expired leases are reclaimed, and capped retry reaches audited DLQ', () => {
  assert.match(migration, /FOR UPDATE SKIP LOCKED/);
  assert.match(migration, /LEASE_RECLAIMED/);
  assert.match(migration, /d03_renew_simulation_job_lease/);
  assert.match(migration, /"attemptCount" BETWEEN 0 AND 5 AND "maxAttempts" = 5/);
  assert.match(migration, /power\(2, GREATEST/);
  assert.match(migration, /'RETRY_SCHEDULED'/);
  assert.match(migration, /'DEAD_LETTERED'/);
  assert.match(migration, /'sourceTransactionId', selected_job\."sourceTransactionId"/);
});

test('market identity and exact historical selectors are persistence constraints without latest fallback', () => {
  assert.match(migration, /UNIQUE \("saveId", "businessDay", "tickKind"\)/);
  assert.match(migration, /"simulationRuleVersion" TEXT NOT NULL/);
  assert.match(migration, /"catalogRevision" TEXT NOT NULL/);
  assert.match(migration, /"rulePayloadHash" VARCHAR\(64\) NOT NULL/);
  assert.match(migration, /"catalogPayloadHash" VARCHAR\(64\) NOT NULL/);
  assert.match(migration, /d03_assert_market_tick_materialized/);
  assert.doesNotMatch(migration, /latest/i);
});

test('all D03-S-02 tables and functions are service-only and rollback leaves D03-S-01 separate', () => {
  for (const table of [
    'SimulationVersionArtifact',
    'SimulationJob',
    'SimulationJobAudit',
    'VersionedReplayExecution',
    'MarketTick',
  ]) {
    assert.match(migration, new RegExp(`ALTER TABLE %I ENABLE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE %I FROM authenticated`));
    assert.match(rollback, new RegExp(`DROP TABLE IF EXISTS "${table}"`));
  }
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION d03_claim_simulation_job[^;]+ TO service_role/s,
  );
  assert.doesNotMatch(rollback, /DROP TABLE IF EXISTS "(?:LedgerTransaction|OutboxEvent)"/);
  assert.doesNotMatch(migration, /prisma\s+db\s+push/i);
});

test('production worker requires PostgreSQL durable composition and has no global market heartbeat', () => {
  assert.match(worker, /import \{ env \} from '\.\/env\.js';/);
  assert.match(worker, /url: env\.DATABASE_URL/);
  assert.match(workerRuntimeEnvironment, /if \(!databaseUrl\) fail\('DATABASE_URL_REQUIRED'\);/);
  assert.match(worker, /PostgresSimulationPlatform/);
  assert.match(worker, /platform\.ingestNextOutbox\(\)/);
  assert.match(worker, /platform\.runOnce\(workerId, leaseSeconds\)/);
  assert.match(platform, /simulation\.versioned-replay\.requested/);
  assert.match(platform, /d03-versioned-replay-request\/v1/);
  assert.match(platform, /FOR UPDATE OF event SKIP LOCKED/);
  assert.match(platform, /INSERT INTO "OutboxConsumerReceipt"/);
  assert.match(platform, /INSERT INTO "SimulationJob"/);
  assert.doesNotMatch(worker, /BullMQ|new Queue|TICK_INTERVAL_MS|econ:tick/);
});
