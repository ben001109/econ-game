-- Security B2 rollback. Use only against an isolated/restored database after
-- backup verification because dead-letter audit history is removed.

DROP TRIGGER IF EXISTS "OutboxConsumerDeadLetter_append_only" ON "OutboxConsumerDeadLetter";
DROP INDEX IF EXISTS "OutboxEvent_simulation_consumer_idx";
DROP TABLE IF EXISTS "OutboxConsumerDeadLetter";
