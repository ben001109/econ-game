import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const migration = readFileSync(
  `${repositoryRoot}/services/api/prisma/migrations/20260816000100_b2_outbox_dead_letter/migration.sql`,
  'utf8',
);
const rollback = readFileSync(
  `${repositoryRoot}/services/api/prisma/migrations/20260816000100_b2_outbox_dead_letter/rollback.sql`,
  'utf8',
);
const worker = readFileSync(`${repositoryRoot}/services/worker/src/simulation-platform.ts`, 'utf8');
const workerEntrypoint = readFileSync(`${repositoryRoot}/services/worker/src/index.ts`, 'utf8');

test('B2 dead-letter history is scoped, immutable, service-only, and reversible', () => {
  assert.match(migration, /CREATE TABLE "OutboxConsumerDeadLetter"/);
  assert.match(migration, /OutboxConsumerDeadLetter_event_scope_fkey/);
  assert.match(migration, /UNIQUE \("eventId", "consumerName"\)/);
  assert.match(migration, /OutboxConsumerDeadLetter_append_only/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE "OutboxConsumerDeadLetter" FROM authenticated/);
  assert.match(
    migration,
    /GRANT SELECT, INSERT ON TABLE "OutboxConsumerDeadLetter" TO service_role/,
  );
  assert.match(rollback, /DROP TABLE IF EXISTS "OutboxConsumerDeadLetter"/);
  assert.doesNotMatch(rollback, /DROP TABLE IF EXISTS "(?:OutboxEvent|OutboxConsumerReceipt)"/);
  assert.doesNotMatch(migration, /prisma\s+db\s+push/i);
});

test('worker isolates owned simulation poison atomically without swallowing database failures', () => {
  assert.match(worker, /event\."eventType" LIKE 'simulation\.%'/);
  assert.match(worker, /FOR UPDATE OF event SKIP LOCKED/);
  assert.match(worker, /INSERT INTO "OutboxConsumerDeadLetter"/);
  assert.match(worker, /INSERT INTO "OutboxConsumerReceipt"/);
  assert.match(worker, /OUTBOX_EVENT_UNSUPPORTED/);
  assert.match(worker, /OUTBOX_EVENT_RESOURCE_LIMIT_EXCEEDED/);
  assert.doesNotMatch(worker, /catch \{\s*return false;\s*\}/);
  assert.match(workerEntrypoint, /isTransientSimulationInfrastructureError/);
  assert.match(workerEntrypoint, /retrying without consuming the event/);
});
