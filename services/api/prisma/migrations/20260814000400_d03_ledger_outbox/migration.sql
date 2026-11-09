-- D03-S-01 append-only double-entry ledger and transactional outbox.
--
-- This migration is intentionally hand-written. It extends the D01/D02/D04
-- trust boundary without changing earlier migrations. Core economic tables
-- have no client policies or grants; only Supabase service_role may use them.

DO $$
BEGIN
  IF to_regclass('public."CompetitiveSave"') IS NULL
     OR to_regclass('public."IdempotencyRecord"') IS NULL THEN
    RAISE EXCEPTION 'D03 migration requires the D01 persistence baseline'
      USING ERRCODE = '0A000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'D03 migration requires Supabase service_role with BYPASSRLS'
      USING ERRCODE = '0A000';
  END IF;
END;
$$;

CREATE TYPE "LedgerTransactionKind" AS ENUM ('POSTING', 'COMPENSATION');
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

CREATE TABLE "LedgerTransaction" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "commandId" TEXT NOT NULL UNIQUE,
  "actorPlayerId" TEXT NOT NULL,
  "kind" "LedgerTransactionKind" NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "reversesTransactionId" TEXT UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerTransaction_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "LedgerTransaction_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId") REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "LedgerTransaction_actorPlayerId_fkey" FOREIGN KEY ("actorPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "LedgerTransaction_reversal_scope_fkey" FOREIGN KEY ("restaurantId", "saveId", "reversesTransactionId") REFERENCES "LedgerTransaction"("restaurantId", "saveId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "LedgerTransaction_restaurantId_saveId_id_key" UNIQUE ("restaurantId", "saveId", "id"),
  CONSTRAINT "LedgerTransaction_restaurantId_saveId_reversesTransactionId_key" UNIQUE ("restaurantId", "saveId", "reversesTransactionId"),
  CONSTRAINT "LedgerTransaction_identity_check" CHECK (
    "id" = "commandId"
    AND "id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "LedgerTransaction_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "LedgerTransaction_reason_check" CHECK (length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "LedgerTransaction_kind_reference_check" CHECK (
    ("kind" = 'POSTING' AND "reversesTransactionId" IS NULL)
    OR ("kind" = 'COMPENSATION' AND "reversesTransactionId" IS NOT NULL AND "reversesTransactionId" <> "id")
  )
);

CREATE INDEX "LedgerTransaction_restaurantId_saveId_createdAt_idx"
  ON "LedgerTransaction" ("restaurantId", "saveId", "createdAt");
CREATE INDEX "LedgerTransaction_actorPlayerId_createdAt_idx"
  ON "LedgerTransaction" ("actorPlayerId", "createdAt");

CREATE TABLE "LedgerLine" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "accountCode" TEXT NOT NULL,
  "direction" "LedgerDirection" NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerLine_transaction_scope_fkey" FOREIGN KEY ("restaurantId", "saveId", "transactionId") REFERENCES "LedgerTransaction"("restaurantId", "saveId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "LedgerLine_transactionId_sequence_key" UNIQUE ("transactionId", "sequence"),
  CONSTRAINT "LedgerLine_sequence_check" CHECK ("sequence" >= 0),
  CONSTRAINT "LedgerLine_accountCode_check" CHECK ("accountCode" ~ '^[A-Z][A-Z0-9_:-]{0,99}$'),
  CONSTRAINT "LedgerLine_amountMinor_check" CHECK ("amountMinor" > 0)
);

CREATE INDEX "LedgerLine_restaurantId_saveId_accountCode_createdAt_idx"
  ON "LedgerLine" ("restaurantId", "saveId", "accountCode", "createdAt");

CREATE TABLE "OutboxEvent" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL UNIQUE,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "aggregateVersion" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "eventVersion" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OutboxEvent_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OutboxEvent_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId") REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OutboxEvent_transaction_scope_fkey" FOREIGN KEY ("restaurantId", "saveId", "transactionId") REFERENCES "LedgerTransaction"("restaurantId", "saveId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OutboxEvent_restaurantId_id_key" UNIQUE ("restaurantId", "id"),
  CONSTRAINT "OutboxEvent_restaurantId_saveId_transactionId_key" UNIQUE ("restaurantId", "saveId", "transactionId"),
  CONSTRAINT "OutboxEvent_identity_check" CHECK ("id" = "transactionId"),
  CONSTRAINT "OutboxEvent_aggregate_check" CHECK (
    "aggregateType" = 'CompetitiveSave'
    AND "aggregateId" = "saveId"
    AND "aggregateVersion" > 0
  ),
  CONSTRAINT "OutboxEvent_type_check" CHECK ("eventType" ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  CONSTRAINT "OutboxEvent_version_payload_check" CHECK (
    "eventVersion" > 0 AND jsonb_typeof("payload") = 'object'
  )
);

CREATE INDEX "OutboxEvent_restaurantId_saveId_occurredAt_idx"
  ON "OutboxEvent" ("restaurantId", "saveId", "occurredAt");

CREATE TABLE "OutboxConsumerReceipt" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "consumerName" TEXT NOT NULL,
  "processedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OutboxConsumerReceipt_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OutboxConsumerReceipt_event_scope_fkey" FOREIGN KEY ("restaurantId", "eventId") REFERENCES "OutboxEvent"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OutboxConsumerReceipt_eventId_consumerName_key" UNIQUE ("eventId", "consumerName"),
  CONSTRAINT "OutboxConsumerReceipt_consumerName_check" CHECK ("consumerName" ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,99}$')
);

CREATE INDEX "OutboxConsumerReceipt_restaurantId_consumerName_processedAt_idx"
  ON "OutboxConsumerReceipt" ("restaurantId", "consumerName", "processedAt");

CREATE FUNCTION d03_reject_economic_history_mutation() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'D03 economic history is append-only: %.%', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION d03_validate_ledger_transaction(target_transaction_id TEXT) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  transaction_row "LedgerTransaction"%ROWTYPE;
  line_count INTEGER;
  debit_total NUMERIC;
  credit_total NUMERIC;
BEGIN
  SELECT * INTO transaction_row
  FROM "LedgerTransaction"
  WHERE "id" = target_transaction_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*),
         COALESCE(sum("amountMinor") FILTER (WHERE "direction" = 'DEBIT'), 0),
         COALESCE(sum("amountMinor") FILTER (WHERE "direction" = 'CREDIT'), 0)
    INTO line_count, debit_total, credit_total
  FROM "LedgerLine"
  WHERE "transactionId" = target_transaction_id;

  IF line_count < 2 OR debit_total <= 0 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'D03 ledger transaction % is not balanced', target_transaction_id
      USING ERRCODE = '23514', CONSTRAINT = 'LedgerTransaction_balanced';
  END IF;

  IF transaction_row."kind" = 'COMPENSATION' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "LedgerTransaction" original
      WHERE original."id" = transaction_row."reversesTransactionId"
        AND original."restaurantId" = transaction_row."restaurantId"
        AND original."saveId" = transaction_row."saveId"
        AND original."currency" = transaction_row."currency"
    ) THEN
      RAISE EXCEPTION 'D03 compensation % has an invalid source', target_transaction_id
        USING ERRCODE = '23514', CONSTRAINT = 'LedgerTransaction_compensation_source';
    END IF;

    IF EXISTS (
      WITH original AS (
        SELECT "accountCode", "direction", sum("amountMinor") AS amount
        FROM "LedgerLine"
        WHERE "transactionId" = transaction_row."reversesTransactionId"
        GROUP BY "accountCode", "direction"
      ), reversal AS (
        SELECT "accountCode", "direction", sum("amountMinor") AS amount
        FROM "LedgerLine"
        WHERE "transactionId" = target_transaction_id
        GROUP BY "accountCode", "direction"
      )
      SELECT 1
      FROM original
      FULL JOIN reversal
        ON reversal."accountCode" = original."accountCode"
       AND reversal."direction" = CASE original."direction"
         WHEN 'DEBIT'::"LedgerDirection" THEN 'CREDIT'::"LedgerDirection"
         ELSE 'DEBIT'::"LedgerDirection"
       END
      WHERE original.amount IS DISTINCT FROM reversal.amount
    ) THEN
      RAISE EXCEPTION 'D03 compensation % does not exactly reverse its source', target_transaction_id
        USING ERRCODE = '23514', CONSTRAINT = 'LedgerTransaction_compensation_lines';
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION d03_validate_ledger_parent_trigger() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM d03_validate_ledger_transaction(NEW."id");
  RETURN NULL;
END;
$$;

CREATE FUNCTION d03_validate_ledger_line_trigger() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM d03_validate_ledger_transaction(NEW."transactionId");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "LedgerTransaction_balanced_trigger"
AFTER INSERT ON "LedgerTransaction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION d03_validate_ledger_parent_trigger();

CREATE CONSTRAINT TRIGGER "LedgerLine_balanced_trigger"
AFTER INSERT ON "LedgerLine"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION d03_validate_ledger_line_trigger();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'LedgerTransaction', 'LedgerLine', 'OutboxEvent', 'OutboxConsumerReceipt'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION d03_reject_economic_history_mutation()',
      table_name || '_append_only', table_name
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', table_name);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE %I TO service_role', table_name);
  END LOOP;
END;
$$;

CREATE FUNCTION d03_consume_outbox_event(
  target_restaurant_id TEXT,
  target_event_id TEXT,
  target_consumer_name TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count INTEGER;
BEGIN
  IF target_consumer_name !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,99}$' THEN
    RAISE EXCEPTION 'D03 consumer name is invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO "OutboxConsumerReceipt" (
    "id", "restaurantId", "eventId", "consumerName"
  )
  SELECT target_event_id || ':' || target_consumer_name,
         event."restaurantId", event."id", target_consumer_name
  FROM "OutboxEvent" event
  WHERE event."id" = target_event_id
    AND event."restaurantId" = target_restaurant_id
  ON CONFLICT ("eventId", "consumerName") DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION d03_consume_outbox_event(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION d03_consume_outbox_event(TEXT, TEXT, TEXT) TO service_role;
