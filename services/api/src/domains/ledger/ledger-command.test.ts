import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPENSATE_LEDGER_TRANSACTION,
  createLedgerCommandHandlers,
  POST_LEDGER_TRANSACTION,
} from './ledger-command.js';
import { createApiComposition } from '../../app-composition.js';
import { RoleMatrixAuthorizationPolicy } from '../../auth/authorization.js';
import type { TrustedContextSecurityOptions } from '../../auth/trusted-command-context.js';
import { COMMAND_ENVELOPE_VERSION, CommandError } from '../../commands/command-contract.js';
import {
  assertValidCommandHandlerResult,
  CommandDispatcher,
  type CommandExecutionStore,
  type CommandHandlerResult,
  type CommandStoreInput,
  type DurableCommandPersistence,
  unavailableDurableCommandPersistence,
} from '../../commands/command-dispatcher.js';

const identitySecurity: TrustedContextSecurityOptions = {
  jwtVerifier: {
    async verify() {
      return {
        subject: 'clerk-owner',
        issuer: 'local-test',
        audience: ['econ-game-api'],
        authorizedParty: 'local-test',
        expiresAt: 2_000_000_000,
      };
    },
  },
  repository: {
    async findPlayerByClerkSubject() {
      return { id: 'player-owner', clerkUserId: 'clerk-owner' };
    },
    async findPlayerByDiscordId() {
      return undefined;
    },
    async findActiveGameScope() {
      return {
        playerId: 'player-owner',
        membershipId: 'membership-owner',
        tenantId: 'restaurant-a',
        saveId: 'save-a',
        role: 'OWNER',
        branchScope: { kind: 'all' },
      };
    },
  },
  authorization: new RoleMatrixAuthorizationPolicy({
    [POST_LEDGER_TRANSACTION]: ['OWNER', 'MANAGER'],
    [COMPENSATE_LEDGER_TRANSACTION]: ['OWNER', 'MANAGER'],
  }),
};

const postingPayload = {
  settlementCurrency: 'TWD',
  reason: 'authoritative test movement',
  lines: [
    {
      accountCode: 'CASH:SETTLEMENT',
      direction: 'DEBIT',
      amount: { currency: 'TWD', minorUnits: '1250' },
    },
    {
      accountCode: 'REVENUE:CONTROL',
      direction: 'CREDIT',
      amount: { currency: 'TWD', minorUnits: '1250' },
    },
  ],
};

function command(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schemaVersion: COMMAND_ENVELOPE_VERSION,
    commandId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'ledger-key-1',
    commandType: POST_LEDGER_TRANSACTION,
    aggregateId: 'save-a',
    expectedVersion: 1,
    payload: postingPayload,
    ...overrides,
  };
}

class IntegrationLedgerStore implements CommandExecutionStore {
  readonly effects: NonNullable<CommandHandlerResult['transactionalEffect']>[] = [];
  private readonly records = new Map<
    string,
    Readonly<{
      fingerprint: string;
      outcome: Readonly<{ commandId: string; execution: CommandHandlerResult }>;
    }>
  >();
  private version = 1;

  async execute(
    input: CommandStoreInput,
    operation: (
      currentVersion: number,
      persistence: DurableCommandPersistence,
    ) => Promise<CommandHandlerResult>,
  ): Promise<Readonly<{ commandId: string; execution: CommandHandlerResult }>> {
    const key = `${input.actorScope}\u0000${input.idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing) {
      if (existing.fingerprint !== input.requestFingerprint) {
        throw new CommandError(409, 'IDEMPOTENCY_KEY_REUSED');
      }
      return existing.outcome;
    }
    if (input.expectedVersion !== this.version) {
      throw new CommandError(409, 'EXPECTED_VERSION_CONFLICT', {
        actualVersion: this.version,
        expectedVersion: input.expectedVersion,
      });
    }
    const proposed = await operation(this.version, unavailableDurableCommandPersistence);
    assertValidCommandHandlerResult(proposed, this.version);
    assert.ok(proposed.transactionalEffect);
    this.effects.push(proposed.transactionalEffect);
    this.version = proposed.aggregateVersion;
    const execution = Object.freeze({
      aggregateVersion: proposed.aggregateVersion,
      result: proposed.result,
    });
    const outcome = Object.freeze({ commandId: input.commandId, execution });
    this.records.set(key, { fingerprint: input.requestFingerprint, outcome });
    return outcome;
  }
}

function assertCommandError(
  response: Readonly<{ statusCode: number; json(): unknown }>,
  status: number,
  code: string,
): void {
  assert.equal(response.statusCode, status);
  const body = response.json() as Readonly<{ error: Readonly<{ code: string }> }>;
  assert.equal(body.error.code, code);
}

test('ledger handler maps a balanced request to immutable posting lines and stable command identities', async () => {
  const handler = createLedgerCommandHandlers().find(
    (candidate) => candidate.commandType === POST_LEDGER_TRANSACTION,
  );
  assert.ok(handler);
  const result = await handler.execute({
    context: {
      actorId: 'player-owner',
      tenantId: 'restaurant-a',
      saveId: 'save-a',
      roles: ['OWNER'],
      membershipId: 'membership-owner',
      branchScope: { kind: 'all' },
      principal: { type: 'web' },
    },
    command: command(),
    currentVersion: 7,
    persistence: unavailableDurableCommandPersistence,
  });
  assert.equal(result.aggregateVersion, 8);
  assert.deepEqual(result.transactionalEffect, {
    kind: 'ledger.posting/v1',
    transactionId: '11111111-1111-4111-8111-111111111111',
    eventId: '11111111-1111-4111-8111-111111111111',
    currency: 'TWD',
    reason: 'authoritative test movement',
    lines: [
      { accountCode: 'CASH:SETTLEMENT', direction: 'DEBIT', amountMinor: '1250' },
      { accountCode: 'REVENUE:CONTROL', direction: 'CREDIT', amountMinor: '1250' },
    ],
  });
  assert.ok(Object.isFrozen(result.transactionalEffect));
  assert.ok(
    result.transactionalEffect?.kind === 'ledger.posting/v1' &&
      Object.isFrozen(result.transactionalEffect.lines),
  );
});

test('true Fastify app.inject preserves D02 409/422 semantics and retry does not duplicate posting', async () => {
  const store = new IntegrationLedgerStore();
  const app = createApiComposition({
    commandDispatcher: new CommandDispatcher(createLedgerCommandHandlers(), store),
    identitySecurity,
    testOnlyBypassClosedBetaEligibility: true,
  });

  const first = await app.inject({
    method: 'POST',
    url: `/saves/save-a/actions/${POST_LEDGER_TRANSACTION}`,
    headers: { authorization: 'Bearer local-test-token' },
    payload: command(),
  });
  assert.equal(first.statusCode, 200);
  assert.equal(store.effects.length, 1);

  const retry = await app.inject({
    method: 'POST',
    url: `/saves/save-a/actions/${POST_LEDGER_TRANSACTION}`,
    headers: { authorization: 'Bearer local-test-token' },
    payload: command({ commandId: '22222222-2222-4222-8222-222222222222' }),
  });
  assert.deepEqual(retry.json(), first.json());
  assert.equal(store.effects.length, 1);

  assertCommandError(
    await app.inject({
      method: 'POST',
      url: `/saves/save-a/actions/${POST_LEDGER_TRANSACTION}`,
      headers: { authorization: 'Bearer local-test-token' },
      payload: command({
        commandId: '33333333-3333-4333-8333-333333333333',
        idempotencyKey: 'stale-key',
      }),
    }),
    409,
    'EXPECTED_VERSION_CONFLICT',
  );

  assertCommandError(
    await app.inject({
      method: 'POST',
      url: `/saves/save-a/actions/${POST_LEDGER_TRANSACTION}`,
      headers: { authorization: 'Bearer local-test-token' },
      payload: command({
        commandId: '44444444-4444-4444-8444-444444444444',
        idempotencyKey: 'unbalanced-key',
        expectedVersion: 2,
        payload: {
          ...postingPayload,
          lines: [
            postingPayload.lines[0],
            { ...postingPayload.lines[1], amount: { currency: 'TWD', minorUnits: '1249' } },
          ],
        },
      }),
    }),
    422,
    'LEDGER_NOT_BALANCED',
  );

  assertCommandError(
    await app.inject({
      method: 'POST',
      url: `/saves/save-a/actions/${COMPENSATE_LEDGER_TRANSACTION}`,
      headers: { authorization: 'Bearer local-test-token' },
      payload: command({
        commandId: '55555555-5555-4555-8555-555555555555',
        idempotencyKey: 'invalid-compensation-key',
        commandType: COMPENSATE_LEDGER_TRANSACTION,
        expectedVersion: 2,
        payload: { reversesTransactionId: 'not-a-transaction', reason: 'invalid target' },
      }),
    }),
    422,
    'LEDGER_TRANSACTION_INVALID',
  );
  await app.close();
});

test('ledger handler rejects cross-currency lines, bigint overflow, and unprivileged roles', async () => {
  const handler = createLedgerCommandHandlers().find(
    (candidate) => candidate.commandType === POST_LEDGER_TRANSACTION,
  );
  assert.ok(handler);
  const base = {
    context: {
      actorId: 'player-owner',
      tenantId: 'restaurant-a',
      saveId: 'save-a',
      roles: ['OWNER'],
      membershipId: 'membership-owner',
      branchScope: { kind: 'all' } as const,
      principal: { type: 'web' } as const,
    },
    currentVersion: 1,
    persistence: unavailableDurableCommandPersistence,
  };
  await assert.rejects(
    handler.execute({
      ...base,
      command: command({
        payload: {
          ...postingPayload,
          lines: [
            postingPayload.lines[0],
            { ...postingPayload.lines[1], amount: { currency: 'USD', minorUnits: '1250' } },
          ],
        },
      }),
    }),
    (error) => error instanceof CommandError && error.code === 'LEDGER_TRANSACTION_INVALID',
  );
  await assert.rejects(
    handler.execute({
      ...base,
      command: command({
        payload: {
          ...postingPayload,
          lines: postingPayload.lines.map((line) => ({
            ...line,
            amount: { currency: 'TWD', minorUnits: '9223372036854775808' },
          })),
        },
      }),
    }),
    (error) => error instanceof CommandError && error.code === 'LEDGER_TRANSACTION_INVALID',
  );
  await assert.rejects(
    handler.execute({
      ...base,
      context: { ...base.context, roles: ['VIEWER'] },
      command: command(),
    }),
    (error) => error instanceof CommandError && error.code === 'LEDGER_ROLE_FORBIDDEN',
  );
});
