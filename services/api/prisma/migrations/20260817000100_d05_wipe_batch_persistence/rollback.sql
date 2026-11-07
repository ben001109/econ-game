-- D05-B rollback removes only the additive persistence layer. It refuses to
-- discard lifecycle evidence; restore from a reviewed backup instead.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "WipeBatchCheckpoint" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "WipeAccountGuardEvaluation" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "WipeTombstone" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "WipeBatchSaveScope" LIMIT 1) THEN
    RAISE EXCEPTION 'D05-B rollback refuses to remove persisted wipe evidence';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS "WipeBatchCheckpoint_validate_insert" ON "WipeBatchCheckpoint";
DROP TRIGGER IF EXISTS "WipeBatchSaveScope_validate_insert" ON "WipeBatchSaveScope";
DROP TRIGGER IF EXISTS "WipeAccountGuardEvaluation_validate_insert" ON "WipeAccountGuardEvaluation";
DROP TRIGGER IF EXISTS "WipeTombstone_validate_insert" ON "WipeTombstone";
DROP TRIGGER IF EXISTS "WipeBatchCheckpoint_append_only" ON "WipeBatchCheckpoint";
DROP TRIGGER IF EXISTS "WipeAccountGuardEvaluation_append_only" ON "WipeAccountGuardEvaluation";
DROP TRIGGER IF EXISTS "WipeTombstone_append_only" ON "WipeTombstone";
DROP TRIGGER IF EXISTS "WipeBatchSaveScope_append_only" ON "WipeBatchSaveScope";
DROP TRIGGER IF EXISTS "WipeBatch_lock_authority" ON "WipeBatch";
DROP TRIGGER IF EXISTS "WipeBatch_prepare_clear_window" ON "WipeBatch";

DROP FUNCTION IF EXISTS d05b_validate_checkpoint_insert();
DROP FUNCTION IF EXISTS d05b_validate_tombstone_insert();
DROP FUNCTION IF EXISTS d05b_validate_account_guard_insert();
DROP FUNCTION IF EXISTS d05b_require_cleared_checkpoint(TEXT);
DROP FUNCTION IF EXISTS d05b_validate_save_scope_insert();
DROP FUNCTION IF EXISTS d05b_reject_evidence_mutation();
DROP FUNCTION IF EXISTS d05b_lock_wipe_batch_authority();
DROP FUNCTION IF EXISTS d05b_prepare_wipe_batch_window();

DROP TABLE IF EXISTS "WipeTombstone";
DROP TABLE IF EXISTS "WipeAccountGuardEvaluation";
DROP TABLE IF EXISTS "WipeBatchCheckpoint";
DROP TABLE IF EXISTS "WipeBatchSaveScope";

ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_restaurantId_saveId_id_key";

DROP INDEX IF EXISTS "WipeBatch_lifecyclePhase_createdAt_idx";
ALTER TABLE "WipeBatch"
  DROP CONSTRAINT IF EXISTS "WipeBatch_lifecycle_time_order_check",
  DROP CONSTRAINT IF EXISTS "WipeBatch_clear_window_check",
  DROP CONSTRAINT IF EXISTS "WipeBatch_lifecycle_authority_check",
  DROP CONSTRAINT IF EXISTS "WipeBatch_verification_binding_check",
  DROP CONSTRAINT IF EXISTS "WipeBatch_approval_authority_check",
  DROP CONSTRAINT IF EXISTS "WipeBatch_manifest_binding_check",
  DROP CONSTRAINT IF EXISTS "WipeBatch_authority_binding_check",
  DROP CONSTRAINT IF EXISTS "WipeBatch_approvedByPlayerId_fkey",
  DROP CONSTRAINT IF EXISTS "WipeBatch_requestedByPlayerId_fkey",
  DROP CONSTRAINT IF EXISTS "WipeBatch_id_restaurantId_key",
  DROP COLUMN IF EXISTS "verificationHash",
  DROP COLUMN IF EXISTS "dryRunManifestHash",
  DROP COLUMN IF EXISTS "dryRunManifest",
  DROP COLUMN IF EXISTS "verifiedAt",
  DROP COLUMN IF EXISTS "clearedAt",
  DROP COLUMN IF EXISTS "clearEligibleAt",
  DROP COLUMN IF EXISTS "isolatedAt",
  DROP COLUMN IF EXISTS "frozenAt",
  DROP COLUMN IF EXISTS "approvedAt",
  DROP COLUMN IF EXISTS "policyHash",
  DROP COLUMN IF EXISTS "policyVersion",
  DROP COLUMN IF EXISTS "scopeHash",
  DROP COLUMN IF EXISTS "scopeVersion",
  DROP COLUMN IF EXISTS "lifecyclePhase";

DROP TYPE IF EXISTS "WipeTombstoneFamily";
DROP TYPE IF EXISTS "WipeAccountGuardOutcome";
DROP TYPE IF EXISTS "WipeCheckpointOutcome";
DROP TYPE IF EXISTS "WipeLifecyclePhase";
