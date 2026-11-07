-- D03 generic durable command causation.
--
-- This migration separates command/outbox provenance from the optional money
-- ledger while preserving every existing ledger-backed event and service-only
-- RLS/grant boundary. It intentionally creates no client grant or policy.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public."OutboxEvent"') IS NULL
     OR to_regclass('public."LedgerTransaction"') IS NULL
     OR to_regclass('public."SimulationJob"') IS NULL THEN
    RAISE EXCEPTION 'D03 generic command migration requires ledger, outbox, and simulation baselines'
      USING ERRCODE = '0A000';
  END IF;
END;
$$;

-- The history trigger must not reinterpret this one-time provenance backfill
-- as an application mutation. It is re-enabled before the transaction commits.
ALTER TABLE "OutboxEvent" DISABLE TRIGGER "OutboxEvent_append_only";

ALTER TABLE "OutboxEvent"
  ADD COLUMN "causationCommandId" TEXT,
  ADD COLUMN "eventSequence" INTEGER NOT NULL DEFAULT 0;

UPDATE "OutboxEvent" event
SET "causationCommandId" = ledger."commandId"
FROM "LedgerTransaction" ledger
WHERE ledger."id" = event."transactionId"
  AND ledger."restaurantId" = event."restaurantId"
  AND ledger."saveId" = event."saveId";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "OutboxEvent" WHERE "causationCommandId" IS NULL
  ) THEN
    RAISE EXCEPTION 'D03 causation backfill left an outbox event without a command'
      USING ERRCODE = '23502';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "OutboxEvent"
    GROUP BY "causationCommandId", "eventSequence"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'D03 causation backfill produced duplicate command event sequences'
      USING ERRCODE = '23505';
  END IF;
END;
$$;

ALTER TABLE "OutboxEvent"
  ALTER COLUMN "causationCommandId" SET NOT NULL,
  ALTER COLUMN "transactionId" DROP NOT NULL,
  DROP CONSTRAINT "OutboxEvent_identity_check",
  ADD CONSTRAINT "OutboxEvent_identity_check" CHECK (
    "id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "causationCommandId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "eventSequence" >= 0
    AND ("transactionId" IS NULL OR "transactionId" = "causationCommandId")
  ),
  ADD CONSTRAINT "OutboxEvent_causationCommandId_eventSequence_key"
    UNIQUE ("causationCommandId", "eventSequence");

CREATE INDEX "OutboxEvent_restaurantId_saveId_causationCommandId_idx"
  ON "OutboxEvent" ("restaurantId", "saveId", "causationCommandId");

ALTER TABLE "SimulationJob"
  ALTER COLUMN "sourceTransactionId" DROP NOT NULL;

ALTER TABLE "OutboxEvent" ENABLE TRIGGER "OutboxEvent_append_only";

COMMIT;
