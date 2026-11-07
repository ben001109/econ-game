import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const migrationRoot = `${repositoryRoot}/services/api/prisma/migrations/20260818000200_p0_plat_business_day_skeleton`;
const migration = readFileSync(`${migrationRoot}/migration.sql`, 'utf8');
const rollback = readFileSync(`${migrationRoot}/rollback.sql`, 'utf8');
const apiSchema = readFileSync(`${repositoryRoot}/services/api/prisma/schema.prisma`, 'utf8');
const workerSchema = readFileSync(`${repositoryRoot}/services/worker/prisma/schema.prisma`, 'utf8');

const model = (schema, name) =>
  schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';

test('API and worker schemas share the BusinessDay persistence contract', () => {
  for (const schema of [apiSchema, workerSchema]) {
    assert.match(
      schema,
      /enum BusinessDayStatus \{\s+PREOPEN\s+OPEN\s+SERVICE_COMPLETE\s+SETTLED\s+\}/,
    );

    const day = model(schema, 'BusinessDay');
    const snapshot = model(schema, 'PreopenDaySnapshot');
    const execution = model(schema, 'ServicePeriodExecution');

    assert.match(day, /status\s+BusinessDayStatus\s+@default\(PREOPEN\)/);
    assert.match(day, /createdByCommandId\s+String\s+@unique/);
    assert.match(day, /openedByCommandId\s+String\?\s+@unique/);
    assert.match(day, /settledByCommandId\s+String\?\s+@unique/);
    assert.match(day, /consumedPreopenSnapshotId\s+String\?/);
    assert.match(day, /openSnapshotHash\s+String\?\s+@db\.VarChar\(64\)/);
    assert.match(day, /@@id\(\[restaurantId, id\]\)/);
    assert.match(day, /@@unique\(\[saveId, businessDay\]\)/);
    assert.match(day, /@@unique\(\[restaurantId, saveId, businessDay\]\)/);

    assert.match(snapshot, /revision\s+Int/);
    assert.match(snapshot, /commandId\s+String\s+@unique/);
    assert.match(snapshot, /payload\s+Json/);
    assert.match(snapshot, /snapshotHash\s+String\s+@db\.VarChar\(64\)/);
    assert.match(snapshot, /@@unique\(\[saveId, businessDay, revision\]\)/);
    assert.match(
      snapshot,
      /@@unique\(\[restaurantId, saveId, businessDay, id\]\)/,
    );

    assert.match(execution, /ordinal\s+Int/);
    assert.match(execution, /periodKey\s+String/);
    assert.match(execution, /commandId\s+String\s+@unique/);
    assert.match(execution, /inputHash\s+String\s+@db\.VarChar\(64\)/);
    assert.match(execution, /resultHash\s+String\s+@db\.VarChar\(64\)/);
    assert.match(execution, /@@unique\(\[saveId, businessDay, ordinal\]\)/);
    assert.match(execution, /@@unique\(\[saveId, businessDay, periodKey\]\)/);
  }
});

test('API evidence models use scoped BusinessDay links without duplicating authority hashes', () => {
  const replayEvent = model(apiSchema, 'ReplayEvent');
  const dayEnd = model(apiSchema, 'DayEndSnapshot');
  const replayExecution = model(apiSchema, 'VersionedReplayExecution');
  const marketTick = model(apiSchema, 'MarketTick');

  assert.match(replayEvent, /servicePeriodExecutionId\s+String\?/);
  assert.match(replayEvent, /businessDayRecord\s+BusinessDay\s+@relation/);
  assert.match(replayEvent, /servicePeriodExecution\s+ServicePeriodExecution\?/);
  assert.match(dayEnd, /businessDayRecord\s+BusinessDay\s+@relation/);
  assert.match(replayExecution, /businessDayRecord\s+BusinessDay\?\s+@relation/);
  assert.match(marketTick, /businessDayRecord\s+BusinessDay\s+@relation/);
  assert.match(replayEvent, /eventHash\s+String\s+@db\.VarChar\(64\)/);
  assert.match(dayEnd, /snapshotHash\s+String\s+@db\.VarChar\(64\)/);
  assert.equal((replayEvent.match(/eventHash/g) ?? []).length, 1);
  assert.equal((dayEnd.match(/snapshotHash/g) ?? []).length, 1);
  assert.doesNotMatch(workerSchema, /model (?:ReplayEvent|DayEndSnapshot|VersionedReplayExecution|MarketTick) \{/);
});

test('forward migration refuses unprovable history and performs no automatic backfill', () => {
  for (const evidence of [
    'ReplayEvent',
    'DayEndSnapshot',
    'VersionedReplayExecution',
    'MarketTick',
  ]) {
    assert.match(migration, new RegExp(`SELECT 1 FROM "${evidence}"`));
  }
  assert.match(migration, /no automatic backfill is permitted/);
  assert.doesNotMatch(migration, /^\s*(?:INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|TRUNCATE\b)/im);
  assert.doesNotMatch(migration, /prisma\s+db\s+push/i);
});

test('database constraints encode identities, scoped RESTRICT links, and no period allowlist', () => {
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "BusinessDay_one_active_per_save_key"[\s\S]*WHERE "status" <> 'SETTLED'/,
  );
  assert.match(migration, /UNIQUE \("saveId", "businessDay"\)/);
  assert.match(migration, /UNIQUE \("saveId", "businessDay", "revision"\)/);
  assert.match(migration, /UNIQUE \("saveId", "businessDay", "ordinal"\)/);
  assert.match(migration, /UNIQUE \("saveId", "businessDay", "periodKey"\)/);
  assert.match(migration, /"ordinal" > 0/);
  assert.match(migration, /"inputHash" ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /"resultHash" ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /BusinessDay_consumed_preopen_snapshot_scope_fkey/);
  assert.match(migration, /ReplayEvent_service_period_execution_scope_fkey/);
  for (const evidence of [
    'ReplayEvent',
    'DayEndSnapshot',
    'VersionedReplayExecution',
    'MarketTick',
  ]) {
    assert.match(migration, new RegExp(`${evidence}_business_day_scope_fkey`));
  }
  assert.doesNotMatch(migration, /ON DELETE CASCADE/i);
  assert.doesNotMatch(migration, /periodKey"\s+(?:IN|=)/i);
});

test('triggers enforce ordered transitions and immutable snapshot/execution evidence', () => {
  assert.match(
    migration,
    /OLD\."status" = 'PREOPEN' AND NEW\."status" = 'OPEN'/,
  );
  assert.match(
    migration,
    /OLD\."status" = 'OPEN' AND NEW\."status" = 'SERVICE_COMPLETE'/,
  );
  assert.match(
    migration,
    /OLD\."status" = 'SERVICE_COMPLETE' AND NEW\."status" = 'SETTLED'/,
  );
  assert.match(migration, /OPEN requires the matching scoped immutable pre-open snapshot/);
  assert.match(migration, /SETTLED requires a matching scoped DayEndSnapshot/);
  assert.match(migration, /PreopenDaySnapshot is immutable durable evidence/);
  assert.match(migration, /ServicePeriodExecution is immutable durable evidence/);
  assert.match(migration, /BusinessDay is durable state and cannot be deleted/);
});

test('new tables are force-RLS and have only exact service-role grants', () => {
  for (const table of [
    'BusinessDay',
    'PreopenDaySnapshot',
    'ServicePeriodExecution',
  ]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      assert.match(
        migration,
        new RegExp(`REVOKE ALL ON TABLE "${table}" FROM ${role}`),
      );
    }
  }
  assert.match(
    migration,
    /GRANT SELECT, INSERT, UPDATE ON TABLE "BusinessDay" TO service_role/,
  );
  assert.match(
    migration,
    /GRANT SELECT, INSERT ON TABLE "PreopenDaySnapshot" TO service_role/,
  );
  assert.match(
    migration,
    /GRANT SELECT, INSERT ON TABLE "ServicePeriodExecution" TO service_role/,
  );
  assert.doesNotMatch(migration, /CREATE\s+POLICY/i);
  assert.doesNotMatch(migration, /GRANT\s+[^;]+\s+TO\s+(?:anon|authenticated)/i);
});

test('rollback refuses durable state or linkage and deletes nothing', () => {
  for (const evidence of [
    'BusinessDay state exists',
    'PreopenDaySnapshot evidence exists',
    'ServicePeriodExecution evidence exists',
    'ReplayEvent service-period linkage exists',
  ]) {
    assert.match(rollback, new RegExp(`rollback refused: ${evidence}`));
  }
  assert.ok(
    rollback.indexOf('rollback refused: BusinessDay state exists') <
      rollback.indexOf('DROP TABLE IF EXISTS "BusinessDay"'),
  );
  assert.doesNotMatch(rollback, /DELETE\s+FROM|TRUNCATE|CASCADE/i);
});

test('static inspection makes no PostgreSQL runtime claim', () => {
  assert.doesNotMatch(import.meta.url, /postgres/i);
});
