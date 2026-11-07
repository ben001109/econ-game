import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandError, type TrustedCommandContext } from '../../commands/command-contract.js';
import type {
  CommandHandlerResult,
  CommandStoreInput,
} from '../../commands/command-dispatcher.js';
import {
  PostgresDurableCommandExecutionStore,
  type D03Database,
  type D03Queryable,
} from './postgres-ledger-store.js';

const context: TrustedCommandContext = {
  actorId: 'player-owner',
  tenantId: 'restaurant-a',
  saveId: 'save-a',
  roles: ['OWNER'],
  membershipId: 'membership-owner',
  branchScope: { kind: 'all' },
  principal: { type: 'web' },
};

function storeInput(commandId: string): CommandStoreInput {
  return {
    actorScope: '["restaurant-a","save-a","player-owner"]',
    aggregateScope: '["restaurant-a","save-a","save-a"]',
    idempotencyKey: `key:${commandId}`,
    commandId,
    requestFingerprint: 'a'.repeat(64),
    expectedVersion: 1,
    context,
  };
}

class RecordingTransactionalDatabase implements D03Database {
  readonly commits: string[][] = [];

  async $transaction<T>(operation: (transaction: D03Queryable) => Promise<T>): Promise<T> {
    const staged: string[] = [];
    const queryable: D03Queryable = {
      $queryRawUnsafe: async <R>(query: string, ...values: readonly unknown[]): Promise<R> => {
        staged.push(query);
        if (query.includes('INSERT INTO "IdempotencyRecord"')) {
          return [{ id: String(values[0]) }] as R;
        }
        if (query.includes('SELECT save."version"')) return [{ version: 1 }] as R;
        if (query.includes('UPDATE "FakeDurableState"')) return [{ id: 'state-a' }] as R;
        if (query.includes('INSERT INTO "OutboxEvent"')) return [] as R;
        if (query.includes('UPDATE "CompetitiveSave"')) {
          return [{ version: Number(values[3]) }] as R;
        }
        if (query.includes('UPDATE "IdempotencyRecord"')) return [] as R;
        throw new Error(`unexpected durable command query: ${query}`);
      },
    };
    const result = await operation(queryable);
    this.commits.push(staged);
    return result;
  }
}

class RejectingTransactionalDatabase implements D03Database {
  constructor(private readonly error: unknown) {}

  async $transaction<T>(
    _operation: (transaction: D03Queryable) => Promise<T>,
  ): Promise<T> {
    throw this.error;
  }
}

test('generic durable store commits non-monetary state, outbox, version, and receipt in order', async () => {
  const database = new RecordingTransactionalDatabase();
  const store = new PostgresDurableCommandExecutionStore(database);
  const commandId = '11111111-1111-4111-8111-111111111111';
  const eventId = '11111111-1111-4111-8111-111111111112';
  const outcome = await store.execute(storeInput(commandId), async (currentVersion, persistence) => {
    assert.equal(persistence.durable, true);
    await persistence.mutate(
      'UPDATE "FakeDurableState" SET "value" = $2 WHERE "id" = $1 RETURNING "id"',
      'state-a',
      'changed',
    );
    return Object.freeze({
      aggregateVersion: currentVersion + 1,
      result: Object.freeze({ stateId: 'state-a' }),
      effects: Object.freeze({
        outbox: Object.freeze([
          Object.freeze({
            kind: 'outbox.event/v1' as const,
            eventId,
            eventSequence: 0,
            eventType: 'save.state.changed',
            eventVersion: 1,
            payload: Object.freeze({ stateId: 'state-a' }),
          }),
        ]),
      }),
    });
  });

  assert.equal(outcome.execution.aggregateVersion, 2);
  const committed = database.commits[0] ?? [];
  const operationNames = committed.map((query) => {
    if (query.includes('INSERT INTO "IdempotencyRecord"')) return 'receipt';
    if (query.includes('SELECT save."version"')) return 'lock';
    if (query.includes('UPDATE "FakeDurableState"')) return 'state';
    if (query.includes('INSERT INTO "OutboxEvent"')) return 'outbox';
    if (query.includes('UPDATE "CompetitiveSave"')) return 'version';
    if (query.includes('UPDATE "IdempotencyRecord"')) return 'terminal';
    return 'unknown';
  });
  assert.deepEqual(operationNames, ['receipt', 'lock', 'state', 'outbox', 'version', 'terminal']);
  assert.doesNotMatch(committed.join('\n'), /INSERT INTO "LedgerTransaction"/);
});

test('generic durable store accepts a 202 only with one matching non-ledger job request', async () => {
  const database = new RecordingTransactionalDatabase();
  const store = new PostgresDurableCommandExecutionStore(database);
  const commandId = '22222222-2222-4222-8222-222222222222';
  const jobId = '33333333-3333-4333-8333-333333333333';
  const outcome = await store.execute(storeInput(commandId), async (currentVersion, persistence) => {
    await persistence.mutate(
      'UPDATE "FakeDurableState" SET "value" = $2 WHERE "id" = $1 RETURNING "id"',
      'state-a',
      'queued',
    );
    return {
      status: 202,
      aggregateVersion: currentVersion + 1,
      jobId,
      result: { queued: true },
      effects: {
        outbox: [
          {
            kind: 'outbox.job-request/v1',
            eventId: '44444444-4444-4444-8444-444444444444',
            eventSequence: 0,
            eventType: 'simulation.versioned-replay.requested',
            eventVersion: 1,
            jobId,
            payload: { jobId },
          },
        ],
      },
    };
  });

  assert.equal(outcome.execution.status, 202);
  assert.equal(outcome.execution.jobId, jobId);
  assert.doesNotMatch((database.commits[0] ?? []).join('\n'), /INSERT INTO "LedgerTransaction"/);
});

test('durable handler mutation without outbox fails and leaves no committed transaction', async () => {
  const database = new RecordingTransactionalDatabase();
  const store = new PostgresDurableCommandExecutionStore(database);
  await assert.rejects(
    store.execute(
      storeInput('55555555-5555-4555-8555-555555555555'),
      async (currentVersion, persistence): Promise<CommandHandlerResult> => {
        await persistence.mutate(
          'UPDATE "FakeDurableState" SET "value" = $2 WHERE "id" = $1 RETURNING "id"',
          'state-a',
          'unpublished',
        );
        return { aggregateVersion: currentVersion + 1, result: { changed: true } };
      },
    ),
    (error) =>
      error instanceof CommandError && error.code === 'COMMAND_OUTBOX_EFFECT_REQUIRED',
  );
  assert.equal(database.commits.length, 0);
});

for (const [constraint, expectedCode] of [
  ['InventoryPoolState_occupancy_check', 'INVENTORY_INVARIANT_VIOLATION'],
  ['InventoryTransaction_ledger_scope_command_fkey', 'INVENTORY_INVARIANT_VIOLATION'],
  ['MarketTick_command_preopen_check', 'MARKET_TICK_INVARIANT_VIOLATION'],
  ['MarketSeedAuthority_exact_one_check', 'MARKET_TICK_INVARIANT_VIOLATION'],
] as const) {
  test(`durable store maps ${constraint} to its bounded domain error`, async () => {
    const database = new RejectingTransactionalDatabase({ code: '23514', constraint });
    const store = new PostgresDurableCommandExecutionStore(database);
    await assert.rejects(
      store.execute(storeInput('66666666-6666-4666-8666-666666666666'), async () => ({
        aggregateVersion: 2,
        result: {},
      })),
      (error) => error instanceof CommandError && error.code === expectedCode,
    );
  });
}

for (const constraint of [
  'ServicePeriodExecution_order_check',
  'ServicePeriodExecution_previous_hash_check',
  'BusinessDay_service_complete_evidence_check',
] as const) {
  test(`durable store maps ${constraint} to a safe service-period conflict`, async () => {
    const database = new RejectingTransactionalDatabase({ code: '23514', constraint });
    const store = new PostgresDurableCommandExecutionStore(database);
    await assert.rejects(
      store.execute(storeInput('77777777-7777-4777-8777-777777777777'), async () => ({
        aggregateVersion: 2,
        result: {},
      })),
      (error) =>
        error instanceof CommandError &&
        error.status === 409 &&
        error.code === 'SERVICE_PERIOD_ORDER_CONFLICT',
    );
  });
}
