\set ON_ERROR_STOP on

DO $$
DECLARE
  transaction_count INTEGER;
  imbalance_count INTEGER;
  projection_count INTEGER;
BEGIN
  SELECT count(*) INTO transaction_count FROM "LedgerTransaction";
  IF transaction_count <> 2 THEN
    RAISE EXCEPTION 'expected posting plus one compensation, got %', transaction_count;
  END IF;

  SELECT count(*) INTO imbalance_count
  FROM (
    SELECT "transactionId",
           sum("amountMinor") FILTER (WHERE "direction" = 'DEBIT') AS debit,
           sum("amountMinor") FILTER (WHERE "direction" = 'CREDIT') AS credit
    FROM "LedgerLine"
    GROUP BY "transactionId"
  ) totals
  WHERE debit IS DISTINCT FROM credit;
  IF imbalance_count <> 0 THEN
    RAISE EXCEPTION 'persisted D03 ledger contains an imbalance';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "LedgerLine" original
    JOIN "LedgerLine" reversal
      ON reversal."transactionId" = '55555555-5555-4555-8555-555555555555'
     AND reversal."sequence" = original."sequence"
     AND reversal."accountCode" = original."accountCode"
     AND reversal."amountMinor" = original."amountMinor"
     AND reversal."direction" <> original."direction"
    WHERE original."transactionId" = '11111111-1111-4111-8111-111111111111'
  ) THEN
    RAISE EXCEPTION 'compensation did not preserve exact reversed lines';
  END IF;

  SELECT count(*) INTO projection_count
  FROM "AuditLog" WHERE "id" = 'projection:11111111-1111-4111-8111-111111111111';
  IF projection_count <> 1 THEN
    RAISE EXCEPTION 'duplicate outbox delivery changed projection count: %', projection_count;
  END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    SET CONSTRAINTS ALL DEFERRED;
    INSERT INTO "LedgerTransaction" (
      "id", "restaurantId", "saveId", "commandId", "actorPlayerId",
      "kind", "currency", "reason"
    ) VALUES (
      '77777777-7777-4777-8777-777777777777', 'restaurant-a', 'save-a',
      '77777777-7777-4777-8777-777777777777', 'player-a', 'POSTING', 'TWD',
      'must fail balance proof'
    );
    INSERT INTO "LedgerLine" (
      "id", "restaurantId", "saveId", "transactionId", "sequence",
      "accountCode", "direction", "amountMinor"
    ) VALUES (
      '77777777-7777-4777-8777-777777777777:0', 'restaurant-a', 'save-a',
      '77777777-7777-4777-8777-777777777777', 0, 'CASH:SETTLEMENT', 'DEBIT', 10
    );
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'unbalanced transaction unexpectedly committed';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    UPDATE "LedgerLine" SET "amountMinor" = 1
    WHERE "id" = '11111111-1111-4111-8111-111111111111:0';
    RAISE EXCEPTION 'append-only ledger update unexpectedly succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "LedgerLine" (
      "id", "restaurantId", "saveId", "transactionId", "sequence",
      "accountCode", "direction", "amountMinor"
    ) VALUES (
      'cross-tenant-line', 'restaurant-b', 'save-b',
      '11111111-1111-4111-8111-111111111111', 99, 'CASH:SETTLEMENT', 'DEBIT', 1
    );
    RAISE EXCEPTION 'cross-tenant ledger line unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END;
$$;

SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM "LedgerTransaction";
    RAISE EXCEPTION 'authenticated client unexpectedly read ledger';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO "OutboxConsumerReceipt" (
      "id", "restaurantId", "eventId", "consumerName"
    ) VALUES (
      'client-forbidden', 'restaurant-a',
      '11111111-1111-4111-8111-111111111111', 'client.forbidden'
    );
    RAISE EXCEPTION 'authenticated client unexpectedly wrote outbox receipt';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
RESET ROLE;

SET ROLE service_role;
DO $$
DECLARE
  first_delivery BOOLEAN;
  repeated_delivery BOOLEAN;
  before_count INTEGER;
  after_count INTEGER;
BEGIN
  SELECT count(*) INTO before_count FROM "LedgerTransaction";
  SELECT d03_consume_outbox_event(
    'restaurant-a', '11111111-1111-4111-8111-111111111111', 'sql.verification'
  ) INTO first_delivery;
  SELECT d03_consume_outbox_event(
    'restaurant-a', '11111111-1111-4111-8111-111111111111', 'sql.verification'
  ) INTO repeated_delivery;
  SELECT count(*) INTO after_count FROM "LedgerTransaction";
  IF first_delivery IS NOT TRUE OR repeated_delivery IS NOT FALSE OR before_count <> after_count THEN
    RAISE EXCEPTION 'outbox eventId deduplication failed';
  END IF;
END;
$$;
RESET ROLE;

\ir ../../prisma/migrations/20260818000100_d03_generic_durable_command/rollback.sql
\ir ../../prisma/migrations/20260814000500_d03_durable_simulation/rollback.sql
\ir ../../prisma/migrations/20260814000400_d03_ledger_outbox/rollback.sql

DO $$
BEGIN
  IF to_regclass('public."LedgerTransaction"') IS NOT NULL
     OR to_regclass('public."OutboxEvent"') IS NOT NULL
     OR to_regprocedure('public.d03_consume_outbox_event(text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'D03 rollback left ledger/outbox artifacts behind';
  END IF;
END;
$$;

\ir ../../prisma/migrations/20260814000300_d05_closed_beta_entry/rollback.sql
\ir ../../prisma/migrations/20260814000200_d04_discord_link_challenge/rollback.sql
\ir ../../prisma/migrations/20260814000100_d01_p0_persistence/rollback.sql
