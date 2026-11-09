BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "BusinessDay" WHERE "status" = 'SETTLED')
     OR EXISTS (SELECT 1 FROM "DayEndSnapshot")
     OR EXISTS (SELECT 1 FROM "ReplayEvent")
     OR EXISTS (SELECT 1 FROM "RiskState")
     OR EXISTS (SELECT 1 FROM "ReputationDimensionHistory") THEN
    RAISE EXCEPTION 'rollback refused: settlement evidence exists';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS "BusinessDay_settled_evidence_guard" ON "BusinessDay";
DROP FUNCTION IF EXISTS p0_guard_settled_evidence();

ALTER TABLE "ReputationDimensionHistory"
  ALTER COLUMN "score" TYPE INTEGER USING "score"::INTEGER;
ALTER TABLE "DayEndSnapshot"
  ALTER COLUMN "reputationPrice" TYPE INTEGER USING "reputationPrice"::INTEGER,
  ALTER COLUMN "reputationSpeed" TYPE INTEGER USING "reputationSpeed"::INTEGER,
  ALTER COLUMN "reputationQuality" TYPE INTEGER USING "reputationQuality"::INTEGER,
  ALTER COLUMN "reputationFairness" TYPE INTEGER USING "reputationFairness"::INTEGER,
  ALTER COLUMN "reputationVibe" TYPE INTEGER USING "reputationVibe"::INTEGER;

COMMIT;
