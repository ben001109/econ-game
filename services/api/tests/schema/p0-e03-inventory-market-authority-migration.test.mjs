import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const migrationRoot = `${repositoryRoot}/services/api/prisma/migrations/20260818000300_p0_plat_e03_inventory_market_authority`;
const migration = readFileSync(`${migrationRoot}/migration.sql`, 'utf8');
const rollback = readFileSync(`${migrationRoot}/rollback.sql`, 'utf8');
const apiSchema = readFileSync(`${repositoryRoot}/services/api/prisma/schema.prisma`, 'utf8');
const workerSchema = readFileSync(`${repositoryRoot}/services/worker/prisma/schema.prisma`, 'utf8');
const workerPlatform = readFileSync(
  `${repositoryRoot}/services/worker/src/simulation-platform.ts`,
  'utf8',
);
const durableStore = readFileSync(
  `${repositoryRoot}/services/api/src/domains/ledger/postgres-ledger-store.ts`,
  'utf8',
);

const model = (schema, name) =>
  schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';

test('schema replaces item-level capacity with two shared inventory pool authorities', () => {
  assert.match(apiSchema, /enum InventoryPool \{\s+DURABLE\s+PERISHABLE\s+\}/);
  const pool = model(apiSchema, 'InventoryPoolState');
  assert.match(pool, /capacityPoints\s+BigInt/);
  assert.match(pool, /updatedByCommandId\s+String/);
  assert.match(pool, /@@id\(\[restaurantId, saveId, pool\]\)/);
  assert.match(pool, /@@unique\(\[saveId, pool\]\)/);
  assert.match(pool, /@@unique\(\[updatedByCommandId, pool\]\)/);
  const stock = model(apiSchema, 'InventoryStock');
  assert.match(stock, /costPoolMinor\s+BigInt\s+@default\(0\)/);
  assert.doesNotMatch(stock, /\scapacity\s+BigInt/);
});

test('inventory movements carry command sequence and optional deferred ledger provenance', () => {
  const movement = model(apiSchema, 'InventoryTransaction');
  for (const field of [
    'commandId',
    'commandSequence',
    'ledgerTransactionId',
    'amountMinor',
    'costPoolMinorAfter',
    'referenceId',
  ]) {
    assert.match(movement, new RegExp(`\\b${field}\\b`));
  }
  assert.match(movement, /@@unique\(\[commandId, commandSequence\]\)/);
  assert.match(migration, /InventoryTransaction_ledger_scope_command_fkey/);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /InventoryTransaction_stock_snapshot_check/);
});

test('forward migration refuses ambiguous inventory and save backfills', () => {
  assert.match(migration, /EXISTS \(SELECT 1 FROM "InventoryStock"\)/);
  assert.match(migration, /EXISTS \(SELECT 1 FROM "InventoryTransaction"\)/);
  assert.match(migration, /EXISTS \(SELECT 1 FROM "CompetitiveSave"\)/);
  assert.match(migration, /no automatic backfill is permitted/);
  assert.match(migration, /no seed is generated or derived/);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE\s+"|DELETE\s+FROM|TRUNCATE\b)/im);
});

test('deferred authority checks require both pools, one seed, fixed lock order, and total occupancy', () => {
  assert.match(migration, /pool_count <> 2/);
  assert.match(migration, /revision_count <> 1/);
  assert.match(migration, /seed_count <> 1/);
  assert.match(migration, /CASE "pool" WHEN 'DURABLE' THEN 0 ELSE 1 END/);
  assert.match(migration, /stock\."onHand" \+ stock\."reservedUndelivered"/);
  assert.match(migration, /InventoryPoolState_occupancy_check/);
  for (const trigger of [
    'CompetitiveSave_e03_authority_complete',
    'InventoryPoolState_authority_complete',
    'MarketSeedAuthority_authority_complete',
    'InventoryStock_pool_occupancy',
  ]) {
    assert.match(
      migration,
      new RegExp(`CREATE CONSTRAINT TRIGGER "${trigger}"[\\s\\S]*?DEFERRABLE INITIALLY DEFERRED`),
    );
  }
});

test('stock and pool transitions preserve identity, exact versions, cost, and derived pool assignment', () => {
  assert.match(
    migration,
    /InventoryPoolState identity is immutable and revision must advance exactly by one/,
  );
  assert.match(
    migration,
    /InventoryStock identity is immutable and version must advance exactly by one/,
  );
  assert.match(migration, /"onHand" > 0 OR "costPoolMinor" = 0/);
  assert.match(migration, /InventoryItem pool cannot change after stock exists/);
  assert.doesNotMatch(migration, /ADD COLUMN "pool" "InventoryPool"/);
});

test('market seed is isolated and command materialization is an exact Day-1 XOR', () => {
  const seed = model(apiSchema, 'MarketSeedAuthority');
  assert.match(seed, /createdByCommandId\s+String\s+@unique/);
  assert.match(apiSchema, /enum MarketTickMaterializationSource \{\s+JOB\s+COMMAND\s+\}/);
  assert.match(workerSchema, /enum MarketTickMaterializationSource \{\s+JOB\s+COMMAND\s+\}/);
  assert.match(migration, /MarketTick_materialization_check/);
  assert.match(
    migration,
    /"materializationSource" = 'JOB'[\s\S]*?"materializedByJobId" = "replayExecutionId"/,
  );
  assert.match(migration, /"materializationSource" = 'COMMAND'[\s\S]*?"businessDay" = 1/);
  assert.match(
    migration,
    /MarketTick_command_event_scope_fkey[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(migration, /day\."status" = 'PREOPEN'/);
  assert.match(migration, /day\."simulationRuleVersion" = NEW\."simulationRuleVersion"/);
  assert.match(
    migration,
    /MarketTick_market_seed_authority_scope_fkey[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(
    migration,
    /CREATE CONSTRAINT TRIGGER "MarketTick_market_seed_authority"[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(migration, /FROM "MarketSeedAuthority" authority[\s\S]*?FOR KEY SHARE/);
  assert.match(migration, /authority_seed IS DISTINCT FROM NEW\."marketSeed"/);
  assert.match(migration, /MarketTick_market_seed_authority_check/);
});

test('worker job materialization explicitly preserves JOB provenance', () => {
  assert.match(workerPlatform, /"tickKind", "materializationSource"/);
  assert.match(workerPlatform, /VALUES \(\$1,\$2,\$3,\$4,\$5,'JOB'/);
  assert.doesNotMatch(workerPlatform, /materializationSource[^\n]+COMMAND/);
});

test('RLS grants expose pool reads only to members and keep seed and market service-only', () => {
  for (const table of ['InventoryPoolState', 'MarketSeedAuthority']) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
    assert.match(
      migration,
      new RegExp(`REVOKE ALL ON TABLE "${table}" FROM PUBLIC, anon, authenticated, service_role`),
    );
  }
  assert.match(migration, /CREATE POLICY "InventoryPoolState_select_member"/);
  assert.match(migration, /GRANT SELECT ON TABLE "InventoryPoolState" TO authenticated/);
  assert.doesNotMatch(migration, /CREATE POLICY "MarketSeedAuthority/);
  assert.doesNotMatch(migration, /GRANT [^;]+ON TABLE "MarketSeedAuthority" TO authenticated/);
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE "MarketSeedAuthority" TO service_role/);
  assert.match(
    migration,
    /REVOKE UPDATE, DELETE ON TABLE "InventoryTransaction" FROM service_role/,
  );
});

test('durable command store maps domain constraint prefixes without relabeling ledger errors', () => {
  assert.match(
    durableStore,
    /constraint\.startsWith\('Inventory'\)[\s\S]*?INVENTORY_INVARIANT_VIOLATION/,
  );
  assert.match(
    durableStore,
    /constraint\.startsWith\('MarketTick'\)[\s\S]*?MARKET_TICK_INVARIANT_VIOLATION/,
  );
  assert.match(durableStore, /LEDGER_INVARIANT_VIOLATION/);
});

test('rollback is fail-closed and never deletes durable evidence', () => {
  for (const table of [
    'InventoryPoolState',
    'InventoryStock',
    'InventoryTransaction',
    'MarketSeedAuthority',
  ]) {
    assert.match(rollback, new RegExp(`EXISTS \\(SELECT 1 FROM "${table}"\\)`));
  }
  assert.match(rollback, /"materializationSource" = 'COMMAND'/);
  assert.match(rollback, /market provenance cannot return to job-only shape/);
  assert.match(rollback, /DROP TRIGGER IF EXISTS "MarketTick_market_seed_authority"/);
  assert.match(rollback, /DROP CONSTRAINT "MarketTick_market_seed_authority_scope_fkey"/);
  assert.doesNotMatch(rollback, /^\s*(?:DELETE\s+FROM|TRUNCATE\b)/im);
  assert.doesNotMatch(rollback, /DROP\s+(?:TABLE|TYPE)[^;]+CASCADE/i);
});

test('static inspection makes no PostgreSQL runtime claim', () => {
  assert.doesNotMatch(import.meta.url, /postgres/i);
});
