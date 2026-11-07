import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../../prisma/migrations/20260823000100_advance_service_period_guards/migration.sql', import.meta.url),
  'utf8',
);
const rollback = readFileSync(
  new URL('../../prisma/migrations/20260823000100_advance_service_period_guards/rollback.sql', import.meta.url),
  'utf8',
);

test('guards canonical service-period order, hash chaining, and final transition', () => {
  assert.match(migration, /ServicePeriodExecution_order_guard/);
  assert.match(migration, /previousResultHash/);
  assert.match(migration, /ARRAY\['LUNCH','DINNER'\]/);
  assert.match(migration, /ARRAY\['LUNCH','OFF_PEAK','DINNER'\]/);
  assert.match(migration, /BusinessDay_service_complete_evidence_check/);
  assert.match(migration, /REVOKE ALL ON FUNCTION p0_guard_service_period_order\(\) FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(migration, /GRANT .*authenticated/);
});

test('rollback removes only the additive ADVANCE guards', () => {
  assert.match(rollback, /DROP TRIGGER IF EXISTS "BusinessDay_service_complete_guard"/);
  assert.match(rollback, /DROP TRIGGER IF EXISTS "ServicePeriodExecution_order_guard"/);
  assert.doesNotMatch(rollback, /DROP TABLE|DROP TYPE/);
});
