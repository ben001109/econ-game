-- D03-S-02 durable simulation jobs, per-save market ticks, and exact-version replay.
--
-- This hand-written migration extends D03-S-01 without changing earlier history.
-- Jobs remain at-least-once: leases coordinate workers but business identities and
-- immutable materializations provide the actual duplicate-safety boundary.

DO $$
BEGIN
  IF to_regclass('public."OutboxEvent"') IS NULL
     OR to_regclass('public."CompetitiveSave"') IS NULL THEN
    RAISE EXCEPTION 'D03-S-02 migration requires the D03-S-01 outbox baseline'
      USING ERRCODE = '0A000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'D03-S-02 migration requires Supabase service_role with BYPASSRLS'
      USING ERRCODE = '0A000';
  END IF;
END;
$$;

CREATE TYPE "SimulationArtifactKind" AS ENUM ('RULE', 'CATALOG');
CREATE TYPE "SimulationJobStatus" AS ENUM (
  'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER'
);
CREATE TYPE "SimulationJobErrorClass" AS ENUM ('TRANSIENT', 'PERMANENT');

CREATE TABLE "SimulationVersionArtifact" (
  "id" TEXT PRIMARY KEY,
  "artifactKind" "SimulationArtifactKind" NOT NULL,
  "artifactKey" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "processorId" TEXT,
  "payload" JSONB NOT NULL,
  "payloadHash" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SimulationVersionArtifact_kind_key_version_key"
    UNIQUE ("artifactKind", "artifactKey", "version"),
  CONSTRAINT "SimulationVersionArtifact_identity_check" CHECK (
    "id" = "artifactKind"::text || ':' || "artifactKey" || ':' || "version"
    AND "artifactKey" ~ '^[A-Z][A-Z0-9_.:-]{0,99}$'
    AND "version" ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
    AND ("processorId" IS NULL OR "processorId" ~ '^[A-Z][A-Z0-9_.:-]{0,99}$')
  ),
  CONSTRAINT "SimulationVersionArtifact_payload_check" CHECK (
    jsonb_typeof("payload") = 'object'
    AND "payloadHash" ~ '^[0-9a-f]{64}$'
    AND (
      ("artifactKind" = 'RULE' AND "processorId" IS NOT NULL)
      OR ("artifactKind" = 'CATALOG' AND "processorId" IS NULL)
    )
  )
);

CREATE INDEX "SimulationVersionArtifact_kind_key_createdAt_idx"
  ON "SimulationVersionArtifact" ("artifactKind", "artifactKey", "createdAt");

CREATE TABLE "SimulationJob" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "sourceEventId" TEXT NOT NULL,
  "sourceTransactionId" TEXT NOT NULL,
  "jobKind" TEXT NOT NULL,
  "businessKey" TEXT NOT NULL,
  "status" "SimulationJobStatus" NOT NULL DEFAULT 'PENDING',
  "inputPayload" JSONB NOT NULL,
  "inputHash" VARCHAR(64) NOT NULL,
  "resultPayload" JSONB,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMPTZ,
  "errorClass" "SimulationJobErrorClass",
  "errorCode" TEXT,
  "errorDetails" JSONB,
  "startedAt" TIMESTAMPTZ,
  "terminalAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SimulationJob_restaurantId_fkey" FOREIGN KEY ("restaurantId")
    REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SimulationJob_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId")
    REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SimulationJob_source_event_scope_fkey" FOREIGN KEY ("restaurantId", "sourceEventId")
    REFERENCES "OutboxEvent"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SimulationJob_source_transaction_scope_fkey" FOREIGN KEY ("restaurantId", "saveId", "sourceTransactionId")
    REFERENCES "LedgerTransaction"("restaurantId", "saveId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SimulationJob_restaurantId_id_key" UNIQUE ("restaurantId", "id"),
  CONSTRAINT "SimulationJob_source_business_key"
    UNIQUE ("sourceEventId", "jobKind", "businessKey"),
  CONSTRAINT "SimulationJob_identity_check" CHECK (
    "id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "jobKind" ~ '^[A-Z][A-Z0-9_.:-]{0,99}$'
    AND length("businessKey") BETWEEN 1 AND 300
    AND "inputHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "SimulationJob_attempt_check" CHECK (
    "attemptCount" BETWEEN 0 AND 5 AND "maxAttempts" = 5
  ),
  CONSTRAINT "SimulationJob_payload_check" CHECK (
    jsonb_typeof("inputPayload") = 'object'
    AND ("resultPayload" IS NULL OR jsonb_typeof("resultPayload") = 'object')
    AND ("errorDetails" IS NULL OR jsonb_typeof("errorDetails") = 'object')
  ),
  CONSTRAINT "SimulationJob_lease_state_check" CHECK (
    (
      "status" = 'RUNNING'
      AND "leaseOwner" IS NOT NULL
      AND "leaseToken" IS NOT NULL
      AND "leaseExpiresAt" IS NOT NULL
      AND "startedAt" IS NOT NULL
      AND "terminalAt" IS NULL
    ) OR (
      "status" <> 'RUNNING'
      AND "leaseOwner" IS NULL
      AND "leaseToken" IS NULL
      AND "leaseExpiresAt" IS NULL
    )
  ),
  CONSTRAINT "SimulationJob_terminal_state_check" CHECK (
    ("status" IN ('PENDING', 'RUNNING') AND "terminalAt" IS NULL AND "resultPayload" IS NULL)
    OR ("status" = 'SUCCEEDED' AND "terminalAt" IS NOT NULL AND "resultPayload" IS NOT NULL
        AND "errorClass" IS NULL AND "errorCode" IS NULL)
    OR ("status" IN ('FAILED', 'DEAD_LETTER') AND "terminalAt" IS NOT NULL
        AND "resultPayload" IS NULL AND "errorClass" IS NOT NULL AND "errorCode" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "SimulationJob_leaseToken_key"
  ON "SimulationJob" ("leaseToken") WHERE "leaseToken" IS NOT NULL;
CREATE INDEX "SimulationJob_claim_idx"
  ON "SimulationJob" ("status", "availableAt", "createdAt");
CREATE INDEX "SimulationJob_restaurantId_saveId_createdAt_idx"
  ON "SimulationJob" ("restaurantId", "saveId", "createdAt");
CREATE INDEX "SimulationJob_leaseExpiresAt_idx"
  ON "SimulationJob" ("leaseExpiresAt") WHERE "status" = 'RUNNING';

CREATE INDEX "OutboxEvent_simulation_dispatch_idx"
  ON "OutboxEvent" ("eventType", "eventVersion", "occurredAt", "id")
  WHERE "eventType" = 'simulation.versioned-replay.requested' AND "eventVersion" = 1;

CREATE TABLE "SimulationJobAudit" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "details" JSONB NOT NULL,
  "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SimulationJobAudit_restaurantId_fkey" FOREIGN KEY ("restaurantId")
    REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SimulationJobAudit_job_scope_fkey" FOREIGN KEY ("restaurantId", "jobId")
    REFERENCES "SimulationJob"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SimulationJobAudit_action_check" CHECK (
    "action" ~ '^[A-Z][A-Z0-9_]{0,63}$' AND "attempt" BETWEEN 0 AND 5
    AND jsonb_typeof("details") = 'object'
  )
);

CREATE INDEX "SimulationJobAudit_restaurantId_jobId_occurredAt_idx"
  ON "SimulationJobAudit" ("restaurantId", "jobId", "occurredAt");
CREATE INDEX "SimulationJobAudit_action_occurredAt_idx"
  ON "SimulationJobAudit" ("action", "occurredAt");

CREATE TABLE "VersionedReplayExecution" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL UNIQUE,
  "replayKind" TEXT NOT NULL,
  "businessDay" INTEGER,
  "ruleArtifactKey" TEXT NOT NULL,
  "ruleVersion" TEXT NOT NULL,
  "rulePayloadHash" VARCHAR(64) NOT NULL,
  "catalogSelections" JSONB NOT NULL,
  "replayPayload" JSONB NOT NULL,
  "replayInputHash" VARCHAR(64) NOT NULL,
  "resultPayload" JSONB NOT NULL,
  "resultHash" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VersionedReplayExecution_restaurantId_fkey" FOREIGN KEY ("restaurantId")
    REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "VersionedReplayExecution_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId")
    REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "VersionedReplayExecution_job_scope_fkey" FOREIGN KEY ("restaurantId", "jobId")
    REFERENCES "SimulationJob"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "VersionedReplayExecution_restaurantId_id_key" UNIQUE ("restaurantId", "id"),
  CONSTRAINT "VersionedReplayExecution_restaurantId_jobId_key" UNIQUE ("restaurantId", "jobId"),
  CONSTRAINT "VersionedReplayExecution_identity_check" CHECK (
    "id" = "jobId"
    AND "replayKind" ~ '^[A-Z][A-Z0-9_.:-]{0,99}$'
    AND ("businessDay" IS NULL OR "businessDay" > 0)
    AND "ruleArtifactKey" ~ '^[A-Z][A-Z0-9_.:-]{0,99}$'
    AND "ruleVersion" ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
  ),
  CONSTRAINT "VersionedReplayExecution_payload_check" CHECK (
    jsonb_typeof("catalogSelections") = 'array'
    AND jsonb_typeof("replayPayload") = 'object'
    AND jsonb_typeof("resultPayload") = 'object'
    AND "rulePayloadHash" ~ '^[0-9a-f]{64}$'
    AND "replayInputHash" ~ '^[0-9a-f]{64}$'
    AND "resultHash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX "VersionedReplayExecution_restaurant_save_kind_idx"
  ON "VersionedReplayExecution" ("restaurantId", "saveId", "replayKind", "createdAt");

CREATE TABLE "MarketTick" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "businessDay" INTEGER NOT NULL,
  "tickKind" TEXT NOT NULL,
  "materializedByJobId" TEXT NOT NULL,
  "replayExecutionId" TEXT NOT NULL,
  "marketSeed" TEXT NOT NULL,
  "ruleArtifactKey" TEXT NOT NULL,
  "simulationRuleVersion" TEXT NOT NULL,
  "rulePayloadHash" VARCHAR(64) NOT NULL,
  "catalogArtifactKey" TEXT NOT NULL,
  "catalogRevision" TEXT NOT NULL,
  "catalogPayloadHash" VARCHAR(64) NOT NULL,
  "prngCursor" INTEGER NOT NULL,
  "inputPayload" JSONB NOT NULL,
  "outputPayload" JSONB NOT NULL,
  "outputHash" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketTick_restaurantId_fkey" FOREIGN KEY ("restaurantId")
    REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MarketTick_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId")
    REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MarketTick_job_scope_fkey" FOREIGN KEY ("restaurantId", "materializedByJobId")
    REFERENCES "SimulationJob"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MarketTick_replay_scope_fkey" FOREIGN KEY ("restaurantId", "replayExecutionId")
    REFERENCES "VersionedReplayExecution"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MarketTick_save_day_kind_key" UNIQUE ("saveId", "businessDay", "tickKind"),
  CONSTRAINT "MarketTick_identity_check" CHECK (
    "id" = "saveId" || ':' || "businessDay"::text || ':' || "tickKind"
    AND "businessDay" > 0
    AND "tickKind" ~ '^[A-Z][A-Z0-9_.:-]{0,99}$'
    AND "prngCursor" >= 0
    AND length("marketSeed") BETWEEN 1 AND 300
  ),
  CONSTRAINT "MarketTick_version_payload_check" CHECK (
    "ruleArtifactKey" ~ '^[A-Z][A-Z0-9_.:-]{0,99}$'
    AND "catalogArtifactKey" ~ '^[A-Z][A-Z0-9_.:-]{0,99}$'
    AND "simulationRuleVersion" ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
    AND "catalogRevision" ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
    AND "rulePayloadHash" ~ '^[0-9a-f]{64}$'
    AND "catalogPayloadHash" ~ '^[0-9a-f]{64}$'
    AND "outputHash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("inputPayload") = 'object'
    AND jsonb_typeof("outputPayload") = 'object'
  )
);

CREATE INDEX "MarketTick_restaurant_save_day_idx"
  ON "MarketTick" ("restaurantId", "saveId", "businessDay");
CREATE INDEX "MarketTick_materializedByJobId_idx"
  ON "MarketTick" ("materializedByJobId");

CREATE FUNCTION d03_reject_simulation_history_mutation() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'D03 simulation history is append-only: %.%', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION d03_reject_simulation_job_delete() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'D03 simulation jobs are durable history and cannot be deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "SimulationJob_no_delete"
  BEFORE DELETE ON "SimulationJob"
  FOR EACH ROW EXECUTE FUNCTION d03_reject_simulation_job_delete();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'SimulationVersionArtifact', 'SimulationJobAudit',
    'VersionedReplayExecution', 'MarketTick'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION d03_reject_simulation_history_mutation()',
      table_name || '_append_only', table_name
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'SimulationVersionArtifact', 'SimulationJob', 'SimulationJobAudit',
    'VersionedReplayExecution', 'MarketTick'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', table_name);
  END LOOP;

END;
$$;

GRANT SELECT, INSERT ON TABLE "SimulationVersionArtifact" TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE "SimulationJob" TO service_role;
GRANT SELECT, INSERT ON TABLE "SimulationJobAudit" TO service_role;
GRANT SELECT, INSERT ON TABLE "VersionedReplayExecution" TO service_role;
GRANT SELECT, INSERT ON TABLE "MarketTick" TO service_role;

CREATE FUNCTION d03_claim_simulation_job(
  target_worker_id TEXT,
  target_lease_token TEXT,
  target_lease_seconds INTEGER
) RETURNS TABLE (
  "id" TEXT,
  "restaurantId" TEXT,
  "saveId" TEXT,
  "sourceEventId" TEXT,
  "sourceTransactionId" TEXT,
  "jobKind" TEXT,
  "businessKey" TEXT,
  "inputPayload" JSONB,
  "inputHash" VARCHAR(64),
  "attemptCount" INTEGER,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  selected_job "SimulationJob"%ROWTYPE;
  was_reclaimed BOOLEAN;
BEGIN
  IF target_worker_id !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,99}$'
     OR target_lease_token !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR target_lease_seconds NOT BETWEEN 5 AND 900 THEN
    RAISE EXCEPTION 'invalid D03 simulation lease request' USING ERRCODE = '22023';
  END IF;

  SELECT job.* INTO selected_job
  FROM "SimulationJob" job
  WHERE job."status" = 'RUNNING'
    AND job."attemptCount" >= job."maxAttempts"
    AND job."leaseExpiresAt" <= CURRENT_TIMESTAMP
  ORDER BY job."leaseExpiresAt", job."createdAt", job."id"
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF FOUND THEN
    UPDATE "SimulationJob"
    SET "status" = 'DEAD_LETTER',
        "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
        "errorClass" = 'TRANSIENT', "errorCode" = 'WORKER_LEASE_EXPIRED',
        "errorDetails" = jsonb_build_object('category', 'infrastructure'),
        "terminalAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = selected_job."id";
    INSERT INTO "SimulationJobAudit" (
      "id", "restaurantId", "jobId", "action", "attempt", "details"
    ) VALUES (
      selected_job."id" || ':dead:' || selected_job."attemptCount"::text,
      selected_job."restaurantId", selected_job."id", 'DEAD_LETTERED',
      selected_job."attemptCount",
      jsonb_build_object('errorClass', 'TRANSIENT', 'errorCode', 'WORKER_LEASE_EXPIRED',
                         'sourceEventId', selected_job."sourceEventId",
                         'sourceTransactionId', selected_job."sourceTransactionId")
    );
    RETURN;
  END IF;

  SELECT job.* INTO selected_job
  FROM "SimulationJob" job
  WHERE job."attemptCount" < job."maxAttempts"
    AND (
      (job."status" = 'PENDING' AND job."availableAt" <= CURRENT_TIMESTAMP)
      OR (job."status" = 'RUNNING' AND job."leaseExpiresAt" <= CURRENT_TIMESTAMP)
    )
  ORDER BY job."availableAt", job."createdAt", job."id"
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  was_reclaimed := selected_job."status" = 'RUNNING';
  UPDATE "SimulationJob" job
  SET "status" = 'RUNNING',
      "attemptCount" = selected_job."attemptCount" + 1,
      "leaseOwner" = target_worker_id,
      "leaseToken" = target_lease_token,
      "leaseExpiresAt" = CURRENT_TIMESTAMP + make_interval(secs => target_lease_seconds),
      "startedAt" = COALESCE(job."startedAt", CURRENT_TIMESTAMP),
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE job."id" = selected_job."id"
  RETURNING job.* INTO selected_job;

  INSERT INTO "SimulationJobAudit" (
    "id", "restaurantId", "jobId", "action", "attempt", "details"
  ) VALUES (
    selected_job."id" || ':claim:' || selected_job."attemptCount"::text,
    selected_job."restaurantId", selected_job."id",
    CASE WHEN was_reclaimed THEN 'LEASE_RECLAIMED' ELSE 'LEASE_CLAIMED' END,
    selected_job."attemptCount",
    jsonb_build_object('workerId', target_worker_id, 'leaseToken', target_lease_token)
  );

  RETURN QUERY SELECT
    selected_job."id", selected_job."restaurantId", selected_job."saveId",
    selected_job."sourceEventId", selected_job."sourceTransactionId",
    selected_job."jobKind", selected_job."businessKey",
    selected_job."inputPayload", selected_job."inputHash", selected_job."attemptCount",
    selected_job."leaseToken", selected_job."leaseExpiresAt";
END;
$$;

CREATE FUNCTION d03_renew_simulation_job_lease(
  target_job_id TEXT,
  target_lease_token TEXT,
  target_lease_seconds INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  renewed_count INTEGER;
BEGIN
  IF target_lease_seconds NOT BETWEEN 5 AND 900 THEN
    RAISE EXCEPTION 'invalid D03 simulation lease duration' USING ERRCODE = '22023';
  END IF;
  UPDATE "SimulationJob"
  SET "leaseExpiresAt" = CURRENT_TIMESTAMP + make_interval(secs => target_lease_seconds),
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = target_job_id
    AND "status" = 'RUNNING'
    AND "leaseToken" = target_lease_token
    AND "leaseExpiresAt" > CURRENT_TIMESTAMP;
  GET DIAGNOSTICS renewed_count = ROW_COUNT;
  RETURN renewed_count = 1;
END;
$$;

CREATE FUNCTION d03_record_simulation_job_failure(
  target_job_id TEXT,
  target_lease_token TEXT,
  target_error_class "SimulationJobErrorClass",
  target_error_code TEXT,
  target_error_details JSONB
) RETURNS "SimulationJobStatus"
LANGUAGE plpgsql
AS $$
DECLARE
  selected_job "SimulationJob"%ROWTYPE;
  next_status "SimulationJobStatus";
  retry_seconds INTEGER;
BEGIN
  IF target_error_code !~ '^[A-Z][A-Z0-9_]{0,99}$'
     OR jsonb_typeof(target_error_details) <> 'object' THEN
    RAISE EXCEPTION 'invalid D03 simulation error record' USING ERRCODE = '22023';
  END IF;

  SELECT job.* INTO selected_job
  FROM "SimulationJob" job
  WHERE job."id" = target_job_id
    AND job."status" = 'RUNNING'
    AND job."leaseToken" = target_lease_token
    AND job."leaseExpiresAt" > CURRENT_TIMESTAMP
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'D03 simulation lease ownership was lost' USING ERRCODE = '55000';
  END IF;

  IF target_error_class = 'TRANSIENT' AND selected_job."attemptCount" < selected_job."maxAttempts" THEN
    next_status := 'PENDING';
    retry_seconds := LEAST(300, power(2, GREATEST(selected_job."attemptCount" - 1, 0))::integer);
    UPDATE "SimulationJob"
    SET "status" = next_status,
        "availableAt" = CURRENT_TIMESTAMP + make_interval(secs => retry_seconds),
        "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
        "errorClass" = target_error_class, "errorCode" = target_error_code,
        "errorDetails" = target_error_details, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = selected_job."id";
    INSERT INTO "SimulationJobAudit" (
      "id", "restaurantId", "jobId", "action", "attempt", "details"
    ) VALUES (
      selected_job."id" || ':retry:' || selected_job."attemptCount"::text,
      selected_job."restaurantId", selected_job."id", 'RETRY_SCHEDULED',
      selected_job."attemptCount",
      jsonb_build_object('errorClass', target_error_class, 'errorCode', target_error_code,
                         'retryAfterSeconds', retry_seconds, 'details', target_error_details)
    );
  ELSE
    next_status := CASE
      WHEN target_error_class = 'TRANSIENT' THEN 'DEAD_LETTER'::"SimulationJobStatus"
      ELSE 'FAILED'::"SimulationJobStatus"
    END;
    UPDATE "SimulationJob"
    SET "status" = next_status,
        "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
        "errorClass" = target_error_class, "errorCode" = target_error_code,
        "errorDetails" = target_error_details, "terminalAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = selected_job."id";
    INSERT INTO "SimulationJobAudit" (
      "id", "restaurantId", "jobId", "action", "attempt", "details"
    ) VALUES (
      selected_job."id" || CASE WHEN next_status = 'DEAD_LETTER' THEN ':dead:' ELSE ':failed:' END
        || selected_job."attemptCount"::text,
      selected_job."restaurantId", selected_job."id",
      CASE WHEN next_status = 'DEAD_LETTER' THEN 'DEAD_LETTERED' ELSE 'FAILED' END,
      selected_job."attemptCount",
      jsonb_build_object('errorClass', target_error_class, 'errorCode', target_error_code,
                         'details', target_error_details,
                         'sourceEventId', selected_job."sourceEventId",
                         'sourceTransactionId', selected_job."sourceTransactionId")
    );
  END IF;
  RETURN next_status;
END;
$$;

CREATE FUNCTION d03_complete_simulation_job(
  target_job_id TEXT,
  target_lease_token TEXT,
  target_result JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  completed_job "SimulationJob"%ROWTYPE;
BEGIN
  IF jsonb_typeof(target_result) <> 'object' THEN
    RAISE EXCEPTION 'D03 simulation result must be an object' USING ERRCODE = '22023';
  END IF;
  UPDATE "SimulationJob" job
  SET "status" = 'SUCCEEDED', "resultPayload" = target_result,
      "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
      "errorClass" = NULL, "errorCode" = NULL, "errorDetails" = NULL,
      "terminalAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
  WHERE job."id" = target_job_id
    AND job."status" = 'RUNNING'
    AND job."leaseToken" = target_lease_token
    AND job."leaseExpiresAt" > CURRENT_TIMESTAMP
  RETURNING job.* INTO completed_job;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  INSERT INTO "SimulationJobAudit" (
    "id", "restaurantId", "jobId", "action", "attempt", "details"
  ) VALUES (
    completed_job."id" || ':succeeded:' || completed_job."attemptCount"::text,
    completed_job."restaurantId", completed_job."id", 'SUCCEEDED',
    completed_job."attemptCount", jsonb_build_object('resultHash', target_result->>'resultHash')
  );
  RETURN TRUE;
END;
$$;

CREATE FUNCTION d03_assert_market_tick_materialized(
  target_restaurant_id TEXT,
  target_save_id TEXT,
  target_business_day INTEGER,
  target_tick_kind TEXT
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "MarketTick" tick
    WHERE tick."restaurantId" = target_restaurant_id
      AND tick."saveId" = target_save_id
      AND tick."businessDay" = target_business_day
      AND tick."tickKind" = target_tick_kind
  ) THEN
    RAISE EXCEPTION 'required per-save market tick is not materialized'
      USING ERRCODE = '23514', CONSTRAINT = 'MarketTick_required_before_open';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION d03_claim_simulation_job(TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION d03_renew_simulation_job_lease(TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION d03_record_simulation_job_failure(TEXT, TEXT, "SimulationJobErrorClass", TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION d03_complete_simulation_job(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION d03_assert_market_tick_materialized(TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION d03_claim_simulation_job(TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION d03_renew_simulation_job_lease(TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION d03_record_simulation_job_failure(TEXT, TEXT, "SimulationJobErrorClass", TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION d03_complete_simulation_job(TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION d03_assert_market_tick_materialized(TEXT, TEXT, INTEGER, TEXT) TO service_role;
