import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const migrationDirectory = `${repositoryRoot}/services/api/prisma/migrations/20260817000100_d05_wipe_batch_persistence`;
const migration = readFileSync(`${migrationDirectory}/migration.sql`, 'utf8');
const rollback = readFileSync(`${migrationDirectory}/rollback.sql`, 'utf8');
const schema = readFileSync(`${repositoryRoot}/services/api/prisma/schema.prisma`, 'utf8');

test('D05-B is an additive authority and evidence migration with a paired guarded rollback', () => {
  for (const table of [
    'WipeBatchSaveScope',
    'WipeBatchCheckpoint',
    'WipeAccountGuardEvaluation',
    'WipeTombstone',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
    assert.match(rollback, new RegExp(`DROP TABLE IF EXISTS "${table}"`));
  }

  assert.match(rollback, /rollback refuses to remove persisted wipe evidence/);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\b|\bTRUNCATE\b|\bUPDATE\s+"/i);
  assert.doesNotMatch(migration, /prisma\s+db\s+push/i);
  assert.doesNotMatch(migration, /Clerk|clerk\.com|IdentityLink"\s+SET/i);
  assert.doesNotMatch(
    rollback,
    /DROP TABLE IF EXISTS "(?:Player|CompetitiveSave|WipeBatch|AuditLog)"/,
  );
});

test('WipeBatch authority is version/hash-bound and isolates for 30 DB-UTC calendar days', () => {
  assert.match(migration, /"scopeVersion" TEXT/);
  assert.match(migration, /"scopeHash" VARCHAR\(64\)/);
  assert.match(migration, /"policyVersion" TEXT/);
  assert.match(migration, /"policyHash" VARCHAR\(64\)/);
  assert.match(migration, /WipeBatch_authority_binding_check/);
  assert.match(migration, /WipeBatch_requestedByPlayerId_fkey/);
  assert.match(migration, /WipeBatch_approvedByPlayerId_fkey/);
  assert.match(migration, /"requestedByPlayerId" <> "approvedByPlayerId"/);
  assert.match(migration, /SET timezone = 'UTC'/);
  assert.match(migration, /"isolatedAt" AT TIME ZONE 'UTC'\) \+ INTERVAL '30 days'/);
  assert.match(migration, /D05-B isolation window is immutable/);
  assert.match(migration, /CURRENT_TIMESTAMP < batch_record\."clearEligibleAt"/);
  assert.match(
    migration,
    /OLD\."verificationSnapshot" IS NOT NULL[\s\S]+OLD\."verificationHash" IS NOT NULL/,
  );
});

test('checkpoint evidence is append-only, contiguous, forward-only, and manually resumable', () => {
  assert.match(migration, /WipeBatchCheckpoint_batch_sequence_key/);
  assert.match(migration, /WipeBatchCheckpoint_batch_phase_attempt_key/);
  assert.match(migration, /checkpoint chain must begin at FROZEN attempt 1/);
  assert.match(migration, /checkpoint sequence must be contiguous/);
  assert.match(migration, /failed checkpoint may only forward-resume the same phase/);
  assert.match(migration, /succeeded checkpoint must advance exactly one phase/);
  assert.match(migration, /lifecycle must advance exactly one phase/);
  assert.match(migration, /lifecycle advance requires the matching successful checkpoint/);
  assert.match(migration, /D05-B lifecycle evidence is append-only/);
  assert.match(migration, /"manifestHash" VARCHAR\(64\)/);
  assert.match(migration, /"countSnapshot" JSONB/);
  assert.match(migration, /"countHash" VARCHAR\(64\)/);
  assert.match(migration, /"errorCode" TEXT/);
  assert.match(migration, /"errorDetails" JSONB/);
  assert.match(
    migration,
    /"outcome" = 'SUCCEEDED'[\s\S]+"manifestHash" IS NOT NULL[\s\S]+"countSnapshot" IS NOT NULL[\s\S]+"countHash" IS NOT NULL/,
  );
  assert.match(migration, /checkpoint phase requires the immediately preceding batch phase/);
  assert.match(
    migration,
    /freeze checkpoint requires finalized scope and matching dry-run manifest/,
  );
  assert.match(
    migration,
    /verified checkpoint requires dry-run and terminal verification evidence/,
  );
});

test('save scope finalizes only after authority approval and before freeze', () => {
  assert.match(migration, /d05b_validate_save_scope_insert/);
  assert.match(migration, /save scope must match the batch tenant/);
  assert.match(migration, /save scope requires finalized immutable authority and approval/);
  assert.match(migration, /batch_record\."lifecyclePhase" IS NOT NULL/);
  assert.match(migration, /"phase" = 'FROZEN'/);
  assert.match(migration, /save scope is immutable after freeze begins/);
  assert.match(migration, /WipeBatch_approval_authority_check/);
});

test('tombstone and account guard records preserve referential locators and fail closed by enum', () => {
  assert.match(
    migration,
    /CREATE TYPE "WipeTombstoneFamily" AS ENUM \(\s*'CompetitiveSave', 'Employee', 'InventoryStock', 'Order', 'Player', 'RestaurantMembership'/,
  );
  assert.match(migration, /WipeTombstone_save_scope_fkey/);
  assert.match(migration, /WipeTombstone_playerId_fkey/);
  assert.match(migration, /WipeTombstone_membershipId_fkey/);
  assert.match(migration, /WipeTombstone_employee_scope_fkey/);
  assert.match(migration, /WipeTombstone_inventory_stock_scope_fkey/);
  assert.match(migration, /WipeTombstone_order_scope_fkey/);
  assert.match(migration, /"retainedEvidenceHash" VARCHAR\(64\) NOT NULL/);
  assert.match(migration, /'ACCOUNT_RETAINED_GUARD'/);
  assert.match(migration, /WipeAccountGuardEvaluation_batch_scope_fkey/);
  assert.match(migration, /WipeTombstone_batch_scope_fkey/);
  assert.match(migration, /account guard player is outside the finalized save scope/);
  assert.match(migration, /tombstone save is outside the finalized batch scope/);
  assert.match(migration, /membership tombstone is outside the scoped player tenant/);
  assert.doesNotMatch(migration, /MenuSelection|OrderItem|Payment|TaxLine|Tip/);
});

test('account and tombstone evidence is phase-gated and cannot bypass the latest guard', () => {
  assert.match(migration, /d05b_require_cleared_checkpoint/);
  assert.match(migration, /batch_record\."lifecyclePhase" <> 'CLEARED'/);
  assert.match(migration, /latest_checkpoint\."phase" <> 'CLEARED'/);
  assert.match(migration, /latest_checkpoint\."outcome" <> 'SUCCEEDED'/);
  assert.match(migration, /evidence requires the matching successful CLEARED checkpoint/);
  assert.match(migration, /ORDER BY "attempt" DESC LIMIT 1/);
  assert.match(migration, /account tombstone requires a prior ELIGIBLE guard/);
});

test('new D05 evidence tables are service-only under forced RLS', () => {
  assert.match(migration, /ALTER TABLE %I ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE %I FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE %I FROM authenticated/);
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE %I TO service_role/);
  assert.doesNotMatch(migration, /CREATE POLICY[\s\S]+TO authenticated/);
});

test('Prisma schema exposes the additive D05-B persistence contract', () => {
  for (const model of [
    'WipeBatchSaveScope',
    'WipeBatchCheckpoint',
    'WipeAccountGuardEvaluation',
    'WipeTombstone',
  ]) {
    assert.match(schema, new RegExp(`model ${model} \\{`));
  }
  assert.match(schema, /lifecyclePhase\s+WipeLifecyclePhase\?/);
  assert.match(schema, /clearEligibleAt\s+DateTime\?/);
  assert.match(schema, /retainedEvidenceHash\s+String\s+@db\.VarChar\(64\)/);
  assert.match(
    schema,
    /model WipeAccountGuardEvaluation \{[\s\S]+restaurantId\s+String[\s\S]+@relation\(fields: \[wipeBatchId, restaurantId\]/,
  );
  assert.match(
    schema,
    /model WipeTombstone \{[\s\S]+restaurantId\s+String[\s\S]+@relation\(fields: \[wipeBatchId, restaurantId\]/,
  );
});
