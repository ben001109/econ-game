import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const migrationRoot = `${repositoryRoot}/services/api/prisma/migrations/20260818000100_d03_generic_durable_command`;
const migration = readFileSync(`${migrationRoot}/migration.sql`, 'utf8');
const rollback = readFileSync(`${migrationRoot}/rollback.sql`, 'utf8');
const apiSchema = readFileSync(`${repositoryRoot}/services/api/prisma/schema.prisma`, 'utf8');
const workerSchema = readFileSync(`${repositoryRoot}/services/worker/prisma/schema.prisma`, 'utf8');

test('migration backfills and verifies command causation before enforcing uniqueness', () => {
  assert.match(migration, /SET "causationCommandId" = ledger\."commandId"/);
  assert.match(migration, /WHERE "causationCommandId" IS NULL/);
  assert.match(
    migration,
    /GROUP BY "causationCommandId", "eventSequence"[\s\S]+HAVING count\(\*\) > 1/,
  );
  assert.ok(
    migration.indexOf('SET "causationCommandId" = ledger."commandId"') <
      migration.indexOf('ALTER COLUMN "causationCommandId" SET NOT NULL'),
  );
  assert.match(migration, /ALTER COLUMN "transactionId" DROP NOT NULL/);
  assert.match(migration, /ALTER COLUMN "sourceTransactionId" DROP NOT NULL/);
  assert.match(migration, /UNIQUE \("causationCommandId", "eventSequence"\)/);
  assert.match(migration, /OutboxEvent_restaurantId_saveId_causationCommandId_idx/);
});

test('migration preserves append-only enforcement and creates no client privilege', () => {
  assert.match(migration, /DISABLE TRIGGER "OutboxEvent_append_only"/);
  assert.match(migration, /ENABLE TRIGGER "OutboxEvent_append_only"/);
  assert.doesNotMatch(migration, /GRANT\s+[^;]+\s+TO\s+(?:anon|authenticated)/i);
  assert.doesNotMatch(migration, /CREATE\s+POLICY/i);
  assert.doesNotMatch(migration, /prisma\s+db\s+push/i);
});

test('rollback fails closed instead of deleting non-monetary durable history', () => {
  assert.match(rollback, /WHERE "transactionId" IS NULL/);
  assert.match(rollback, /WHERE "sourceTransactionId" IS NULL/);
  assert.match(rollback, /event\."eventSequence" <> 0/);
  assert.match(rollback, /rollback refused/);
  assert.match(rollback, /ALTER COLUMN "transactionId" SET NOT NULL/);
  assert.match(rollback, /ALTER COLUMN "sourceTransactionId" SET NOT NULL/);
  assert.doesNotMatch(rollback, /DELETE\s+FROM|TRUNCATE/i);
});

test('API and worker schemas agree on optional ledger and mandatory command provenance', () => {
  for (const schema of [apiSchema, workerSchema]) {
    const outbox = schema.match(/model OutboxEvent \{[\s\S]*?\n\}/)?.[0] ?? '';
    const job = schema.match(/model SimulationJob \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(outbox, /transactionId\s+String\?\s+@unique/);
    assert.match(outbox, /causationCommandId\s+String\s*$/m);
    assert.match(outbox, /eventSequence\s+Int\s+@default\(0\)/);
    assert.match(outbox, /transaction\s+LedgerTransaction\?/);
    assert.match(outbox, /@@unique\(\[causationCommandId, eventSequence\]\)/);
    assert.match(outbox, /@@index\(\[restaurantId, saveId, causationCommandId\]\)/);
    assert.match(job, /sourceTransactionId\s+String\?/);
    assert.match(job, /sourceEvent\s+OutboxEvent\s+/);
    assert.match(job, /sourceTransaction\s+LedgerTransaction\?/);
  }
});
