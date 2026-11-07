-- D03-S-01 rollback. Use only against an isolated/restored database after
-- backup verification; all D03 economic history is intentionally destroyed.

DROP TRIGGER IF EXISTS "LedgerTransaction_balanced_trigger" ON "LedgerTransaction";
DROP TRIGGER IF EXISTS "LedgerLine_balanced_trigger" ON "LedgerLine";
DROP TRIGGER IF EXISTS "LedgerTransaction_append_only" ON "LedgerTransaction";
DROP TRIGGER IF EXISTS "LedgerLine_append_only" ON "LedgerLine";
DROP TRIGGER IF EXISTS "OutboxEvent_append_only" ON "OutboxEvent";
DROP TRIGGER IF EXISTS "OutboxConsumerReceipt_append_only" ON "OutboxConsumerReceipt";

DROP FUNCTION IF EXISTS d03_consume_outbox_event(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS d03_validate_ledger_line_trigger();
DROP FUNCTION IF EXISTS d03_validate_ledger_parent_trigger();
DROP FUNCTION IF EXISTS d03_validate_ledger_transaction(TEXT);
DROP FUNCTION IF EXISTS d03_reject_economic_history_mutation();

DROP TABLE IF EXISTS "OutboxConsumerReceipt";
DROP TABLE IF EXISTS "OutboxEvent";
DROP TABLE IF EXISTS "LedgerLine";
DROP TABLE IF EXISTS "LedgerTransaction";

DROP TYPE IF EXISTS "LedgerDirection";
DROP TYPE IF EXISTS "LedgerTransactionKind";
