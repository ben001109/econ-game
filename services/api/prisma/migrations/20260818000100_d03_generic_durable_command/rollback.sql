-- D03 generic durable command rollback.
--
-- Restoring the former ledger-only shape is safe only while every outbox event
-- and job still has ledger provenance. Non-monetary durable history is never
-- deleted or fabricated; the rollback fails closed instead.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "OutboxEvent" WHERE "transactionId" IS NULL
  ) OR EXISTS (
    SELECT 1 FROM "SimulationJob" WHERE "sourceTransactionId" IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM "OutboxEvent" event
    LEFT JOIN "LedgerTransaction" ledger
      ON ledger."id" = event."transactionId"
     AND ledger."restaurantId" = event."restaurantId"
     AND ledger."saveId" = event."saveId"
    WHERE event."id" <> event."transactionId"
       OR event."eventSequence" <> 0
       OR ledger."commandId" IS DISTINCT FROM event."causationCommandId"
  ) THEN
    RAISE EXCEPTION 'D03 generic command rollback refused: non-monetary or multi-event durable history exists'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

DROP INDEX IF EXISTS "OutboxEvent_restaurantId_saveId_causationCommandId_idx";

ALTER TABLE "OutboxEvent"
  DROP CONSTRAINT "OutboxEvent_causationCommandId_eventSequence_key",
  DROP CONSTRAINT "OutboxEvent_identity_check",
  ALTER COLUMN "transactionId" SET NOT NULL,
  ADD CONSTRAINT "OutboxEvent_identity_check" CHECK ("id" = "transactionId"),
  DROP COLUMN "eventSequence",
  DROP COLUMN "causationCommandId";

ALTER TABLE "SimulationJob"
  ALTER COLUMN "sourceTransactionId" SET NOT NULL;

COMMIT;
