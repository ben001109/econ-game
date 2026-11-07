BEGIN;

-- E04 reputation is canonical to six decimal places. The original D01 integer
-- projections cannot persist the immutable service result without rounding.
ALTER TABLE "DayEndSnapshot"
  ALTER COLUMN "reputationPrice" TYPE NUMERIC(9,6) USING "reputationPrice"::NUMERIC(9,6),
  ALTER COLUMN "reputationSpeed" TYPE NUMERIC(9,6) USING "reputationSpeed"::NUMERIC(9,6),
  ALTER COLUMN "reputationQuality" TYPE NUMERIC(9,6) USING "reputationQuality"::NUMERIC(9,6),
  ALTER COLUMN "reputationFairness" TYPE NUMERIC(9,6) USING "reputationFairness"::NUMERIC(9,6),
  ALTER COLUMN "reputationVibe" TYPE NUMERIC(9,6) USING "reputationVibe"::NUMERIC(9,6);
ALTER TABLE "ReputationDimensionHistory"
  ALTER COLUMN "score" TYPE NUMERIC(9,6) USING "score"::NUMERIC(9,6);

CREATE FUNCTION p0_guard_settled_evidence() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  expected_period_count INTEGER;
  expected_event_types TEXT[];
  actual_event_types TEXT[];
  common_event_hash TEXT;
BEGIN
  IF OLD."status" <> 'SERVICE_COMPLETE' OR NEW."status" <> 'SETTLED' THEN
    RETURN NEW;
  END IF;
  expected_period_count := CASE NEW."servicePeriodPlan"
    WHEN 'TWO_PERIODS' THEN 2
    WHEN 'THREE_PERIODS' THEN 3
    ELSE NULL END;
  expected_event_types := CASE NEW."servicePeriodPlan"
    WHEN 'TWO_PERIODS' THEN ARRAY[
      'BUSINESS_DAY_OPENED','SERVICE_PERIOD_COMPLETED','SERVICE_PERIOD_COMPLETED',
      'INVENTORY_DAY_FINALIZED','DAY_END_SETTLED','RISK_DAY_FINALIZED'
    ]::TEXT[]
    WHEN 'THREE_PERIODS' THEN ARRAY[
      'BUSINESS_DAY_OPENED','SERVICE_PERIOD_COMPLETED','SERVICE_PERIOD_COMPLETED',
      'SERVICE_PERIOD_COMPLETED','INVENTORY_DAY_FINALIZED','DAY_END_SETTLED','RISK_DAY_FINALIZED'
    ]::TEXT[]
    ELSE NULL END;
  SELECT array_agg(event."eventType" ORDER BY event."sequence"), min(event."eventHash")
    INTO actual_event_types, common_event_hash
  FROM "ReplayEvent" event
  WHERE event."restaurantId" = NEW."restaurantId" AND event."saveId" = NEW."saveId"
    AND event."businessDay" = NEW."businessDay";
  IF NEW."settledByCommandId" IS NULL OR NEW."settledAt" IS NULL
     OR expected_period_count IS NULL OR actual_event_types IS DISTINCT FROM expected_event_types
     OR common_event_hash IS NULL
     OR EXISTS (
       SELECT 1 FROM "ReplayEvent" event
       WHERE event."restaurantId" = NEW."restaurantId" AND event."saveId" = NEW."saveId"
         AND event."businessDay" = NEW."businessDay" AND event."eventHash" <> common_event_hash
     )
     OR (SELECT count(*) FROM "ReplayEvent" event
         WHERE event."restaurantId" = NEW."restaurantId" AND event."saveId" = NEW."saveId"
           AND event."businessDay" = NEW."businessDay" AND event."servicePeriodExecutionId" IS NOT NULL)
        <> expected_period_count
     OR NOT EXISTS (
       SELECT 1 FROM "DayEndSnapshot" snapshot
       WHERE snapshot."restaurantId" = NEW."restaurantId" AND snapshot."saveId" = NEW."saveId"
         AND snapshot."businessDay" = NEW."businessDay" AND snapshot."eventHash" = common_event_hash
     )
     OR (SELECT count(*) FROM "RiskState" risk
         WHERE risk."restaurantId" = NEW."restaurantId" AND risk."saveId" = NEW."saveId"
           AND risk."businessDay" = NEW."businessDay" AND risk."version" = 1) <> 1
     OR (SELECT count(*) FROM "ReputationDimensionHistory" reputation
         WHERE reputation."restaurantId" = NEW."restaurantId" AND reputation."saveId" = NEW."saveId"
           AND reputation."businessDay" = NEW."businessDay" AND reputation."version" = 1) <> 5 THEN
    RAISE EXCEPTION 'SETTLED requires complete immutable replay, day-end, risk, and reputation evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'BusinessDay_settled_evidence_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BusinessDay_settled_evidence_guard"
  BEFORE UPDATE ON "BusinessDay"
  FOR EACH ROW EXECUTE FUNCTION p0_guard_settled_evidence();

REVOKE ALL ON FUNCTION p0_guard_settled_evidence() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION p0_guard_settled_evidence() TO service_role;

COMMIT;
