-- D05-B additive persistence for the closed-beta WipeBatch lifecycle.
-- This migration creates authority/evidence structures only. It does not
-- isolate, tombstone, clear, or otherwise mutate application data.

DO $$
BEGIN
  IF to_regclass('public."WipeBatch"') IS NULL
     OR to_regclass('public."CompetitiveSave"') IS NULL
     OR to_regclass('public."Player"') IS NULL
     OR to_regclass('public."RestaurantMembership"') IS NULL THEN
    RAISE EXCEPTION 'D05-B requires the D01 identity, save, membership, and WipeBatch tables';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls) THEN
    RAISE EXCEPTION 'D05-B requires the Supabase service_role with BYPASSRLS';
  END IF;
END;
$$;

CREATE TYPE "WipeLifecyclePhase" AS ENUM ('FROZEN', 'ISOLATED', 'CLEARED', 'VERIFIED');
CREATE TYPE "WipeCheckpointOutcome" AS ENUM ('SUCCEEDED', 'FAILED');
CREATE TYPE "WipeAccountGuardOutcome" AS ENUM ('ELIGIBLE', 'ACCOUNT_RETAINED_GUARD');
CREATE TYPE "WipeTombstoneFamily" AS ENUM (
  'CompetitiveSave', 'Employee', 'InventoryStock', 'Order', 'Player', 'RestaurantMembership'
);

ALTER TABLE "WipeBatch"
  ADD COLUMN "lifecyclePhase" "WipeLifecyclePhase",
  ADD COLUMN "scopeVersion" TEXT,
  ADD COLUMN "scopeHash" VARCHAR(64),
  ADD COLUMN "policyVersion" TEXT,
  ADD COLUMN "policyHash" VARCHAR(64),
  ADD COLUMN "approvedAt" TIMESTAMPTZ,
  ADD COLUMN "frozenAt" TIMESTAMPTZ,
  ADD COLUMN "isolatedAt" TIMESTAMPTZ,
  ADD COLUMN "clearEligibleAt" TIMESTAMPTZ,
  ADD COLUMN "clearedAt" TIMESTAMPTZ,
  ADD COLUMN "verifiedAt" TIMESTAMPTZ,
  ADD COLUMN "dryRunManifest" JSONB,
  ADD COLUMN "dryRunManifestHash" VARCHAR(64),
  ADD COLUMN "verificationHash" VARCHAR(64);

ALTER TABLE "WipeBatch"
  ADD CONSTRAINT "WipeBatch_id_restaurantId_key" UNIQUE ("id", "restaurantId"),
  ADD CONSTRAINT "WipeBatch_requestedByPlayerId_fkey"
    FOREIGN KEY ("requestedByPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "WipeBatch_approvedByPlayerId_fkey"
    FOREIGN KEY ("approvedByPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "WipeBatch_authority_binding_check" CHECK (
    ("scopeVersion" IS NULL AND "scopeHash" IS NULL AND "policyVersion" IS NULL AND "policyHash" IS NULL)
    OR (
      length("scopeVersion") BETWEEN 1 AND 200
      AND "scopeHash" ~ '^[0-9a-f]{64}$'
      AND length("policyVersion") BETWEEN 1 AND 200
      AND "policyHash" ~ '^[0-9a-f]{64}$'
    )
  ) NOT VALID,
  ADD CONSTRAINT "WipeBatch_manifest_binding_check" CHECK (
    ("dryRunManifest" IS NULL AND "dryRunManifestHash" IS NULL)
    OR ("dryRunManifest" IS NOT NULL AND "dryRunManifestHash" ~ '^[0-9a-f]{64}$')
  ) NOT VALID,
  ADD CONSTRAINT "WipeBatch_verification_binding_check" CHECK (
    ("verificationSnapshot" IS NULL AND "verificationHash" IS NULL)
    OR ("verificationSnapshot" IS NOT NULL AND "verificationHash" ~ '^[0-9a-f]{64}$')
  ) NOT VALID,
  ADD CONSTRAINT "WipeBatch_approval_authority_check" CHECK (
    ("approvedByPlayerId" IS NULL AND "approvedAt" IS NULL)
    OR (
      "approvedByPlayerId" IS NOT NULL AND "approvedAt" IS NOT NULL
      AND "requestedByPlayerId" IS NOT NULL AND "requestedByPlayerId" <> "approvedByPlayerId"
      AND "scopeVersion" IS NOT NULL AND "scopeHash" IS NOT NULL
      AND "policyVersion" IS NOT NULL AND "policyHash" IS NOT NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT "WipeBatch_lifecycle_authority_check" CHECK (
    "lifecyclePhase" IS NULL OR (
      "scopeVersion" IS NOT NULL AND "scopeHash" IS NOT NULL
      AND "policyVersion" IS NOT NULL AND "policyHash" IS NOT NULL
      AND "requestedByPlayerId" IS NOT NULL AND "approvedByPlayerId" IS NOT NULL
      AND "requestedByPlayerId" <> "approvedByPlayerId"
      AND "approvedAt" IS NOT NULL AND "frozenAt" IS NOT NULL
      AND ("lifecyclePhase" = 'FROZEN' OR (
        "isolatedAt" IS NOT NULL AND "clearEligibleAt" IS NOT NULL
        AND ("lifecyclePhase" = 'ISOLATED' OR (
          "clearedAt" IS NOT NULL
          AND ("lifecyclePhase" = 'CLEARED' OR (
            "verifiedAt" IS NOT NULL
            AND "dryRunManifest" IS NOT NULL AND "dryRunManifestHash" IS NOT NULL
            AND "verificationSnapshot" IS NOT NULL AND "verificationHash" IS NOT NULL
          ))
        ))
      ))
    )
  ) NOT VALID,
  ADD CONSTRAINT "WipeBatch_clear_window_check" CHECK (
    ("isolatedAt" IS NULL AND "clearEligibleAt" IS NULL)
    OR (
      "isolatedAt" IS NOT NULL
      AND "clearEligibleAt" = (("isolatedAt" AT TIME ZONE 'UTC') + INTERVAL '30 days') AT TIME ZONE 'UTC'
    )
  ) NOT VALID,
  ADD CONSTRAINT "WipeBatch_lifecycle_time_order_check" CHECK (
    ("approvedAt" IS NULL OR "approvedAt" >= "createdAt")
    AND ("frozenAt" IS NULL OR ("approvedAt" IS NOT NULL AND "frozenAt" >= "approvedAt"))
    AND ("isolatedAt" IS NULL OR ("frozenAt" IS NOT NULL AND "isolatedAt" >= "frozenAt"))
    AND ("clearedAt" IS NULL OR ("clearEligibleAt" IS NOT NULL AND "clearedAt" >= "clearEligibleAt"))
    AND ("verifiedAt" IS NULL OR ("clearedAt" IS NOT NULL AND "verifiedAt" >= "clearedAt"))
  ) NOT VALID;

CREATE INDEX "WipeBatch_lifecyclePhase_createdAt_idx"
  ON "WipeBatch" ("lifecyclePhase", "createdAt");

CREATE TABLE "WipeBatchSaveScope" (
  "wipeBatchId" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "scopeItemHash" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WipeBatchSaveScope_pkey" PRIMARY KEY ("wipeBatchId", "saveId"),
  CONSTRAINT "WipeBatchSaveScope_batch_ordinal_key" UNIQUE ("wipeBatchId", "ordinal"),
  CONSTRAINT "WipeBatchSaveScope_batch_scope_fkey" FOREIGN KEY ("wipeBatchId", "restaurantId")
    REFERENCES "WipeBatch"("id", "restaurantId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeBatchSaveScope_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId")
    REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeBatchSaveScope_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "WipeBatchSaveScope_hash_check" CHECK ("scopeItemHash" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "WipeBatchSaveScope_restaurantId_saveId_idx"
  ON "WipeBatchSaveScope" ("restaurantId", "saveId");

CREATE FUNCTION d05b_validate_save_scope_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  batch_record "WipeBatch"%ROWTYPE;
BEGIN
  SELECT * INTO batch_record FROM "WipeBatch" WHERE "id" = NEW."wipeBatchId" FOR UPDATE;
  IF NOT FOUND OR batch_record."restaurantId" IS DISTINCT FROM NEW."restaurantId" THEN
    RAISE EXCEPTION 'D05-B save scope must match the batch tenant';
  END IF;
  IF batch_record."scopeVersion" IS NULL OR batch_record."scopeHash" IS NULL
     OR batch_record."policyVersion" IS NULL OR batch_record."policyHash" IS NULL
     OR batch_record."requestedByPlayerId" IS NULL OR batch_record."approvedByPlayerId" IS NULL
     OR batch_record."requestedByPlayerId" = batch_record."approvedByPlayerId"
     OR batch_record."approvedAt" IS NULL THEN
    RAISE EXCEPTION 'D05-B save scope requires finalized immutable authority and approval';
  END IF;
  IF batch_record."lifecyclePhase" IS NOT NULL OR batch_record."frozenAt" IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM "WipeBatchCheckpoint"
       WHERE "wipeBatchId" = NEW."wipeBatchId" AND "phase" = 'FROZEN'
     ) THEN
    RAISE EXCEPTION 'D05-B save scope is immutable after freeze begins';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE "WipeBatchCheckpoint" (
  "id" TEXT PRIMARY KEY,
  "wipeBatchId" TEXT NOT NULL,
  "sequence" BIGINT NOT NULL,
  "phase" "WipeLifecyclePhase" NOT NULL,
  "attempt" INTEGER NOT NULL,
  "outcome" "WipeCheckpointOutcome" NOT NULL,
  "actorPlayerId" TEXT NOT NULL,
  "manifestHash" VARCHAR(64),
  "countSnapshot" JSONB,
  "countHash" VARCHAR(64),
  "evidence" JSONB NOT NULL,
  "evidenceHash" VARCHAR(64) NOT NULL,
  "errorCode" TEXT,
  "errorDetails" JSONB,
  "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WipeBatchCheckpoint_wipeBatchId_fkey" FOREIGN KEY ("wipeBatchId")
    REFERENCES "WipeBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeBatchCheckpoint_actorPlayerId_fkey" FOREIGN KEY ("actorPlayerId")
    REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeBatchCheckpoint_batch_sequence_key" UNIQUE ("wipeBatchId", "sequence"),
  CONSTRAINT "WipeBatchCheckpoint_batch_phase_attempt_key" UNIQUE ("wipeBatchId", "phase", "attempt"),
  CONSTRAINT "WipeBatchCheckpoint_sequence_attempt_check" CHECK ("sequence" > 0 AND "attempt" > 0),
  CONSTRAINT "WipeBatchCheckpoint_hash_check" CHECK (
    "evidenceHash" ~ '^[0-9a-f]{64}$'
    AND ("manifestHash" IS NULL OR "manifestHash" ~ '^[0-9a-f]{64}$')
    AND (("countSnapshot" IS NULL AND "countHash" IS NULL)
      OR ("countSnapshot" IS NOT NULL AND "countHash" ~ '^[0-9a-f]{64}$'))
  ),
  CONSTRAINT "WipeBatchCheckpoint_outcome_check" CHECK (
    ("outcome" = 'SUCCEEDED'
      AND "manifestHash" IS NOT NULL AND "countSnapshot" IS NOT NULL AND "countHash" IS NOT NULL
      AND "errorCode" IS NULL AND "errorDetails" IS NULL)
    OR ("outcome" = 'FAILED' AND length("errorCode") BETWEEN 1 AND 200)
  )
);

CREATE INDEX "WipeBatchCheckpoint_batch_phase_occurred_idx"
  ON "WipeBatchCheckpoint" ("wipeBatchId", "phase", "occurredAt");

CREATE TABLE "WipeAccountGuardEvaluation" (
  "id" TEXT PRIMARY KEY,
  "wipeBatchId" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "playerId" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "outcome" "WipeAccountGuardOutcome" NOT NULL,
  "evidence" JSONB NOT NULL,
  "evidenceHash" VARCHAR(64) NOT NULL,
  "evaluatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WipeAccountGuardEvaluation_batch_scope_fkey" FOREIGN KEY ("wipeBatchId", "restaurantId")
    REFERENCES "WipeBatch"("id", "restaurantId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeAccountGuardEvaluation_playerId_fkey" FOREIGN KEY ("playerId")
    REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeAccountGuardEvaluation_batch_player_attempt_key" UNIQUE ("wipeBatchId", "playerId", "attempt"),
  CONSTRAINT "WipeAccountGuardEvaluation_attempt_check" CHECK ("attempt" > 0),
  CONSTRAINT "WipeAccountGuardEvaluation_hash_check" CHECK ("evidenceHash" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "WipeAccountGuardEvaluation_player_evaluated_idx"
  ON "WipeAccountGuardEvaluation" ("playerId", "evaluatedAt");

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_restaurantId_saveId_id_key" UNIQUE ("restaurantId", "saveId", "id");

CREATE TABLE "WipeTombstone" (
  "id" TEXT PRIMARY KEY,
  "wipeBatchId" TEXT NOT NULL,
  "family" "WipeTombstoneFamily" NOT NULL,
  "recordId" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT,
  "playerId" TEXT,
  "restaurantMembershipId" TEXT,
  "employeeId" TEXT,
  "inventoryStockId" TEXT,
  "orderId" TEXT,
  "locator" JSONB NOT NULL,
  "locatorHash" VARCHAR(64) NOT NULL,
  "retainedEvidenceHash" VARCHAR(64) NOT NULL,
  "tombstonedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WipeTombstone_batch_scope_fkey" FOREIGN KEY ("wipeBatchId", "restaurantId")
    REFERENCES "WipeBatch"("id", "restaurantId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeTombstone_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId")
    REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeTombstone_playerId_fkey" FOREIGN KEY ("playerId")
    REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeTombstone_membershipId_fkey" FOREIGN KEY ("restaurantMembershipId")
    REFERENCES "RestaurantMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeTombstone_employee_scope_fkey" FOREIGN KEY ("restaurantId", "saveId", "employeeId")
    REFERENCES "Employee"("restaurantId", "saveId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeTombstone_inventory_stock_scope_fkey" FOREIGN KEY ("restaurantId", "saveId", "inventoryStockId")
    REFERENCES "InventoryStock"("restaurantId", "saveId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeTombstone_order_scope_fkey" FOREIGN KEY ("restaurantId", "saveId", "orderId")
    REFERENCES "Order"("restaurantId", "saveId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeTombstone_batch_family_record_key" UNIQUE ("wipeBatchId", "family", "recordId"),
  CONSTRAINT "WipeTombstone_hash_check" CHECK (
    "locatorHash" ~ '^[0-9a-f]{64}$' AND "retainedEvidenceHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "WipeTombstone_reference_check" CHECK (
    ("family" = 'CompetitiveSave' AND "recordId" = "saveId"
      AND "restaurantId" IS NOT NULL AND "saveId" IS NOT NULL
      AND "employeeId" IS NULL AND "inventoryStockId" IS NULL AND "orderId" IS NULL
      AND "playerId" IS NULL AND "restaurantMembershipId" IS NULL)
    OR ("family" = 'Employee' AND "recordId" = "employeeId"
      AND "restaurantId" IS NOT NULL AND "saveId" IS NOT NULL AND "employeeId" IS NOT NULL
      AND "inventoryStockId" IS NULL AND "orderId" IS NULL
      AND "playerId" IS NULL AND "restaurantMembershipId" IS NULL)
    OR ("family" = 'InventoryStock' AND "recordId" = "inventoryStockId"
      AND "restaurantId" IS NOT NULL AND "saveId" IS NOT NULL AND "inventoryStockId" IS NOT NULL
      AND "employeeId" IS NULL AND "orderId" IS NULL
      AND "playerId" IS NULL AND "restaurantMembershipId" IS NULL)
    OR ("family" = 'Order' AND "recordId" = "orderId"
      AND "restaurantId" IS NOT NULL AND "saveId" IS NOT NULL AND "orderId" IS NOT NULL
      AND "employeeId" IS NULL AND "inventoryStockId" IS NULL
      AND "playerId" IS NULL AND "restaurantMembershipId" IS NULL)
    OR ("family" = 'Player' AND "playerId" = "recordId"
      AND "saveId" IS NULL AND "restaurantMembershipId" IS NULL
      AND "employeeId" IS NULL AND "inventoryStockId" IS NULL AND "orderId" IS NULL)
    OR ("family" = 'RestaurantMembership' AND "restaurantMembershipId" = "recordId"
      AND "playerId" IS NOT NULL AND "saveId" IS NULL
      AND "employeeId" IS NULL AND "inventoryStockId" IS NULL AND "orderId" IS NULL)
  )
);

CREATE INDEX "WipeTombstone_restaurantId_saveId_idx" ON "WipeTombstone" ("restaurantId", "saveId");
CREATE INDEX "WipeTombstone_playerId_idx" ON "WipeTombstone" ("playerId");
CREATE INDEX "WipeTombstone_membershipId_idx" ON "WipeTombstone" ("restaurantMembershipId");
CREATE INDEX "WipeTombstone_employeeId_idx" ON "WipeTombstone" ("employeeId");
CREATE INDEX "WipeTombstone_inventoryStockId_idx" ON "WipeTombstone" ("inventoryStockId");
CREATE INDEX "WipeTombstone_orderId_idx" ON "WipeTombstone" ("orderId");

CREATE FUNCTION d05b_require_cleared_checkpoint(batch_id TEXT) RETURNS "WipeBatch"
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  batch_record "WipeBatch"%ROWTYPE;
  latest_checkpoint "WipeBatchCheckpoint"%ROWTYPE;
BEGIN
  SELECT * INTO batch_record FROM "WipeBatch" WHERE "id" = batch_id FOR UPDATE;
  SELECT * INTO latest_checkpoint FROM "WipeBatchCheckpoint"
  WHERE "wipeBatchId" = batch_id ORDER BY "sequence" DESC LIMIT 1;
  IF NOT FOUND OR batch_record."lifecyclePhase" <> 'CLEARED'
     OR latest_checkpoint."phase" <> 'CLEARED' OR latest_checkpoint."outcome" <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'D05-B evidence requires the matching successful CLEARED checkpoint';
  END IF;
  RETURN batch_record;
END;
$$;

CREATE FUNCTION d05b_validate_account_guard_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  batch_record "WipeBatch"%ROWTYPE;
BEGIN
  batch_record := d05b_require_cleared_checkpoint(NEW."wipeBatchId");
  IF batch_record."restaurantId" IS DISTINCT FROM NEW."restaurantId" THEN
    RAISE EXCEPTION 'D05-B account guard must match the batch tenant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "WipeBatchSaveScope" scope_row
    JOIN "CompetitiveSave" save_row
      ON save_row."restaurantId" = scope_row."restaurantId" AND save_row."id" = scope_row."saveId"
    WHERE scope_row."wipeBatchId" = NEW."wipeBatchId"
      AND scope_row."restaurantId" = NEW."restaurantId"
      AND save_row."ownerPlayerId" = NEW."playerId"
  ) THEN
    RAISE EXCEPTION 'D05-B account guard player is outside the finalized save scope';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION d05b_validate_tombstone_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  batch_record "WipeBatch"%ROWTYPE;
BEGIN
  batch_record := d05b_require_cleared_checkpoint(NEW."wipeBatchId");
  IF batch_record."restaurantId" IS DISTINCT FROM NEW."restaurantId" THEN
    RAISE EXCEPTION 'D05-B tombstone must match the batch tenant';
  END IF;

  IF NEW."family" IN ('CompetitiveSave', 'Employee', 'InventoryStock', 'Order') THEN
    IF NOT EXISTS (
      SELECT 1 FROM "WipeBatchSaveScope"
      WHERE "wipeBatchId" = NEW."wipeBatchId"
        AND "restaurantId" = NEW."restaurantId" AND "saveId" = NEW."saveId"
    ) THEN
      RAISE EXCEPTION 'D05-B tombstone save is outside the finalized batch scope';
    END IF;
  ELSIF NEW."family" IN ('Player', 'RestaurantMembership') THEN
    IF (
      SELECT "outcome" FROM "WipeAccountGuardEvaluation"
      WHERE "wipeBatchId" = NEW."wipeBatchId"
        AND "restaurantId" = NEW."restaurantId" AND "playerId" = NEW."playerId"
      ORDER BY "attempt" DESC LIMIT 1
    ) IS DISTINCT FROM 'ELIGIBLE' THEN
      RAISE EXCEPTION 'D05-B account tombstone requires a prior ELIGIBLE guard';
    END IF;
    IF NEW."family" = 'RestaurantMembership' AND NOT EXISTS (
      SELECT 1 FROM "RestaurantMembership"
      WHERE "id" = NEW."restaurantMembershipId" AND "playerId" = NEW."playerId"
        AND "restaurantId" = NEW."restaurantId"
    ) THEN
      RAISE EXCEPTION 'D05-B membership tombstone is outside the scoped player tenant';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION d05b_prepare_wipe_batch_window() RETURNS trigger
LANGUAGE plpgsql
SET timezone = 'UTC'
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD."isolatedAt" IS NULL AND NEW."isolatedAt" IS NOT NULL THEN
    NEW."clearEligibleAt" := ((NEW."isolatedAt" AT TIME ZONE 'UTC') + INTERVAL '30 days') AT TIME ZONE 'UTC';
  ELSIF OLD."isolatedAt" IS NOT NULL THEN
    IF NEW."isolatedAt" IS DISTINCT FROM OLD."isolatedAt"
       OR NEW."clearEligibleAt" IS DISTINCT FROM OLD."clearEligibleAt" THEN
      RAISE EXCEPTION 'D05-B isolation window is immutable';
    END IF;
  ELSIF NEW."clearEligibleAt" IS NOT NULL THEN
    RAISE EXCEPTION 'D05-B clear eligibility requires isolation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION d05b_lock_wipe_batch_authority() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  old_rank INTEGER;
  new_rank INTEGER;
  latest_checkpoint "WipeBatchCheckpoint"%ROWTYPE;
BEGIN
  IF NEW."scope" IS DISTINCT FROM OLD."scope"
     OR NEW."requestedByPlayerId" IS DISTINCT FROM OLD."requestedByPlayerId" THEN
    RAISE EXCEPTION 'D05-B batch scope/requester is immutable';
  END IF;

  IF (OLD."scopeVersion" IS NOT NULL AND NEW."scopeVersion" IS DISTINCT FROM OLD."scopeVersion")
     OR (OLD."scopeHash" IS NOT NULL AND NEW."scopeHash" IS DISTINCT FROM OLD."scopeHash")
     OR (OLD."policyVersion" IS NOT NULL AND NEW."policyVersion" IS DISTINCT FROM OLD."policyVersion")
     OR (OLD."policyHash" IS NOT NULL AND NEW."policyHash" IS DISTINCT FROM OLD."policyHash")
     OR (OLD."dryRunManifest" IS NOT NULL AND NEW."dryRunManifest" IS DISTINCT FROM OLD."dryRunManifest")
     OR (OLD."dryRunManifestHash" IS NOT NULL AND NEW."dryRunManifestHash" IS DISTINCT FROM OLD."dryRunManifestHash")
     OR (OLD."verificationSnapshot" IS NOT NULL AND NEW."verificationSnapshot" IS DISTINCT FROM OLD."verificationSnapshot")
     OR (OLD."verificationHash" IS NOT NULL AND NEW."verificationHash" IS DISTINCT FROM OLD."verificationHash") THEN
    RAISE EXCEPTION 'D05-B authority and manifest bindings are immutable once set';
  END IF;

  IF OLD."approvedByPlayerId" IS NOT NULL
     AND NEW."approvedByPlayerId" IS DISTINCT FROM OLD."approvedByPlayerId" THEN
    RAISE EXCEPTION 'D05-B approver is immutable once set';
  END IF;
  IF OLD."approvedAt" IS NOT NULL AND NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" THEN
    RAISE EXCEPTION 'D05-B approval time is immutable once set';
  END IF;

  old_rank := CASE OLD."lifecyclePhase"
    WHEN 'FROZEN' THEN 1 WHEN 'ISOLATED' THEN 2 WHEN 'CLEARED' THEN 3 WHEN 'VERIFIED' THEN 4 ELSE 0 END;
  new_rank := CASE NEW."lifecyclePhase"
    WHEN 'FROZEN' THEN 1 WHEN 'ISOLATED' THEN 2 WHEN 'CLEARED' THEN 3 WHEN 'VERIFIED' THEN 4 ELSE 0 END;
  IF old_rank > 0 AND new_rank < old_rank THEN
    RAISE EXCEPTION 'D05-B lifecycle cannot move backwards';
  END IF;
  IF new_rank > old_rank THEN
    IF new_rank <> old_rank + 1 THEN
      RAISE EXCEPTION 'D05-B lifecycle must advance exactly one phase';
    END IF;
    SELECT * INTO latest_checkpoint FROM "WipeBatchCheckpoint"
    WHERE "wipeBatchId" = NEW."id" ORDER BY "sequence" DESC LIMIT 1;
    IF NOT FOUND OR latest_checkpoint."phase" IS DISTINCT FROM NEW."lifecyclePhase"
       OR latest_checkpoint."outcome" <> 'SUCCEEDED' THEN
      RAISE EXCEPTION 'D05-B lifecycle advance requires the matching successful checkpoint';
    END IF;
  END IF;

  IF OLD."frozenAt" IS NOT NULL AND NEW."frozenAt" IS DISTINCT FROM OLD."frozenAt"
     OR OLD."clearedAt" IS NOT NULL AND NEW."clearedAt" IS DISTINCT FROM OLD."clearedAt"
     OR OLD."verifiedAt" IS NOT NULL AND NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt" THEN
    RAISE EXCEPTION 'D05-B lifecycle timestamps are immutable once set';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WipeBatch_prepare_clear_window"
  BEFORE UPDATE ON "WipeBatch"
  FOR EACH ROW EXECUTE FUNCTION d05b_prepare_wipe_batch_window();
CREATE TRIGGER "WipeBatch_lock_authority"
  BEFORE UPDATE ON "WipeBatch"
  FOR EACH ROW EXECUTE FUNCTION d05b_lock_wipe_batch_authority();

CREATE FUNCTION d05b_validate_checkpoint_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  batch_record "WipeBatch"%ROWTYPE;
  previous_record "WipeBatchCheckpoint"%ROWTYPE;
  previous_rank INTEGER;
  new_rank INTEGER;
  batch_rank INTEGER;
BEGIN
  SELECT * INTO batch_record FROM "WipeBatch" WHERE "id" = NEW."wipeBatchId" FOR UPDATE;
  IF NOT FOUND OR batch_record."scopeVersion" IS NULL OR batch_record."scopeHash" IS NULL
     OR batch_record."policyVersion" IS NULL OR batch_record."policyHash" IS NULL
     OR batch_record."requestedByPlayerId" IS NULL OR batch_record."approvedByPlayerId" IS NULL
     OR batch_record."requestedByPlayerId" = batch_record."approvedByPlayerId" THEN
    RAISE EXCEPTION 'D05-B checkpoint requires immutable authority and distinct actors';
  END IF;

  SELECT * INTO previous_record FROM "WipeBatchCheckpoint"
  WHERE "wipeBatchId" = NEW."wipeBatchId" ORDER BY "sequence" DESC LIMIT 1;
  new_rank := CASE NEW."phase"
    WHEN 'FROZEN' THEN 1 WHEN 'ISOLATED' THEN 2 WHEN 'CLEARED' THEN 3 WHEN 'VERIFIED' THEN 4 END;
  batch_rank := CASE batch_record."lifecyclePhase"
    WHEN 'FROZEN' THEN 1 WHEN 'ISOLATED' THEN 2 WHEN 'CLEARED' THEN 3 WHEN 'VERIFIED' THEN 4 ELSE 0 END;

  IF batch_rank <> new_rank - 1 THEN
    RAISE EXCEPTION 'D05-B checkpoint phase requires the immediately preceding batch phase';
  END IF;

  IF NOT FOUND THEN
    IF NEW."sequence" <> 1 OR NEW."phase" <> 'FROZEN' OR NEW."attempt" <> 1 THEN
      RAISE EXCEPTION 'D05-B checkpoint chain must begin at FROZEN attempt 1';
    END IF;
  ELSE
    IF NEW."sequence" <> previous_record."sequence" + 1 THEN
      RAISE EXCEPTION 'D05-B checkpoint sequence must be contiguous';
    END IF;
    previous_rank := CASE previous_record."phase"
      WHEN 'FROZEN' THEN 1 WHEN 'ISOLATED' THEN 2 WHEN 'CLEARED' THEN 3 WHEN 'VERIFIED' THEN 4 END;
    IF previous_record."outcome" = 'FAILED' THEN
      IF new_rank <> previous_rank OR NEW."attempt" <> previous_record."attempt" + 1 THEN
        RAISE EXCEPTION 'D05-B failed checkpoint may only forward-resume the same phase';
      END IF;
    ELSIF previous_rank = 4 OR new_rank <> previous_rank + 1 OR NEW."attempt" <> 1 THEN
      RAISE EXCEPTION 'D05-B succeeded checkpoint must advance exactly one phase';
    END IF;
  END IF;

  IF NEW."phase" = 'CLEARED' AND (
    batch_record."isolatedAt" IS NULL OR batch_record."clearEligibleAt" IS NULL
    OR CURRENT_TIMESTAMP < batch_record."clearEligibleAt"
  ) THEN
    RAISE EXCEPTION 'D05-B clear checkpoint is not eligible';
  END IF;
  IF NEW."outcome" = 'SUCCEEDED' AND NEW."phase" = 'FROZEN' AND (
    batch_record."dryRunManifest" IS NULL OR batch_record."dryRunManifestHash" IS NULL
    OR NEW."manifestHash" <> batch_record."dryRunManifestHash"
    OR NOT EXISTS (SELECT 1 FROM "WipeBatchSaveScope" WHERE "wipeBatchId" = NEW."wipeBatchId")
  ) THEN
    RAISE EXCEPTION 'D05-B freeze checkpoint requires finalized scope and matching dry-run manifest';
  END IF;
  IF NEW."outcome" = 'SUCCEEDED' AND NEW."phase" = 'VERIFIED' AND (
    batch_record."dryRunManifest" IS NULL OR batch_record."dryRunManifestHash" IS NULL
    OR batch_record."verificationSnapshot" IS NULL OR batch_record."verificationHash" IS NULL
  ) THEN
    RAISE EXCEPTION 'D05-B verified checkpoint requires dry-run and terminal verification evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION d05b_reject_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'D05-B lifecycle evidence is append-only';
END;
$$;

CREATE TRIGGER "WipeBatchCheckpoint_validate_insert"
  BEFORE INSERT ON "WipeBatchCheckpoint"
  FOR EACH ROW EXECUTE FUNCTION d05b_validate_checkpoint_insert();
CREATE TRIGGER "WipeBatchSaveScope_validate_insert"
  BEFORE INSERT ON "WipeBatchSaveScope"
  FOR EACH ROW EXECUTE FUNCTION d05b_validate_save_scope_insert();
CREATE TRIGGER "WipeAccountGuardEvaluation_validate_insert"
  BEFORE INSERT ON "WipeAccountGuardEvaluation"
  FOR EACH ROW EXECUTE FUNCTION d05b_validate_account_guard_insert();
CREATE TRIGGER "WipeTombstone_validate_insert"
  BEFORE INSERT ON "WipeTombstone"
  FOR EACH ROW EXECUTE FUNCTION d05b_validate_tombstone_insert();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'WipeBatchSaveScope', 'WipeBatchCheckpoint', 'WipeAccountGuardEvaluation', 'WipeTombstone'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION d05b_reject_evidence_mutation()',
      table_name || '_append_only', table_name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', table_name);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT ON TABLE %I TO service_role', table_name);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION d05b_prepare_wipe_batch_window() FROM PUBLIC;
REVOKE ALL ON FUNCTION d05b_lock_wipe_batch_authority() FROM PUBLIC;
REVOKE ALL ON FUNCTION d05b_validate_checkpoint_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION d05b_reject_evidence_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION d05b_validate_save_scope_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION d05b_require_cleared_checkpoint(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION d05b_validate_account_guard_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION d05b_validate_tombstone_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION d05b_prepare_wipe_batch_window() TO service_role;
GRANT EXECUTE ON FUNCTION d05b_lock_wipe_batch_authority() TO service_role;
GRANT EXECUTE ON FUNCTION d05b_validate_checkpoint_insert() TO service_role;
GRANT EXECUTE ON FUNCTION d05b_reject_evidence_mutation() TO service_role;
GRANT EXECUTE ON FUNCTION d05b_validate_save_scope_insert() TO service_role;
GRANT EXECUTE ON FUNCTION d05b_require_cleared_checkpoint(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION d05b_validate_account_guard_insert() TO service_role;
GRANT EXECUTE ON FUNCTION d05b_validate_tombstone_insert() TO service_role;
