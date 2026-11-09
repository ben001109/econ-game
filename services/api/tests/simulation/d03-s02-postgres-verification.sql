\set ON_ERROR_STOP on

DO $$
DECLARE
  dispatch_receipt_count INTEGER;
  retry_audit_count INTEGER;
  reclaimed_count INTEGER;
  tick_count INTEGER;
BEGIN
  SELECT count(*) INTO dispatch_receipt_count
  FROM "OutboxConsumerReceipt"
  WHERE "consumerName" = 'simulation.dispatch.v1';
  IF dispatch_receipt_count <> 7 OR EXISTS (
    SELECT 1
    FROM "OutboxConsumerReceipt" receipt
    LEFT JOIN "SimulationJob" job ON job."sourceEventId" = receipt."eventId"
    LEFT JOIN "OutboxConsumerDeadLetter" dead_letter
      ON dead_letter."eventId" = receipt."eventId"
     AND dead_letter."consumerName" = receipt."consumerName"
    WHERE receipt."consumerName" = 'simulation.dispatch.v1'
      AND ((job."id" IS NULL) = (dead_letter."id" IS NULL))
  ) THEN
    RAISE EXCEPTION 'source receipt is not atomically paired with exactly one job or dead letter';
  END IF;

  IF (SELECT count(*) FROM "OutboxConsumerDeadLetter") <> 2
     OR NOT EXISTS (
       SELECT 1 FROM "OutboxConsumerDeadLetter"
       WHERE "eventId" = '10000000-0000-4000-8000-000000000006'
         AND "errorCode" = 'OUTBOX_EVENT_UNSUPPORTED'
     )
     OR NOT EXISTS (
       SELECT 1 FROM "OutboxConsumerDeadLetter"
       WHERE "eventId" = '10000000-0000-4000-8000-000000000007'
         AND "errorCode" = 'OUTBOX_REPLAY_REQUEST_INVALID'
     ) THEN
    RAISE EXCEPTION 'poison outbox isolation evidence is incomplete';
  END IF;

  SELECT count(*) INTO tick_count
  FROM "MarketTick"
  WHERE "saveId" = 'save-a' AND "businessDay" = 2 AND "tickKind" = 'SUPPLY_PRICE';
  IF tick_count <> 1 THEN
    RAISE EXCEPTION 'market tick business identity is not unique: %', tick_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "VersionedReplayExecution"
    WHERE "jobId" = '20000000-0000-4000-8000-000000000001'
      AND "ruleVersion" = 'market-rule/v1'
      AND "catalogSelections" @> '[{"kind":"CATALOG","key":"INGREDIENT_PRICE","version":"ingredient-catalog/v1"}]'::jsonb
  ) THEN
    RAISE EXCEPTION 'historical rule/catalog replay evidence is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "SimulationJob"
    WHERE "id" = '20000000-0000-4000-8000-000000000003'
      AND "status" = 'FAILED' AND "attemptCount" = 1
      AND "errorClass" = 'PERMANENT' AND "errorCode" = 'REPLAY_VERSION_MISSING'
  ) THEN
    RAISE EXCEPTION 'missing historical version did not fail closed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "SimulationJob"
    WHERE "id" = '20000000-0000-4000-8000-000000000005'
      AND "status" = 'DEAD_LETTER' AND "attemptCount" = 5
      AND "errorClass" = 'TRANSIENT'
  ) THEN
    RAISE EXCEPTION 'fifth transient failure did not dead-letter';
  END IF;

  SELECT count(*) INTO retry_audit_count
  FROM "SimulationJobAudit"
  WHERE "jobId" = '20000000-0000-4000-8000-000000000005'
    AND "action" = 'RETRY_SCHEDULED';
  IF retry_audit_count <> 4 OR NOT EXISTS (
    SELECT 1 FROM "SimulationJobAudit"
    WHERE "jobId" = '20000000-0000-4000-8000-000000000005'
      AND "action" = 'DEAD_LETTERED'
      AND "details"->>'sourceEventId' = '10000000-0000-4000-8000-000000000005'
      AND "details"->>'sourceTransactionId' = '10000000-0000-4000-8000-000000000005'
  ) THEN
    RAISE EXCEPTION 'retry/DLQ immutable audit evidence is incomplete';
  END IF;

  SELECT count(*) INTO reclaimed_count
  FROM "SimulationJobAudit"
  WHERE "jobId" = '20000000-0000-4000-8000-000000000004'
    AND "action" = 'LEASE_RECLAIMED' AND "attempt" = 2;
  IF reclaimed_count <> 1 THEN
    RAISE EXCEPTION 'expired lease was not audibly reclaimed';
  END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    UPDATE "SimulationVersionArtifact" SET "version" = 'mutated'
    WHERE "id" = 'RULE:MARKET_PRICE:market-rule/v1';
    RAISE EXCEPTION 'version artifact update unexpectedly succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;

  BEGIN
    DELETE FROM "MarketTick" WHERE "id" = 'save-a:2:SUPPLY_PRICE';
    RAISE EXCEPTION 'market tick deletion unexpectedly succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;

  BEGIN
    UPDATE "OutboxConsumerDeadLetter" SET "errorCode" = 'MUTATED'
    WHERE "eventId" = '10000000-0000-4000-8000-000000000006';
    RAISE EXCEPTION 'dead-letter audit update unexpectedly succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "SimulationJob" (
      "id", "restaurantId", "saveId", "sourceEventId", "sourceTransactionId",
      "jobKind", "businessKey", "inputPayload", "inputHash"
    ) VALUES (
      '29999999-9999-4999-8999-999999999999', 'restaurant-b', 'save-a',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      'MARKET_TICK', 'cross-tenant', '{}'::jsonb, repeat('a', 64)
    );
    RAISE EXCEPTION 'cross-tenant simulation job unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END;
$$;

SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM "SimulationJob";
    RAISE EXCEPTION 'authenticated client unexpectedly read simulation jobs';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM * FROM "OutboxConsumerDeadLetter";
    RAISE EXCEPTION 'authenticated client unexpectedly read outbox dead letters';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM d03_claim_simulation_job(
      'client.worker', '30000000-0000-4000-8000-000000000001', 60
    );
    RAISE EXCEPTION 'authenticated client unexpectedly claimed a simulation job';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
RESET ROLE;

\ir ../../prisma/migrations/20260818000100_d03_generic_durable_command/rollback.sql
\ir ../../prisma/migrations/20260816000100_b2_outbox_dead_letter/rollback.sql

DO $$
BEGIN
  IF to_regclass('public."OutboxConsumerDeadLetter"') IS NOT NULL
     OR to_regclass('public."OutboxEvent"') IS NULL
     OR to_regclass('public."SimulationJob"') IS NULL THEN
    RAISE EXCEPTION 'B2 rollback damaged its D03 prerequisites or left artifacts behind';
  END IF;
END;
$$;

\ir ../../prisma/migrations/20260814000500_d03_durable_simulation/rollback.sql

DO $$
BEGIN
  IF to_regclass('public."SimulationJob"') IS NOT NULL
     OR to_regclass('public."MarketTick"') IS NOT NULL
     OR to_regprocedure('public.d03_claim_simulation_job(text,text,integer)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SimulationJobStatus') THEN
    RAISE EXCEPTION 'D03-S-02 rollback left durable simulation artifacts behind';
  END IF;
  IF to_regclass('public."LedgerTransaction"') IS NULL
     OR to_regclass('public."OutboxEvent"') IS NULL
     OR to_regprocedure('public.d03_consume_outbox_event(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'D03-S-02 rollback damaged earlier D03-S-01 history';
  END IF;
END;
$$;

\ir ../../prisma/migrations/20260814000400_d03_ledger_outbox/rollback.sql
\ir ../../prisma/migrations/20260814000300_d05_closed_beta_entry/rollback.sql
\ir ../../prisma/migrations/20260814000200_d04_discord_link_challenge/rollback.sql
\ir ../../prisma/migrations/20260814000100_d01_p0_persistence/rollback.sql
