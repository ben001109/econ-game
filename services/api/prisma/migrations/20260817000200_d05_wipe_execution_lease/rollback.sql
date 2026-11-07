-- Guarded rollback: evidence-bearing leases must be retained.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "WipeExecutionLease")
     OR EXISTS (SELECT 1 FROM "WipeExecutionFixtureMarker")
     OR EXISTS (
       SELECT 1 FROM "WipeBatchCheckpoint"
       WHERE "evidence"->>'version' = 'd05-lease-expiry/v1'
     ) THEN
    RAISE EXCEPTION 'D05-D rollback refused: fixture marker or lease evidence exists';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS "WipeExecutionLease_validate_update" ON "WipeExecutionLease";
DROP TRIGGER IF EXISTS "WipeExecutionLease_validate_insert" ON "WipeExecutionLease";
DROP FUNCTION IF EXISTS d05d_validate_execution_lease_update();
DROP FUNCTION IF EXISTS d05d_validate_execution_lease_insert();
DROP TABLE "WipeExecutionLease";
DROP TABLE "WipeExecutionFixtureMarker";
DROP TYPE "WipeExecutionLeaseStatus";
