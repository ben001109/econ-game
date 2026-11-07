-- Fail-closed rollback for the P0 BusinessDay persistence skeleton. No durable
-- day state, immutable snapshot/execution evidence, or linkage may be erased.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public."BusinessDay"') IS NOT NULL
     AND EXISTS (SELECT 1 FROM "BusinessDay") THEN
    RAISE EXCEPTION 'rollback refused: BusinessDay state exists';
  END IF;
  IF to_regclass('public."PreopenDaySnapshot"') IS NOT NULL
     AND EXISTS (SELECT 1 FROM "PreopenDaySnapshot") THEN
    RAISE EXCEPTION 'rollback refused: PreopenDaySnapshot evidence exists';
  END IF;
  IF to_regclass('public."ServicePeriodExecution"') IS NOT NULL
     AND EXISTS (SELECT 1 FROM "ServicePeriodExecution") THEN
    RAISE EXCEPTION 'rollback refused: ServicePeriodExecution evidence exists';
  END IF;
  IF to_regclass('public."ReplayEvent"') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM "ReplayEvent" WHERE "servicePeriodExecutionId" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'rollback refused: ReplayEvent service-period linkage exists';
  END IF;
END;
$$;

ALTER TABLE IF EXISTS "ReplayEvent"
  DROP CONSTRAINT IF EXISTS "ReplayEvent_service_period_execution_scope_fkey",
  DROP CONSTRAINT IF EXISTS "ReplayEvent_business_day_scope_fkey",
  DROP COLUMN IF EXISTS "servicePeriodExecutionId";
ALTER TABLE IF EXISTS "DayEndSnapshot"
  DROP CONSTRAINT IF EXISTS "DayEndSnapshot_business_day_scope_fkey";
ALTER TABLE IF EXISTS "VersionedReplayExecution"
  DROP CONSTRAINT IF EXISTS "VersionedReplayExecution_business_day_scope_fkey";
ALTER TABLE IF EXISTS "MarketTick"
  DROP CONSTRAINT IF EXISTS "MarketTick_business_day_scope_fkey";

ALTER TABLE IF EXISTS "BusinessDay"
  DROP CONSTRAINT IF EXISTS "BusinessDay_consumed_preopen_snapshot_scope_fkey";
ALTER TABLE IF EXISTS "PreopenDaySnapshot"
  DROP CONSTRAINT IF EXISTS "PreopenDaySnapshot_business_day_scope_fkey";
ALTER TABLE IF EXISTS "ServicePeriodExecution"
  DROP CONSTRAINT IF EXISTS "ServicePeriodExecution_business_day_scope_fkey";

DROP TABLE IF EXISTS "ServicePeriodExecution";
DROP TABLE IF EXISTS "PreopenDaySnapshot";
DROP TABLE IF EXISTS "BusinessDay";

DROP FUNCTION IF EXISTS p0_guard_service_period_execution();
DROP FUNCTION IF EXISTS p0_guard_preopen_day_snapshot();
DROP FUNCTION IF EXISTS p0_guard_business_day();
DROP TYPE IF EXISTS "BusinessDayStatus";

COMMIT;
