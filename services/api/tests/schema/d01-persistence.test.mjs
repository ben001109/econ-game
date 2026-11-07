import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(testDirectory, '../..');
const schemaPath = resolve(apiRoot, 'prisma/schema.prisma');
const migrationDirectory = resolve(apiRoot, 'prisma/migrations/20260814000100_d01_p0_persistence');
const migrationPath = resolve(migrationDirectory, 'migration.sql');
const rollbackPath = resolve(migrationDirectory, 'rollback.sql');
const migrationLockPath = resolve(apiRoot, 'prisma/migrations/migration_lock.toml');
const integrationRunnerPath = resolve(testDirectory, 'run-d01-postgres-integration.sh');

const schema = readFileSync(schemaPath, 'utf8');
const migration = readFileSync(migrationPath, 'utf8');
const rollback = readFileSync(rollbackPath, 'utf8');
const migrationLock = readFileSync(migrationLockPath, 'utf8');
const integrationRunner = readFileSync(integrationRunnerPath, 'utf8');

const p0Tables = [
  'Player',
  'IdentityLink',
  'Restaurant',
  'RestaurantMembership',
  'AuditLog',
  'WipeBatch',
  'CompetitiveSave',
  'Branch',
  'Table',
  'MenuItem',
  'Employee',
  'WageContract',
  'EmployeeShift',
  'MenuCatalog',
  'RecipeVersion',
  'MenuSelection',
  'InventoryItem',
  'InventoryStock',
  'InventoryTransaction',
  'Order',
  'OrderItem',
  'Payment',
  'TaxLine',
  'Tip',
  'OrderServiceState',
  'ReplayEvent',
  'DayEndSnapshot',
  'RiskState',
  'ReputationDimensionHistory',
  'Loan',
  'LoanInstallment',
  'IdempotencyRecord',
];

const appendOnlyTables = [
  'AuditLog',
  'WageContract',
  'EmployeeShift',
  'RecipeVersion',
  'InventoryTransaction',
  'OrderServiceState',
  'ReplayEvent',
  'DayEndSnapshot',
  'RiskState',
  'ReputationDimensionHistory',
  'Loan',
  'LoanInstallment',
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

test('Prisma schema retains legacy POS and adds every D01 P0 family', () => {
  for (const model of p0Tables) {
    assert.match(schema, new RegExp(`model\\s+${escapeRegex(model)}\\s+\\{`, 'u'), model);
  }

  for (const legacyModel of [
    'Table',
    'MenuItem',
    'Order',
    'OrderItem',
    'Payment',
    'TaxLine',
    'Tip',
  ]) {
    assert.match(schema, new RegExp(`model\\s+${legacyModel}\\s+\\{`, 'u'));
  }

  assert.match(schema, /clerkUserId\s+String\s+@unique/u);
  assert.match(schema, /@@unique\(\[provider, providerUserId\]\)/u);
  assert.match(schema, /@@unique\(\[clerkUserId, provider\]\)/u);
  assert.match(schema, /@@unique\(\[saveId, businessDay, sequence\]\)/u);
  assert.match(schema, /@@unique\(\[actorScope, idempotencyKey\]\)/u);
  assert.match(schema, /eventHash\s+String\s+@db\.VarChar\(64\)/u);
  assert.match(schema, /snapshotHash\s+String\s+@db\.VarChar\(64\)/u);
});

test('migration scopes tenant relationships and retains history without cascade delete', () => {
  assert.doesNotMatch(migration, /ON\s+DELETE\s+CASCADE/iu);

  for (const table of p0Tables) {
    assert.match(
      migration,
      new RegExp(`CREATE TABLE "${escapeRegex(table)}"`, 'u'),
      `${table} missing from migration`,
    );
  }

  for (const table of appendOnlyTables) {
    assert.match(migration, new RegExp(`'${escapeRegex(table)}'`, 'u'));
  }

  assert.match(migration, /FOREIGN KEY \("restaurantId", "saveId"\)/u);
  assert.match(migration, /FOREIGN KEY \("restaurantId", "catalogId"\)/u);
  assert.match(migration, /FOREIGN KEY \("restaurantId", "inventoryItemId"\)/u);
  assert.match(migration, /FOREIGN KEY \("restaurantId", "orderId"\)/u);
  assert.match(migration, /FOREIGN KEY \("restaurantId", "menuItemId"\)/u);
  assert.match(migration, /FOREIGN KEY \("restaurantId", "employeeId", "supersedesId"\)/u);
  assert.match(migration, /FOREIGN KEY \("restaurantId", "employeeId", "wageContractId"\)/u);
  assert.match(migration, /FOREIGN KEY \("restaurantId", "saveId", "replacesLoanId"\)/u);
  assert.match(migration, /d01_reject_history_mutation/u);
  assert.match(migration, /d01_lock_competitive_save_fields/u);
});

test('migration enables fail-closed RLS and grants authenticated clients SELECT only', () => {
  assert.match(migration, /ALTER TABLE %I ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /ALTER TABLE %I FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /NULLIF\(current_setting\('request\.jwt\.claim\.sub', TRUE\), ''\)/u);
  assert.match(migration, /membership\."revokedAt" IS NULL/u);
  assert.match(migration, /player\."clerkUserId" = d01_clerk_subject\(\)/u);
  assert.doesNotMatch(migration, /FOR\s+(INSERT|UPDATE|DELETE|ALL)\s+TO\s+authenticated/iu);
  assert.doesNotMatch(migration, /GRANT\s+[^;]*(INSERT|UPDATE|DELETE)[^;]*TO\s+authenticated/iu);
  assert.match(migration, /GRANT SELECT ON TABLE %I TO authenticated/u);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO service_role/u);
  assert.match(migration, /REVOKE ALL ON TABLE %I FROM anon/u);
  assert.match(
    migration,
    /D01 migration requires Supabase roles anon, authenticated, and service_role/u,
  );
  assert.match(migration, /rolname = 'service_role' AND rolbypassrls/u);
});

test('PostgreSQL runner waits for the target database and verifies the Supabase role precondition', () => {
  assert.doesNotMatch(integrationRunner, /pg_isready/u);
  assert.match(integrationRunner, /--dbname d01_test --tuples-only --no-align/u);
  assert.match(integrationRunner, /--command 'SELECT 1'/u);
  assert.match(
    integrationRunner,
    /D01 migration requires Supabase roles anon, authenticated, and service_role/u,
  );
});

test('migration includes P0 indexes, constraints, hashes, and idempotency retention', () => {
  for (const index of [
    'RestaurantMembership_restaurantId_revokedAt_idx',
    'CompetitiveSave_restaurantId_retiredAt_idx',
    'Order_restaurantId_businessDay_status_idx',
    'ReplayEvent_restaurantId_businessDay_sequence_idx',
    'DayEndSnapshot_restaurantId_businessDay_idx',
    'InventoryTransaction_restaurantId_occurredAt_idx',
  ]) {
    assert.match(migration, new RegExp(`CREATE INDEX "${index}"`, 'u'));
  }

  assert.match(migration, /UNIQUE \("saveId", "businessDay", "sequence"\)/u);
  assert.match(migration, /UNIQUE \("actorScope", "idempotencyKey"\)/u);
  assert.ok(migration.includes(`"eventHash" ~ '^[0-9a-f]{64}$'`));
  assert.ok(migration.includes(`"snapshotHash" ~ '^[0-9a-f]{64}$'`));
  assert.match(migration, /INTERVAL '30 days'/u);
});

test('rollback explicitly removes every migration-owned table and type', () => {
  for (const table of [...p0Tables].reverse()) {
    assert.match(
      rollback,
      new RegExp(`DROP TABLE IF EXISTS "${escapeRegex(table)}"`, 'u'),
      `${table} missing from rollback`,
    );
  }

  for (const type of [
    'OrderType',
    'OrderStatus',
    'PaymentMethod',
    'MembershipRole',
    'SaveMode',
    'EmployeeKind',
    'InventoryTransactionKind',
    'FinancialRiskStatus',
    'ReputationDimension',
    'WipeBatchStatus',
  ]) {
    assert.match(rollback, new RegExp(`DROP TYPE IF EXISTS "${type}"`, 'u'));
  }
});

test('D01 artifacts never use schema push', () => {
  assert.doesNotMatch(`${schema}\n${migration}\n${rollback}`, /prisma\s+db\s+push/iu);
  assert.match(migrationLock, /provider\s*=\s*"postgresql"/u);
});
