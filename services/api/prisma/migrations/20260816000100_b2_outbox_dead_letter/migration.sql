-- Security B2: durable, auditable isolation for malformed simulation outbox events.
-- The consumer receipt and dead-letter row are written by one worker transaction.

DO $$
BEGIN
  IF to_regclass('public."OutboxEvent"') IS NULL
     OR to_regclass('public."OutboxConsumerReceipt"') IS NULL
     OR to_regprocedure('public.d03_reject_simulation_history_mutation()') IS NULL THEN
    RAISE EXCEPTION 'B2 outbox dead-letter migration requires the D03 simulation baseline'
      USING ERRCODE = '0A000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'B2 outbox dead-letter migration requires service_role with BYPASSRLS'
      USING ERRCODE = '0A000';
  END IF;
END;
$$;

CREATE TABLE "OutboxConsumerDeadLetter" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "consumerName" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "eventVersion" INTEGER NOT NULL,
  "errorCode" TEXT NOT NULL,
  "errorDetails" JSONB NOT NULL,
  "failedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OutboxConsumerDeadLetter_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OutboxConsumerDeadLetter_event_scope_fkey"
    FOREIGN KEY ("restaurantId", "eventId") REFERENCES "OutboxEvent"("restaurantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OutboxConsumerDeadLetter_eventId_consumerName_key"
    UNIQUE ("eventId", "consumerName"),
  CONSTRAINT "OutboxConsumerDeadLetter_identity_check" CHECK (
    "id" = "eventId" || ':' || "consumerName"
    AND "consumerName" ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,99}$'
    AND "eventType" ~ '^[a-z][a-z0-9_.-]{1,99}$'
    AND "eventVersion" > 0
    AND "errorCode" ~ '^[A-Z][A-Z0-9_]{0,99}$'
    AND jsonb_typeof("errorDetails") = 'object'
  )
);

CREATE INDEX "OutboxConsumerDeadLetter_restaurant_consumer_failed_idx"
  ON "OutboxConsumerDeadLetter" ("restaurantId", "consumerName", "failedAt");
CREATE INDEX "OutboxConsumerDeadLetter_error_failed_idx"
  ON "OutboxConsumerDeadLetter" ("errorCode", "failedAt");
CREATE INDEX "OutboxEvent_simulation_consumer_idx"
  ON "OutboxEvent" ("occurredAt", "id")
  WHERE "eventType" LIKE 'simulation.%';

CREATE TRIGGER "OutboxConsumerDeadLetter_append_only"
  BEFORE UPDATE OR DELETE ON "OutboxConsumerDeadLetter"
  FOR EACH ROW EXECUTE FUNCTION d03_reject_simulation_history_mutation();

ALTER TABLE "OutboxConsumerDeadLetter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutboxConsumerDeadLetter" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "OutboxConsumerDeadLetter" FROM PUBLIC;
REVOKE ALL ON TABLE "OutboxConsumerDeadLetter" FROM anon;
REVOKE ALL ON TABLE "OutboxConsumerDeadLetter" FROM authenticated;
GRANT SELECT, INSERT ON TABLE "OutboxConsumerDeadLetter" TO service_role;
