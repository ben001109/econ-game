-- D05-D additive, fail-closed execution lease. This migration performs DDL only.
DO $$
BEGIN
  IF to_regclass('public."WipeBatchCheckpoint"') IS NULL
     OR to_regclass('public."WipeBatchSaveScope"') IS NULL THEN
    RAISE EXCEPTION 'D05-D requires the approved D05-B persistence migration';
  END IF;
END;
$$;

CREATE TYPE "WipeExecutionLeaseStatus" AS ENUM ('CLAIMED', 'SUCCEEDED', 'FAILED', 'EXPIRED');

CREATE TABLE "WipeExecutionFixtureMarker" (
  "singletonKey" TEXT PRIMARY KEY,
  "environment" TEXT NOT NULL,
  "fixtureNonceHash" VARCHAR(64) NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WipeExecutionFixtureMarker_singleton_check"
    CHECK ("singletonKey" = 'D05_DISPOSABLE_FIXTURE'),
  CONSTRAINT "WipeExecutionFixtureMarker_environment_check"
    CHECK (length("environment") BETWEEN 1 AND 100),
  CONSTRAINT "WipeExecutionFixtureMarker_nonce_hash_check"
    CHECK ("fixtureNonceHash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "WipeExecutionLease" (
  "id" TEXT PRIMARY KEY,
  "wipeBatchId" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "phase" "WipeLifecyclePhase" NOT NULL,
  "attempt" INTEGER NOT NULL,
  "status" "WipeExecutionLeaseStatus" NOT NULL DEFAULT 'CLAIMED',
  "requestedByPlayerId" TEXT NOT NULL,
  "executorEnvironment" TEXT NOT NULL,
  "scopeEnvironment" TEXT NOT NULL,
  "databaseFixtureNonceHash" VARCHAR(64) NOT NULL,
  "authorityHash" VARCHAR(64) NOT NULL,
  "leaseTokenHash" VARCHAR(64) NOT NULL UNIQUE,
  "claimedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "completedAt" TIMESTAMPTZ,
  "resultEvidence" JSONB,
  "resultEvidenceHash" VARCHAR(64),
  "errorCode" TEXT,
  CONSTRAINT "WipeExecutionLease_batch_scope_fkey" FOREIGN KEY ("wipeBatchId", "restaurantId")
    REFERENCES "WipeBatch"("id", "restaurantId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeExecutionLease_requester_fkey" FOREIGN KEY ("requestedByPlayerId")
    REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WipeExecutionLease_batch_phase_attempt_key" UNIQUE ("wipeBatchId", "phase", "attempt"),
  CONSTRAINT "WipeExecutionLease_phase_check" CHECK ("phase" IN ('CLEARED', 'VERIFIED')),
  CONSTRAINT "WipeExecutionLease_attempt_check" CHECK ("attempt" > 0),
  CONSTRAINT "WipeExecutionLease_environment_check" CHECK (
    length("executorEnvironment") BETWEEN 1 AND 100
    AND "executorEnvironment" = "scopeEnvironment"
  ),
  CONSTRAINT "WipeExecutionLease_hash_check" CHECK (
    "databaseFixtureNonceHash" ~ '^[0-9a-f]{64}$'
    AND "authorityHash" ~ '^[0-9a-f]{64}$'
    AND "leaseTokenHash" ~ '^[0-9a-f]{64}$'
    AND ("resultEvidenceHash" IS NULL OR "resultEvidenceHash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "WipeExecutionLease_time_check" CHECK (
    "expiresAt" > "claimedAt"
    AND ("completedAt" IS NULL OR "completedAt" >= "claimedAt")
  ),
  CONSTRAINT "WipeExecutionLease_terminal_check" CHECK (
    ("status" = 'CLAIMED' AND "completedAt" IS NULL AND "resultEvidence" IS NULL
      AND "resultEvidenceHash" IS NULL AND "errorCode" IS NULL)
    OR ("status" = 'SUCCEEDED' AND "completedAt" IS NOT NULL
      AND "resultEvidence" IS NOT NULL AND "resultEvidenceHash" IS NOT NULL
      AND "errorCode" IS NULL)
    OR ("status" IN ('FAILED', 'EXPIRED') AND "completedAt" IS NOT NULL
      AND length("errorCode") BETWEEN 1 AND 200)
  )
);

CREATE UNIQUE INDEX "WipeExecutionLease_one_claimed_batch_phase_key"
  ON "WipeExecutionLease" ("wipeBatchId", "phase") WHERE "status" = 'CLAIMED';
CREATE INDEX "WipeExecutionLease_batch_phase_status_idx"
  ON "WipeExecutionLease" ("wipeBatchId", "phase", "status");
CREATE INDEX "WipeExecutionLease_expiry_status_idx"
  ON "WipeExecutionLease" ("expiresAt", "status");

CREATE FUNCTION d05d_validate_execution_lease_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  batch_record "WipeBatch"%ROWTYPE;
  marker_record "WipeExecutionFixtureMarker"%ROWTYPE;
  latest_checkpoint "WipeBatchCheckpoint"%ROWTYPE;
  expected_attempt INTEGER;
BEGIN
  SELECT * INTO batch_record FROM "WipeBatch"
    WHERE "id" = NEW."wipeBatchId" AND "restaurantId" = NEW."restaurantId" FOR UPDATE;
  IF NOT FOUND OR batch_record."scopeHash" IS NULL OR batch_record."policyHash" IS NULL
     OR batch_record."dryRunManifestHash" IS NULL THEN
    RAISE EXCEPTION 'D05-D lease requires immutable batch authority';
  END IF;
  IF COALESCE(batch_record."scope"->>'environment', '') <> NEW."scopeEnvironment" THEN
    RAISE EXCEPTION 'D05-D lease environment must match immutable batch scope';
  END IF;
  SELECT * INTO marker_record FROM "WipeExecutionFixtureMarker"
    WHERE "singletonKey" = 'D05_DISPOSABLE_FIXTURE' FOR SHARE;
  IF NOT FOUND OR marker_record."environment" <> NEW."executorEnvironment"
     OR marker_record."fixtureNonceHash" <> NEW."databaseFixtureNonceHash" THEN
    RAISE EXCEPTION 'D05-D disposable fixture marker mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "RestaurantMembership"
    WHERE "playerId" = NEW."requestedByPlayerId" AND "restaurantId" = NEW."restaurantId"
      AND "role" = 'OWNER' AND "revokedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'D05-D lease requester must be an active OWNER';
  END IF;
  SELECT * INTO latest_checkpoint FROM "WipeBatchCheckpoint"
    WHERE "wipeBatchId" = NEW."wipeBatchId" ORDER BY "sequence" DESC LIMIT 1;
  IF NEW."phase" = 'CLEARED' THEN
    IF batch_record."lifecyclePhase" <> 'ISOLATED' OR batch_record."clearEligibleAt" IS NULL
       OR CURRENT_TIMESTAMP < batch_record."clearEligibleAt" THEN
      RAISE EXCEPTION 'D05-D clear lease is not DB-UTC eligible';
    END IF;
    IF latest_checkpoint."phase" = 'CLEARED' AND latest_checkpoint."outcome" = 'FAILED' THEN
      expected_attempt := latest_checkpoint."attempt" + 1;
    ELSIF latest_checkpoint."phase" = 'ISOLATED' AND latest_checkpoint."outcome" = 'SUCCEEDED' THEN
      expected_attempt := 1;
    ELSE
      RAISE EXCEPTION 'D05-D clear lease requires successful isolation or failed clear';
    END IF;
  ELSE
    IF batch_record."lifecyclePhase" <> 'CLEARED' THEN
      RAISE EXCEPTION 'D05-D verify lease requires CLEARED batch';
    END IF;
    IF latest_checkpoint."phase" = 'VERIFIED' AND latest_checkpoint."outcome" = 'FAILED' THEN
      expected_attempt := latest_checkpoint."attempt" + 1;
    ELSIF latest_checkpoint."phase" = 'CLEARED' AND latest_checkpoint."outcome" = 'SUCCEEDED' THEN
      expected_attempt := 1;
    ELSE
      RAISE EXCEPTION 'D05-D verify lease requires successful clear or failed verify';
    END IF;
  END IF;
  IF NEW."attempt" <> expected_attempt THEN
    RAISE EXCEPTION 'D05-D lease attempt must advance manually and exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION d05d_validate_execution_lease_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."wipeBatchId" IS DISTINCT FROM OLD."wipeBatchId"
     OR NEW."restaurantId" IS DISTINCT FROM OLD."restaurantId"
     OR NEW."phase" IS DISTINCT FROM OLD."phase"
     OR NEW."attempt" IS DISTINCT FROM OLD."attempt"
     OR NEW."requestedByPlayerId" IS DISTINCT FROM OLD."requestedByPlayerId"
     OR NEW."executorEnvironment" IS DISTINCT FROM OLD."executorEnvironment"
     OR NEW."scopeEnvironment" IS DISTINCT FROM OLD."scopeEnvironment"
     OR NEW."databaseFixtureNonceHash" IS DISTINCT FROM OLD."databaseFixtureNonceHash"
     OR NEW."authorityHash" IS DISTINCT FROM OLD."authorityHash"
     OR NEW."leaseTokenHash" IS DISTINCT FROM OLD."leaseTokenHash"
     OR NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'D05-D lease authority is immutable';
  END IF;
  IF OLD."status" <> 'CLAIMED' OR NEW."status" = 'CLAIMED' THEN
    RAISE EXCEPTION 'D05-D lease transition is terminal and forward-only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WipeExecutionLease_validate_insert"
  BEFORE INSERT ON "WipeExecutionLease"
  FOR EACH ROW EXECUTE FUNCTION d05d_validate_execution_lease_insert();
CREATE TRIGGER "WipeExecutionLease_validate_update"
  BEFORE UPDATE ON "WipeExecutionLease"
  FOR EACH ROW EXECUTE FUNCTION d05d_validate_execution_lease_update();

ALTER TABLE "WipeExecutionFixtureMarker" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WipeExecutionFixtureMarker" FORCE ROW LEVEL SECURITY;
ALTER TABLE "WipeExecutionLease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WipeExecutionLease" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "WipeExecutionFixtureMarker", "WipeExecutionLease" FROM PUBLIC;
GRANT SELECT ON TABLE "WipeExecutionFixtureMarker" TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE "WipeExecutionLease" TO service_role;
REVOKE ALL ON FUNCTION d05d_validate_execution_lease_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION d05d_validate_execution_lease_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION d05d_validate_execution_lease_insert() TO service_role;
GRANT EXECUTE ON FUNCTION d05d_validate_execution_lease_update() TO service_role;
