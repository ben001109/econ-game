BEGIN;

CREATE FUNCTION p0_guard_service_period_order() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  day_plan TEXT;
  prior_count INTEGER;
  expected_period TEXT;
  prior_hash TEXT;
BEGIN
  SELECT day."servicePeriodPlan" INTO day_plan
  FROM "BusinessDay" day
  WHERE day."restaurantId" = NEW."restaurantId" AND day."saveId" = NEW."saveId"
    AND day."businessDay" = NEW."businessDay" AND day."status" = 'OPEN'
  FOR KEY SHARE;
  IF NOT FOUND OR day_plan NOT IN ('TWO_PERIODS','THREE_PERIODS') THEN
    RAISE EXCEPTION 'service period execution requires supported OPEN day authority'
      USING ERRCODE = '23514', CONSTRAINT = 'ServicePeriodExecution_order_check';
  END IF;
  SELECT count(*) INTO prior_count FROM "ServicePeriodExecution" execution
  WHERE execution."restaurantId" = NEW."restaurantId" AND execution."saveId" = NEW."saveId"
    AND execution."businessDay" = NEW."businessDay";
  expected_period := CASE
    WHEN prior_count = 0 THEN 'LUNCH'
    WHEN day_plan = 'THREE_PERIODS' AND prior_count = 1 THEN 'OFF_PEAK'
    WHEN day_plan = 'TWO_PERIODS' AND prior_count = 1 THEN 'DINNER'
    WHEN day_plan = 'THREE_PERIODS' AND prior_count = 2 THEN 'DINNER'
    ELSE NULL END;
  IF expected_period IS NULL OR NEW."ordinal" <> prior_count + 1 OR NEW."periodKey" <> expected_period
     OR NEW."inputSnapshot" ->> 'ordinal' <> NEW."ordinal"::text
     OR NEW."inputSnapshot" ->> 'periodKey' <> NEW."periodKey"
     OR NEW."inputSnapshot" ->> 'inputHash' <> NEW."inputHash"
     OR NEW."resultSnapshot" ->> 'ordinal' <> NEW."ordinal"::text
     OR NEW."resultSnapshot" ->> 'periodKey' <> NEW."periodKey"
     OR NEW."resultSnapshot" ->> 'inputHash' <> NEW."inputHash"
     OR NEW."resultSnapshot" ->> 'resultHash' <> NEW."resultHash" THEN
    RAISE EXCEPTION 'service period ordinal, period, or immutable hashes are not canonical'
      USING ERRCODE = '23514', CONSTRAINT = 'ServicePeriodExecution_order_check';
  END IF;
  IF prior_count = 0 THEN
    IF NEW."inputSnapshot" -> 'previousResultHash' <> 'null'::jsonb THEN
      RAISE EXCEPTION 'first service period cannot claim previous result evidence'
        USING ERRCODE = '23514', CONSTRAINT = 'ServicePeriodExecution_previous_hash_check';
    END IF;
  ELSE
    SELECT execution."resultHash" INTO prior_hash FROM "ServicePeriodExecution" execution
    WHERE execution."restaurantId" = NEW."restaurantId" AND execution."saveId" = NEW."saveId"
      AND execution."businessDay" = NEW."businessDay" AND execution."ordinal" = prior_count
    FOR KEY SHARE;
    IF prior_hash IS NULL OR NEW."inputSnapshot" ->> 'previousResultHash' <> prior_hash THEN
      RAISE EXCEPTION 'service period previous result hash is stale'
        USING ERRCODE = '23514', CONSTRAINT = 'ServicePeriodExecution_previous_hash_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ServicePeriodExecution_order_guard"
  BEFORE INSERT ON "ServicePeriodExecution"
  FOR EACH ROW EXECUTE FUNCTION p0_guard_service_period_order();

CREATE FUNCTION p0_guard_service_complete_transition() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  expected_periods TEXT[];
  actual_periods TEXT[];
BEGIN
  IF OLD."status" = 'OPEN' AND NEW."status" = 'SERVICE_COMPLETE' THEN
    expected_periods := CASE NEW."servicePeriodPlan"
      WHEN 'TWO_PERIODS' THEN ARRAY['LUNCH','DINNER']::TEXT[]
      WHEN 'THREE_PERIODS' THEN ARRAY['LUNCH','OFF_PEAK','DINNER']::TEXT[]
      ELSE NULL END;
    SELECT array_agg(execution."periodKey" ORDER BY execution."ordinal") INTO actual_periods
    FROM "ServicePeriodExecution" execution
    WHERE execution."restaurantId" = NEW."restaurantId" AND execution."saveId" = NEW."saveId"
      AND execution."businessDay" = NEW."businessDay";
    IF expected_periods IS NULL OR actual_periods IS DISTINCT FROM expected_periods THEN
      RAISE EXCEPTION 'SERVICE_COMPLETE requires every canonical service period execution'
        USING ERRCODE = '23514', CONSTRAINT = 'BusinessDay_service_complete_evidence_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BusinessDay_service_complete_guard"
  BEFORE UPDATE ON "BusinessDay"
  FOR EACH ROW EXECUTE FUNCTION p0_guard_service_complete_transition();

REVOKE ALL ON FUNCTION p0_guard_service_period_order() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION p0_guard_service_complete_transition() FROM PUBLIC, anon, authenticated;

COMMIT;
