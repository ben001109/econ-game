-- P0-PLAT BusinessDay persistence skeleton.
--
-- This migration intentionally does not create or backfill a current day. It
-- records phase, immutable configuration/execution evidence, and scoped links
-- only. Runtime command handling and gameplay payload decisions remain out of
-- scope.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public."Restaurant"') IS NULL
     OR to_regclass('public."CompetitiveSave"') IS NULL
     OR to_regclass('public."ReplayEvent"') IS NULL
     OR to_regclass('public."DayEndSnapshot"') IS NULL
     OR to_regclass('public."VersionedReplayExecution"') IS NULL
     OR to_regclass('public."MarketTick"') IS NULL THEN
    RAISE EXCEPTION 'P0 BusinessDay skeleton requires D01 and D03 durable simulation baselines'
      USING ERRCODE = '0A000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'P0 BusinessDay skeleton requires service_role BYPASSRLS plus anon and authenticated roles'
      USING ERRCODE = '0A000';
  END IF;

  -- A BusinessDay cannot be reconstructed from historical hashes alone. Fail
  -- closed rather than silently inventing phase, command, snapshot, or period
  -- lineage for any pre-existing day-scoped evidence.
  IF EXISTS (SELECT 1 FROM "ReplayEvent")
     OR EXISTS (SELECT 1 FROM "DayEndSnapshot")
     OR EXISTS (
       SELECT 1 FROM "VersionedReplayExecution" WHERE "businessDay" IS NOT NULL
     )
     OR EXISTS (SELECT 1 FROM "MarketTick") THEN
    RAISE EXCEPTION 'P0 BusinessDay migration refused: pre-existing day evidence has no provable BusinessDay lineage; no automatic backfill is permitted'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE TYPE "BusinessDayStatus" AS ENUM (
  'PREOPEN', 'OPEN', 'SERVICE_COMPLETE', 'SETTLED'
);

CREATE TABLE "BusinessDay" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "businessDay" INTEGER NOT NULL,
  "status" "BusinessDayStatus" NOT NULL DEFAULT 'PREOPEN',
  "servicePeriodPlan" TEXT NOT NULL,
  "simulationRuleVersion" TEXT NOT NULL,
  "createdByCommandId" TEXT NOT NULL UNIQUE,
  "openedByCommandId" TEXT UNIQUE,
  "settledByCommandId" TEXT UNIQUE,
  "consumedPreopenSnapshotId" TEXT,
  "openSnapshot" JSONB,
  "openSnapshotHash" VARCHAR(64),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openedAt" TIMESTAMPTZ,
  "settledAt" TIMESTAMPTZ,
  CONSTRAINT "BusinessDay_pkey" PRIMARY KEY ("restaurantId", "id"),
  CONSTRAINT "BusinessDay_saveId_businessDay_key" UNIQUE ("saveId", "businessDay"),
  CONSTRAINT "BusinessDay_restaurantId_saveId_businessDay_key"
    UNIQUE ("restaurantId", "saveId", "businessDay"),
  CONSTRAINT "BusinessDay_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BusinessDay_save_scope_fkey"
    FOREIGN KEY ("restaurantId", "saveId")
    REFERENCES "CompetitiveSave"("restaurantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BusinessDay_identity_check" CHECK (
    "businessDay" > 0
    AND length("servicePeriodPlan") > 0
    AND length("simulationRuleVersion") > 0
  ),
  CONSTRAINT "BusinessDay_open_hash_check" CHECK (
    "openSnapshotHash" IS NULL OR "openSnapshotHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "BusinessDay_phase_evidence_check" CHECK (
    (
      "status" = 'PREOPEN'
      AND "openedByCommandId" IS NULL
      AND "consumedPreopenSnapshotId" IS NULL
      AND "openSnapshot" IS NULL
      AND "openSnapshotHash" IS NULL
      AND "openedAt" IS NULL
      AND "settledByCommandId" IS NULL
      AND "settledAt" IS NULL
    ) OR (
      "status" IN ('OPEN', 'SERVICE_COMPLETE')
      AND "openedByCommandId" IS NOT NULL
      AND "consumedPreopenSnapshotId" IS NOT NULL
      AND "openSnapshot" IS NOT NULL
      AND "openSnapshotHash" IS NOT NULL
      AND "openedAt" IS NOT NULL
      AND "settledByCommandId" IS NULL
      AND "settledAt" IS NULL
    ) OR (
      "status" = 'SETTLED'
      AND "openedByCommandId" IS NOT NULL
      AND "consumedPreopenSnapshotId" IS NOT NULL
      AND "openSnapshot" IS NOT NULL
      AND "openSnapshotHash" IS NOT NULL
      AND "openedAt" IS NOT NULL
      AND "settledByCommandId" IS NOT NULL
      AND "settledAt" IS NOT NULL
      AND "settledAt" >= "openedAt"
    )
  )
);

CREATE UNIQUE INDEX "BusinessDay_one_active_per_save_key"
  ON "BusinessDay" ("saveId") WHERE "status" <> 'SETTLED';
CREATE INDEX "BusinessDay_restaurantId_status_idx"
  ON "BusinessDay" ("restaurantId", "status");

CREATE TABLE "PreopenDaySnapshot" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "businessDay" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL,
  "commandId" TEXT NOT NULL UNIQUE,
  "snapshotSchemaVersion" TEXT NOT NULL,
  "simulationRuleVersion" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "snapshotHash" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreopenDaySnapshot_pkey" PRIMARY KEY ("restaurantId", "id"),
  CONSTRAINT "PreopenDaySnapshot_saveId_businessDay_revision_key"
    UNIQUE ("saveId", "businessDay", "revision"),
  CONSTRAINT "PreopenDaySnapshot_scoped_id_key"
    UNIQUE ("restaurantId", "saveId", "businessDay", "id"),
  CONSTRAINT "PreopenDaySnapshot_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PreopenDaySnapshot_save_scope_fkey"
    FOREIGN KEY ("restaurantId", "saveId")
    REFERENCES "CompetitiveSave"("restaurantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PreopenDaySnapshot_business_day_scope_fkey"
    FOREIGN KEY ("restaurantId", "saveId", "businessDay")
    REFERENCES "BusinessDay"("restaurantId", "saveId", "businessDay")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PreopenDaySnapshot_revision_hash_check" CHECK (
    "businessDay" > 0
    AND "revision" > 0
    AND "snapshotHash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX "PreopenDaySnapshot_restaurantId_saveId_businessDay_idx"
  ON "PreopenDaySnapshot" ("restaurantId", "saveId", "businessDay");

ALTER TABLE "BusinessDay"
  ADD CONSTRAINT "BusinessDay_consumed_preopen_snapshot_scope_fkey"
  FOREIGN KEY (
    "restaurantId", "saveId", "businessDay", "consumedPreopenSnapshotId"
  ) REFERENCES "PreopenDaySnapshot"(
    "restaurantId", "saveId", "businessDay", "id"
  ) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ServicePeriodExecution" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "businessDay" INTEGER NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "periodKey" TEXT NOT NULL,
  "commandId" TEXT NOT NULL UNIQUE,
  "simulationRuleVersion" TEXT NOT NULL,
  "inputSnapshot" JSONB NOT NULL,
  "inputHash" VARCHAR(64) NOT NULL,
  "resultSnapshot" JSONB NOT NULL,
  "resultHash" VARCHAR(64) NOT NULL,
  "completedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "ServicePeriodExecution_pkey" PRIMARY KEY ("restaurantId", "id"),
  CONSTRAINT "ServicePeriodExecution_saveId_businessDay_ordinal_key"
    UNIQUE ("saveId", "businessDay", "ordinal"),
  CONSTRAINT "ServicePeriodExecution_saveId_businessDay_periodKey_key"
    UNIQUE ("saveId", "businessDay", "periodKey"),
  CONSTRAINT "ServicePeriodExecution_scoped_id_key"
    UNIQUE ("restaurantId", "saveId", "businessDay", "id"),
  CONSTRAINT "ServicePeriodExecution_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ServicePeriodExecution_save_scope_fkey"
    FOREIGN KEY ("restaurantId", "saveId")
    REFERENCES "CompetitiveSave"("restaurantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ServicePeriodExecution_business_day_scope_fkey"
    FOREIGN KEY ("restaurantId", "saveId", "businessDay")
    REFERENCES "BusinessDay"("restaurantId", "saveId", "businessDay")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ServicePeriodExecution_ordinal_hash_check" CHECK (
    "businessDay" > 0
    AND "ordinal" > 0
    AND "inputHash" ~ '^[0-9a-f]{64}$'
    AND "resultHash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX "ServicePeriodExecution_restaurantId_saveId_businessDay_idx"
  ON "ServicePeriodExecution" ("restaurantId", "saveId", "businessDay");

ALTER TABLE "ReplayEvent"
  ADD COLUMN "servicePeriodExecutionId" TEXT,
  ADD CONSTRAINT "ReplayEvent_business_day_scope_fkey"
    FOREIGN KEY ("restaurantId", "saveId", "businessDay")
    REFERENCES "BusinessDay"("restaurantId", "saveId", "businessDay")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReplayEvent_service_period_execution_scope_fkey"
    FOREIGN KEY (
      "restaurantId", "saveId", "businessDay", "servicePeriodExecutionId"
    ) REFERENCES "ServicePeriodExecution"(
      "restaurantId", "saveId", "businessDay", "id"
    ) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DayEndSnapshot"
  ADD CONSTRAINT "DayEndSnapshot_business_day_scope_fkey"
    FOREIGN KEY ("restaurantId", "saveId", "businessDay")
    REFERENCES "BusinessDay"("restaurantId", "saveId", "businessDay")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VersionedReplayExecution"
  ADD CONSTRAINT "VersionedReplayExecution_business_day_scope_fkey"
    FOREIGN KEY ("restaurantId", "saveId", "businessDay")
    REFERENCES "BusinessDay"("restaurantId", "saveId", "businessDay")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MarketTick"
  ADD CONSTRAINT "MarketTick_business_day_scope_fkey"
    FOREIGN KEY ("restaurantId", "saveId", "businessDay")
    REFERENCES "BusinessDay"("restaurantId", "saveId", "businessDay")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION p0_guard_preopen_day_snapshot() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PreopenDaySnapshot is immutable durable evidence'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "BusinessDay" day
    WHERE day."restaurantId" = NEW."restaurantId"
      AND day."saveId" = NEW."saveId"
      AND day."businessDay" = NEW."businessDay"
      AND day."status" = 'PREOPEN'
      AND day."simulationRuleVersion" = NEW."simulationRuleVersion"
    FOR KEY SHARE
  ) THEN
    RAISE EXCEPTION 'pre-open snapshot requires a matching PREOPEN BusinessDay and simulation rule version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PreopenDaySnapshot_validate_insert"
  BEFORE INSERT ON "PreopenDaySnapshot"
  FOR EACH ROW EXECUTE FUNCTION p0_guard_preopen_day_snapshot();
CREATE TRIGGER "PreopenDaySnapshot_reject_mutation"
  BEFORE UPDATE OR DELETE ON "PreopenDaySnapshot"
  FOR EACH ROW EXECUTE FUNCTION p0_guard_preopen_day_snapshot();

CREATE FUNCTION p0_guard_service_period_execution() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'ServicePeriodExecution is immutable durable evidence'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "BusinessDay" day
    WHERE day."restaurantId" = NEW."restaurantId"
      AND day."saveId" = NEW."saveId"
      AND day."businessDay" = NEW."businessDay"
      AND day."status" = 'OPEN'
      AND day."simulationRuleVersion" = NEW."simulationRuleVersion"
    FOR KEY SHARE
  ) THEN
    RAISE EXCEPTION 'service period execution requires a matching OPEN BusinessDay and simulation rule version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ServicePeriodExecution_validate_insert"
  BEFORE INSERT ON "ServicePeriodExecution"
  FOR EACH ROW EXECUTE FUNCTION p0_guard_service_period_execution();
CREATE TRIGGER "ServicePeriodExecution_reject_mutation"
  BEFORE UPDATE OR DELETE ON "ServicePeriodExecution"
  FOR EACH ROW EXECUTE FUNCTION p0_guard_service_period_execution();

CREATE FUNCTION p0_guard_business_day() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  consumed_snapshot "PreopenDaySnapshot"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'BusinessDay is durable state and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PREOPEN' THEN
      RAISE EXCEPTION 'BusinessDay must be created in PREOPEN'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."restaurantId" IS DISTINCT FROM OLD."restaurantId"
     OR NEW."saveId" IS DISTINCT FROM OLD."saveId"
     OR NEW."businessDay" IS DISTINCT FROM OLD."businessDay"
     OR NEW."servicePeriodPlan" IS DISTINCT FROM OLD."servicePeriodPlan"
     OR NEW."simulationRuleVersion" IS DISTINCT FROM OLD."simulationRuleVersion"
     OR NEW."createdByCommandId" IS DISTINCT FROM OLD."createdByCommandId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'BusinessDay identity and configuration are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NOT (
    (OLD."status" = 'PREOPEN' AND NEW."status" = 'OPEN')
    OR (OLD."status" = 'OPEN' AND NEW."status" = 'SERVICE_COMPLETE')
    OR (OLD."status" = 'SERVICE_COMPLETE' AND NEW."status" = 'SETTLED')
  ) THEN
    RAISE EXCEPTION 'BusinessDay transitions are forward-only PREOPEN to OPEN to SERVICE_COMPLETE to SETTLED'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'PREOPEN' THEN
    SELECT snapshot.* INTO consumed_snapshot
    FROM "PreopenDaySnapshot" snapshot
    WHERE snapshot."restaurantId" = NEW."restaurantId"
      AND snapshot."saveId" = NEW."saveId"
      AND snapshot."businessDay" = NEW."businessDay"
      AND snapshot."id" = NEW."consumedPreopenSnapshotId"
    FOR KEY SHARE;
    IF NOT FOUND
       OR consumed_snapshot."simulationRuleVersion" <> NEW."simulationRuleVersion"
       OR consumed_snapshot."snapshotHash" <> NEW."openSnapshotHash"
       OR consumed_snapshot."payload" <> NEW."openSnapshot" THEN
      RAISE EXCEPTION 'OPEN requires the matching scoped immutable pre-open snapshot payload and hash'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."openedByCommandId" IS DISTINCT FROM OLD."openedByCommandId"
       OR NEW."consumedPreopenSnapshotId" IS DISTINCT FROM OLD."consumedPreopenSnapshotId"
       OR NEW."openSnapshot" IS DISTINCT FROM OLD."openSnapshot"
       OR NEW."openSnapshotHash" IS DISTINCT FROM OLD."openSnapshotHash"
       OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt" THEN
      RAISE EXCEPTION 'BusinessDay open evidence is immutable after OPEN'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF OLD."status" = 'SERVICE_COMPLETE' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "DayEndSnapshot" snapshot
      WHERE snapshot."restaurantId" = NEW."restaurantId"
        AND snapshot."saveId" = NEW."saveId"
        AND snapshot."businessDay" = NEW."businessDay"
      FOR KEY SHARE
    ) THEN
      RAISE EXCEPTION 'SETTLED requires a matching scoped DayEndSnapshot'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."settledByCommandId" IS DISTINCT FROM OLD."settledByCommandId"
        OR NEW."settledAt" IS DISTINCT FROM OLD."settledAt" THEN
    RAISE EXCEPTION 'settlement evidence may only be recorded on SERVICE_COMPLETE to SETTLED'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "BusinessDay_guard_lifecycle"
  BEFORE INSERT OR UPDATE OR DELETE ON "BusinessDay"
  FOR EACH ROW EXECUTE FUNCTION p0_guard_business_day();

ALTER TABLE "BusinessDay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessDay" FORCE ROW LEVEL SECURITY;
ALTER TABLE "PreopenDaySnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PreopenDaySnapshot" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ServicePeriodExecution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServicePeriodExecution" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "BusinessDay" FROM PUBLIC;
REVOKE ALL ON TABLE "BusinessDay" FROM anon;
REVOKE ALL ON TABLE "BusinessDay" FROM authenticated;
REVOKE ALL ON TABLE "PreopenDaySnapshot" FROM PUBLIC;
REVOKE ALL ON TABLE "PreopenDaySnapshot" FROM anon;
REVOKE ALL ON TABLE "PreopenDaySnapshot" FROM authenticated;
REVOKE ALL ON TABLE "ServicePeriodExecution" FROM PUBLIC;
REVOKE ALL ON TABLE "ServicePeriodExecution" FROM anon;
REVOKE ALL ON TABLE "ServicePeriodExecution" FROM authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE "BusinessDay" TO service_role;
GRANT SELECT, INSERT ON TABLE "PreopenDaySnapshot" TO service_role;
GRANT SELECT, INSERT ON TABLE "ServicePeriodExecution" TO service_role;

REVOKE ALL ON FUNCTION p0_guard_business_day() FROM PUBLIC;
REVOKE ALL ON FUNCTION p0_guard_business_day() FROM anon;
REVOKE ALL ON FUNCTION p0_guard_business_day() FROM authenticated;
REVOKE ALL ON FUNCTION p0_guard_preopen_day_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION p0_guard_preopen_day_snapshot() FROM anon;
REVOKE ALL ON FUNCTION p0_guard_preopen_day_snapshot() FROM authenticated;
REVOKE ALL ON FUNCTION p0_guard_service_period_execution() FROM PUBLIC;
REVOKE ALL ON FUNCTION p0_guard_service_period_execution() FROM anon;
REVOKE ALL ON FUNCTION p0_guard_service_period_execution() FROM authenticated;

GRANT EXECUTE ON FUNCTION p0_guard_business_day() TO service_role;
GRANT EXECUTE ON FUNCTION p0_guard_preopen_day_snapshot() TO service_role;
GRANT EXECUTE ON FUNCTION p0_guard_service_period_execution() TO service_role;

COMMIT;
