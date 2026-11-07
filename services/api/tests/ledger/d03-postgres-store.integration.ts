// eslint-disable-next-line import/no-unresolved
import { SQL } from 'bun';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommandError,
  COMMAND_ENVELOPE_VERSION,
  type TrustedCommandContext,
} from '../../src/commands/command-contract.js';
import { CommandDispatcher } from '../../src/commands/command-dispatcher.js';
import {
  COMPENSATE_LEDGER_TRANSACTION,
  createLedgerCommandHandlers,
  POST_LEDGER_TRANSACTION,
} from '../../src/domains/ledger/ledger-command.js';
import {
  PostgresLedgerCommandExecutionStore,
  PostgresOutboxConsumer,
  type D03Database,
} from '../../src/domains/ledger/postgres-ledger-store.js';

const databaseUrl = process.env.D03_TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error('D03_TEST_DATABASE_URL is required for the isolated PostgreSQL test');

const sql = new SQL(databaseUrl);
const database: D03Database = {
  $transaction(operation) {
    return sql.begin((transaction) =>
      operation({
        $queryRawUnsafe(query, ...values) {
          return transaction.unsafe(query, values.map(normalizeJsonParameter));
        },
      }),
    );
  },
};

function query<T>(statement: string, ...values: readonly unknown[]): Promise<T> {
  return sql.unsafe(statement, values.map(normalizeJsonParameter)) as Promise<T>;
}

function normalizeJsonParameter(value: unknown): unknown {
  if (typeof value !== 'string' || (!value.startsWith('{') && !value.startsWith('['))) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

const contextA: TrustedCommandContext = {
  actorId: 'player-a',
  tenantId: 'restaurant-a',
  saveId: 'save-a',
  roles: ['OWNER'],
  membershipId: 'membership-a',
  branchScope: { kind: 'all' },
  principal: { type: 'web' },
};

const contextB: TrustedCommandContext = {
  actorId: 'player-b',
  tenantId: 'restaurant-b',
  saveId: 'save-a',
  roles: ['OWNER'],
  membershipId: 'membership-b',
  branchScope: { kind: 'all' },
  principal: { type: 'web' },
};

function postingCommand(
  commandId: string,
  idempotencyKey: string,
  expectedVersion: number,
  amount = '2500',
) {
  return {
    schemaVersion: COMMAND_ENVELOPE_VERSION,
    commandId,
    idempotencyKey,
    commandType: POST_LEDGER_TRANSACTION,
    aggregateId: 'save-a',
    expectedVersion,
    payload: {
      settlementCurrency: 'TWD',
      reason: 'postgres integration posting',
      lines: [
        {
          accountCode: 'CASH:SETTLEMENT',
          direction: 'DEBIT',
          amount: { currency: 'TWD', minorUnits: amount },
        },
        {
          accountCode: 'REVENUE:CONTROL',
          direction: 'CREDIT',
          amount: { currency: 'TWD', minorUnits: amount },
        },
      ],
    },
  };
}

function dispatch(
  dispatcher: CommandDispatcher,
  context: TrustedCommandContext,
  command: ReturnType<typeof postingCommand> | Readonly<Record<string, unknown>>,
  commandType = POST_LEDGER_TRANSACTION,
) {
  return dispatcher.dispatch({
    context,
    target: { saveId: 'save-a', commandType },
    envelope: command,
  });
}

test('real PostgreSQL atomically commits version, ledger, outbox, idempotency and rolls back outbox failure', async () => {
  const dispatcher = new CommandDispatcher(
    createLedgerCommandHandlers(),
    new PostgresLedgerCommandExecutionStore(database),
  );
  const firstCommand = postingCommand(
    '11111111-1111-4111-8111-111111111111',
    'postgres-ledger-key-1',
    1,
  );
  const [first, retry] = await Promise.all([
    dispatch(dispatcher, contextA, firstCommand),
    dispatch(dispatcher, contextA, firstCommand),
  ]);
  assert.equal(first.body.aggregateVersion, 2);
  assert.deepEqual(retry, first);

  const counts = await query<
    readonly Readonly<{
      transactions: string;
      lines: string;
      events: string;
      idempotency: string;
    }>[]
  >(
    `SELECT
       (SELECT count(*) FROM "LedgerTransaction" WHERE "restaurantId" = 'restaurant-a') AS transactions,
       (SELECT count(*) FROM "LedgerLine" WHERE "restaurantId" = 'restaurant-a') AS lines,
       (SELECT count(*) FROM "OutboxEvent" WHERE "restaurantId" = 'restaurant-a') AS events,
       (SELECT count(*) FROM "IdempotencyRecord" WHERE "restaurantId" = 'restaurant-a') AS idempotency`,
  );
  assert.deepEqual(counts[0], { transactions: '1', lines: '2', events: '1', idempotency: '1' });

  await assert.rejects(
    dispatch(dispatcher, contextA, {
      ...firstCommand,
      payload: { ...firstCommand.payload, reason: 'different' },
    }),
    (error) => error instanceof CommandError && error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  await assert.rejects(
    dispatch(
      dispatcher,
      contextA,
      postingCommand('33333333-3333-4333-8333-333333333333', 'stale-version-key', 1),
    ),
    (error) => error instanceof CommandError && error.code === 'EXPECTED_VERSION_CONFLICT',
  );
  await assert.rejects(
    dispatch(
      dispatcher,
      contextB,
      postingCommand('44444444-4444-4444-8444-444444444444', 'cross-tenant-key', 1),
    ),
    (error) => error instanceof CommandError && error.code === 'LEDGER_SCOPE_FORBIDDEN',
  );

  const compensation = {
    schemaVersion: COMMAND_ENVELOPE_VERSION,
    commandId: '55555555-5555-4555-8555-555555555555',
    idempotencyKey: 'postgres-compensation-key',
    commandType: COMPENSATE_LEDGER_TRANSACTION,
    aggregateId: 'save-a',
    expectedVersion: 2,
    payload: {
      reversesTransactionId: firstCommand.commandId,
      reason: 'authoritative full reversal',
    },
  };
  const compensated = await dispatch(
    dispatcher,
    contextA,
    compensation,
    COMPENSATE_LEDGER_TRANSACTION,
  );
  assert.equal(compensated.body.aggregateVersion, 3);
  await assert.rejects(
    dispatch(
      dispatcher,
      contextA,
      {
        ...compensation,
        commandId: '66666666-6666-4666-8666-666666666666',
        idempotencyKey: 'second-compensation-key',
        expectedVersion: 3,
      },
      COMPENSATE_LEDGER_TRANSACTION,
    ),
    (error) =>
      error instanceof CommandError && error.code === 'LEDGER_TRANSACTION_ALREADY_COMPENSATED',
  );

  const consumer = new PostgresOutboxConsumer(database);
  const consumed = await consumer.consume(
    {
      restaurantId: 'restaurant-a',
      eventId: firstCommand.commandId,
      consumerName: 'ledger.integration.projection',
    },
    async (transaction, event) => {
      await transaction.$queryRawUnsafe(
        `INSERT INTO "AuditLog" (
           "id", "restaurantId", "actorPlayerId", "actorType", "action",
           "targetType", "targetId", "metadata"
         ) VALUES ($1,$2,'player-a','worker','ledger_projection_applied','OutboxEvent',$3,$4::jsonb)`,
        `projection:${event.eventId}`,
        'restaurant-a',
        event.eventId,
        JSON.stringify({ aggregateVersion: event.aggregateVersion }),
      );
    },
  );
  const duplicate = await consumer.consume(
    {
      restaurantId: 'restaurant-a',
      eventId: firstCommand.commandId,
      consumerName: 'ledger.integration.projection',
    },
    async () => {
      assert.fail('duplicate delivery must not execute its projection');
    },
  );
  assert.equal(consumed, true);
  assert.equal(duplicate, false);

  await query(`
    CREATE FUNCTION d03_test_reject_outbox() RETURNS TRIGGER
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."id" = '99999999-9999-4999-8999-999999999999' THEN
        RAISE EXCEPTION 'injected D03 outbox failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER d03_test_reject_outbox_trigger
    BEFORE INSERT ON "OutboxEvent"
    FOR EACH ROW EXECUTE FUNCTION d03_test_reject_outbox();
  `);
  await assert.rejects(
    dispatch(
      dispatcher,
      contextA,
      postingCommand('99999999-9999-4999-8999-999999999999', 'outbox-failure-key', 3),
    ),
    /injected D03 outbox failure/,
  );
  const afterFailure = await query<
    readonly Readonly<{
      version: number;
      transactions: string;
      idempotency: string;
    }>[]
  >(
    `SELECT save."version",
       (SELECT count(*) FROM "LedgerTransaction" WHERE "id" = '99999999-9999-4999-8999-999999999999') AS transactions,
       (SELECT count(*) FROM "IdempotencyRecord" WHERE "id" = '99999999-9999-4999-8999-999999999999') AS idempotency
     FROM "CompetitiveSave" save WHERE save."id" = 'save-a'`,
  );
  assert.deepEqual(afterFailure[0], { version: 3, transactions: '0', idempotency: '0' });
  await query(
    'DROP TRIGGER d03_test_reject_outbox_trigger ON "OutboxEvent"; DROP FUNCTION d03_test_reject_outbox()',
  );
});

test.after(async () => {
  await sql.close();
});
