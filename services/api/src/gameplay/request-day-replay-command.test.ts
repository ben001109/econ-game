import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiComposition } from '../app-composition.js';
import { RoleMatrixAuthorizationPolicy } from '../auth/authorization.js';
import type { TrustedContextSecurityOptions } from '../auth/trusted-command-context.js';
import {
  COMMAND_ENVELOPE_VERSION,
  CommandError,
  type CanonicalCommandValue,
  type CommandEnvelope,
  type TrustedCommandContext,
} from '../commands/command-contract.js';
import {
  PostgresDurableCommandExecutionStore,
  type D03Database,
  type D03Queryable,
} from '../domains/ledger/postgres-ledger-store.js';
import {
  createRequestDayReplayCommandHandler,
  dayReplayJobId,
  parseRequestDayReplayIntent,
} from './request-day-replay-command.js';

const commandId = '11111111-1111-4111-8111-111111111111';
const context: TrustedCommandContext = Object.freeze({
  actorId: 'player-1',
  tenantId: 'restaurant-1',
  saveId: 'save-1',
  roles: ['OWNER'],
  membershipId: 'membership-1',
  branchScope: { kind: 'all' as const },
  principal: { type: 'web' as const },
});

function replayCommand(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    schemaVersion: COMMAND_ENVELOPE_VERSION,
    commandId,
    idempotencyKey: 'request-day-replay-1',
    commandType: 'REQUEST_DAY_REPLAY',
    aggregateId: 'save-1',
    expectedVersion: 1,
    payload: { businessDay: 1 },
    ...overrides,
  };
}

const evidence = Object.freeze({
  businessDay: 1,
  dayEndSnapshotId: 'day-end-1',
  eventHash: 'a'.repeat(64),
  snapshotHash: 'b'.repeat(64),
});

test('REQUEST_DAY_REPLAY only accepts its exact positive businessDay payload', async () => {
  const handler = createRequestDayReplayCommandHandler();
  const queries: string[] = [];
  const persistence = {
    durable: true as const,
    async mutate<T>(statement: string): Promise<T> {
      queries.push(statement);
      return [evidence] as T;
    },
  };
  const invalidPayloads: readonly Readonly<Record<string, CanonicalCommandValue>>[] = [
    {},
    { businessDay: 0 },
    { businessDay: 1.5 },
    { businessDay: 1, eventHash: 'client-authority' },
    { businessDay: 1, seed: 'client-authority' },
    { businessDay: 1, ruleVersion: 'client-authority' },
  ];
  for (const payload of invalidPayloads) {
    await assert.rejects(
      handler.execute({
        context,
        command: replayCommand({ payload }),
        currentVersion: 1,
        persistence,
      }),
      (error) =>
        error instanceof CommandError &&
        error.status === 422 &&
        error.code === 'DAY_REPLAY_REQUEST_INVALID',
    );
  }
  assert.deepEqual(queries, []);
  assert.equal(parseRequestDayReplayIntent(replayCommand()), 1);
});

test('unavailable day replay reads only scoped evidence and commits no handler mutation', async () => {
  const handler = createRequestDayReplayCommandHandler();
  const queries: string[] = [];
  const persistence = {
    durable: true as const,
    async mutate<T>(statement: string): Promise<T> {
      queries.push(statement);
      return [] as T;
    },
  };
  await assert.rejects(
    handler.execute({ context, command: replayCommand(), currentVersion: 1, persistence }),
    (error) =>
      error instanceof CommandError &&
      error.status === 422 &&
      error.code === 'DAY_REPLAY_NOT_AVAILABLE',
  );
  assert.equal(queries.length, 1);
  assert.match(queries[0] ?? '', /day\."restaurantId" = \$1/);
  assert.match(queries[0] ?? '', /day\."saveId" = \$2/);
  assert.match(queries[0] ?? '', /day\."status" = 'SETTLED'/);
  assert.match(queries[0] ?? '', /"ReplayEvent" event/);
  assert.doesNotMatch(queries.join('\n'), /\b(?:INSERT|UPDATE|DELETE)\b/);
});

test('REQUEST_DAY_REPLAY creates one deterministic, non-monetary versioned replay job request', async () => {
  const handler = createRequestDayReplayCommandHandler();
  const execution = await handler.execute({
    context,
    command: replayCommand(),
    currentVersion: 4,
    persistence: {
      durable: true,
      async mutate<T>(): Promise<T> {
        return [evidence] as T;
      },
    },
  });
  const jobId = dayReplayJobId(commandId);
  assert.equal(execution.status, 202);
  assert.equal(execution.aggregateVersion, 5);
  assert.equal(execution.jobId, jobId);
  assert.deepEqual(execution.result, {
    businessDay: 1,
    eventHash: evidence.eventHash,
    replayAvailability: 'QUEUED',
    snapshotHash: evidence.snapshotHash,
  });
  assert.equal(execution.effects?.ledger, undefined);
  assert.equal(execution.effects?.outbox?.length, 1);
  const effect = execution.effects?.outbox?.[0];
  assert.deepEqual(effect, {
    kind: 'outbox.job-request/v1',
    eventId: commandId,
    eventSequence: 0,
    eventType: 'simulation.versioned-replay.requested',
    eventVersion: 1,
    jobId,
    payload: {
      businessKey: 'save-1:1:DAY_REPLAY',
      jobId,
      jobKind: 'VERSIONED_REPLAY',
      replay: {
        schemaVersion: 'd03-versioned-replay-job/v1',
        replayKind: 'DAY_REPLAY',
        businessDay: 1,
        rule: {
          kind: 'RULE',
          key: 'DAY_REPLAY_EVIDENCE',
          version: 'mvp-release-evidence-v1',
        },
        catalogs: [],
        replayPayload: {
          schemaVersion: 'p0-day-replay-locator/v1',
          locator: {
            businessDay: 1,
            dayEndSnapshotId: 'day-end-1',
            eventHash: evidence.eventHash,
            saveId: 'save-1',
            snapshotHash: evidence.snapshotHash,
          },
        },
      },
      schemaVersion: 'd03-versioned-replay-request/v1',
    },
  });
  assert.equal(dayReplayJobId(commandId), jobId);
  assert.match(jobId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

class ReplayDatabase implements D03Database {
  version = 1;
  scopeAllowed = true;
  evidenceAvailable = true;
  readonly queries: string[] = [];
  readonly outboxRows: readonly unknown[][] = [];
  private readonly stored = new Map<
    string,
    Readonly<{ commandId: string; fingerprint: string; snapshot: unknown }>
  >();

  async $transaction<T>(operation: (transaction: D03Queryable) => Promise<T>): Promise<T> {
    const transaction: D03Queryable = {
      $queryRawUnsafe: async <R>(query: string, ...values: readonly unknown[]): Promise<R> => {
        this.queries.push(query);
        if (query.includes('INSERT INTO "IdempotencyRecord"')) {
          const receiptKey = JSON.stringify([values[3], values[4]]);
          if (this.stored.has(receiptKey)) return [] as R;
          this.stored.set(receiptKey, {
            commandId: String(values[0]),
            fingerprint: String(values[5]),
            snapshot: undefined,
          });
          return [{ id: values[0] }] as R;
        }
        if (query.includes('SELECT "id" AS "commandId"')) {
          const receipt = this.stored.get(JSON.stringify([values[0], values[1]]));
          if (!receipt) throw new Error('missing stored receipt');
          return [
            {
              commandId: receipt.commandId,
              requestFingerprint: receipt.fingerprint,
              status: 'COMPLETED',
              responseSnapshot: receipt.snapshot,
            },
          ] as R;
        }
        if (query.includes('SELECT save."version"')) {
          return (this.scopeAllowed ? [{ version: this.version }] : []) as R;
        }
        if (query.includes('/* request-day-replay:evidence */')) {
          return (this.evidenceAvailable ? [evidence] : []) as R;
        }
        if (query.includes('INSERT INTO "OutboxEvent"')) {
          (this.outboxRows as unknown[][]).push([...values]);
          return [] as R;
        }
        if (query.includes('UPDATE "CompetitiveSave"')) {
          this.version = Number(values[3]);
          return [{ version: this.version }] as R;
        }
        if (query.includes('UPDATE "IdempotencyRecord"')) {
          const receiptEntry = [...this.stored.entries()].find(
            ([, receipt]) => receipt.commandId === values[0],
          );
          if (!receiptEntry) throw new Error('missing receipt');
          this.stored.set(receiptEntry[0], {
            ...receiptEntry[1],
            snapshot: JSON.parse(String(values[1])),
          });
          return [] as R;
        }
        throw new Error(`unexpected query: ${query}`);
      },
    };
    return operation(transaction);
  }
}

const identitySecurity: TrustedContextSecurityOptions = {
  jwtVerifier: {
    async verify() {
      return {
        subject: 'clerk-user-1',
        issuer: 'local-test',
        audience: ['econ-game-api'],
        authorizedParty: 'local-test',
        expiresAt: 2_000_000_000,
      };
    },
  },
  repository: {
    async findPlayerByClerkSubject() {
      return { id: 'player-1', clerkUserId: 'clerk-user-1' };
    },
    async findPlayerByDiscordId() {
      return undefined;
    },
    async findActiveGameScope() {
      return {
        playerId: 'player-1',
        membershipId: 'membership-1',
        tenantId: 'restaurant-1',
        saveId: 'save-1',
        role: 'OWNER',
        branchScope: { kind: 'all' as const },
      };
    },
  },
  authorization: new RoleMatrixAuthorizationPolicy({ REQUEST_DAY_REPLAY: ['OWNER', 'MANAGER'] }),
};

test('normal durable API composition reaches REQUEST_DAY_REPLAY with idempotency and version safety', async () => {
  const database = new ReplayDatabase();
  const app = createApiComposition({
    durableCommandDatabase: database,
    identitySecurity,
    testOnlyBypassClosedBetaEligibility: true,
  });
  const first = await app.inject({
    method: 'POST',
    url: '/saves/save-1/actions/REQUEST_DAY_REPLAY',
    headers: { authorization: 'Bearer local-test-token' },
    payload: replayCommand(),
  });
  assert.equal(first.statusCode, 202);
  const body = first.json() as Readonly<{ commandId: string; jobId: string; result: unknown }>;
  assert.equal(body.commandId, commandId);
  assert.equal(body.jobId, dayReplayJobId(commandId));
  assert.deepEqual(body.result, {
    businessDay: 1,
    eventHash: evidence.eventHash,
    replayAvailability: 'QUEUED',
    snapshotHash: evidence.snapshotHash,
  });
  assert.equal(database.outboxRows.length, 1);
  assert.equal(database.outboxRows[0]?.[0], commandId);
  assert.equal(database.outboxRows[0]?.[3], null);
  assert.equal(database.outboxRows[0]?.[4], commandId);

  const repeated = await app.inject({
    method: 'POST',
    url: '/saves/save-1/actions/REQUEST_DAY_REPLAY',
    headers: { authorization: 'Bearer local-test-token' },
    payload: replayCommand({ commandId: '22222222-2222-4222-8222-222222222222' }),
  });
  assert.equal(repeated.statusCode, 202);
  assert.deepEqual(repeated.json(), first.json());
  assert.equal(database.outboxRows.length, 1);

  const stale = await app.inject({
    method: 'POST',
    url: '/saves/save-1/actions/REQUEST_DAY_REPLAY',
    headers: { authorization: 'Bearer local-test-token' },
    payload: replayCommand({
      commandId: '33333333-3333-4333-8333-333333333333',
      idempotencyKey: 'request-day-replay-stale',
    }),
  });
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.json(), {
    error: {
      version: 'd02-command-error/v1',
      code: 'EXPECTED_VERSION_CONFLICT',
      details: { actualVersion: 2, expectedVersion: 1 },
    },
  });
  assert.equal(
    database.queries.filter((query) => query.includes('request-day-replay:evidence')).length,
    1,
  );
  await app.close();
});

test('durable scope rejection occurs before REQUEST_DAY_REPLAY evidence lookup', async () => {
  const database = new ReplayDatabase();
  database.scopeAllowed = false;
  const store = new PostgresDurableCommandExecutionStore(database);
  await assert.rejects(
    store.execute(
      {
        actorScope: '["restaurant-1","save-1","player-1"]',
        aggregateScope: '["restaurant-1","save-1","save-1"]',
        idempotencyKey: 'scoped-replay',
        commandId: '44444444-4444-4444-8444-444444444444',
        requestFingerprint: 'c'.repeat(64),
        expectedVersion: 1,
        context,
      },
      (currentVersion, persistence) =>
        createRequestDayReplayCommandHandler().execute({
          context,
          command: replayCommand({ commandId: '44444444-4444-4444-8444-444444444444' }),
          currentVersion,
          persistence,
        }),
    ),
    (error) =>
      error instanceof CommandError &&
      error.status === 403 &&
      error.code === 'LEDGER_SCOPE_FORBIDDEN',
  );
  assert.equal(
    database.queries.some((query) => query.includes('request-day-replay:evidence')),
    false,
  );
});
