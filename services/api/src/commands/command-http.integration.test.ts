import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiComposition, createTestOnlyLegacyApiComposition } from '../app-composition.js';
import { RoleMatrixAuthorizationPolicy } from '../auth/authorization.js';
import type { TrustedContextSecurityOptions } from '../auth/trusted-command-context.js';
import type { LegacyCompatibilityDatabase } from '../legacy-compatibility.js';
import { COMMAND_ENVELOPE_VERSION } from './command-contract.js';
import {
  CommandDispatcher,
  InMemoryCommandExecutionStore,
  PersistenceRequiredCommandExecutionStore,
} from './command-dispatcher.js';

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
        branchScope: { kind: 'all' },
      };
    },
  },
  authorization: new RoleMatrixAuthorizationPolicy({
    SAVE_TEST_ADVANCE: ['OWNER'],
    OTHER_COMMAND: ['OWNER'],
  }),
};

const command = (overrides = {}) => ({
  schemaVersion: COMMAND_ENVELOPE_VERSION,
  commandId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'command-key-1',
  commandType: 'SAVE_TEST_ADVANCE',
  aggregateId: 'save-1',
  expectedVersion: 1,
  payload: { label: 'open-day' },
  ...overrides,
});

const testDispatcher = () =>
  new CommandDispatcher(
    [
      {
        commandType: 'SAVE_TEST_ADVANCE',
        async execute({ currentVersion }) {
          return { aggregateVersion: currentVersion + 1, result: { accepted: true } };
        },
      },
    ],
    new InMemoryCommandExecutionStore(),
  );

function assertD02Error(
  response: Readonly<{ statusCode: number; json(): unknown }>,
  status: number,
  code: string,
  details?: Readonly<Record<string, number>>,
): void {
  assert.equal(response.statusCode, status);
  assert.deepEqual(response.json(), {
    error: {
      version: 'd02-command-error/v1',
      code,
      ...(details === undefined ? {} : { details }),
    },
  });
}

test('true Fastify inject covers 401, 409, 422, default legacy isolation, and persistence fail-closed', async () => {
  const defaultApp = createApiComposition();
  assertD02Error(
    await defaultApp.inject({
      method: 'POST',
      url: '/saves/save-1/actions/SAVE_TEST_ADVANCE',
      payload: command(),
    }),
    401,
    'UNTRUSTED_COMMAND_CONTEXT',
  );
  for (const url of [
    '/bootstrap',
    '/orders',
    '/orders/order-1/items',
    '/orders/order-1/payments',
    '/kds/tickets/order-1/start',
    '/kds/tickets/order-1/serve',
  ]) {
    assert.equal((await defaultApp.inject({ method: 'POST', url, payload: {} })).statusCode, 404);
  }
  await defaultApp.close();

  const explicitLegacyApp = createTestOnlyLegacyApiComposition({
    legacyCompatibility: { prisma: {} as LegacyCompatibilityDatabase },
  });
  assert.equal(
    (await explicitLegacyApp.inject({ method: 'POST', url: '/orders', payload: {} })).statusCode,
    400,
  );
  await explicitLegacyApp.close();

  const app = createApiComposition({
    commandDispatcher: testDispatcher(),
    identitySecurity,
    testOnlyBypassClosedBetaEligibility: true,
  });
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/saves/save-1/actions/SAVE_TEST_ADVANCE',
        headers: { authorization: 'Bearer local-test-token' },
        payload: command(),
      })
    ).statusCode,
    200,
  );
  assertD02Error(
    await app.inject({
      method: 'POST',
      url: '/saves/save-1/actions/SAVE_TEST_ADVANCE',
      headers: { authorization: 'Bearer local-test-token' },
      payload: command({ idempotencyKey: 'stale-key' }),
    }),
    409,
    'EXPECTED_VERSION_CONFLICT',
    { actualVersion: 2, expectedVersion: 1 },
  );
  assertD02Error(
    await app.inject({
      method: 'POST',
      url: '/saves/save-1/actions/SAVE_TEST_ADVANCE',
      headers: { authorization: 'Bearer local-test-token' },
      payload: command({ commandType: 'OTHER_COMMAND' }),
    }),
    422,
    'COMMAND_TARGET_MISMATCH',
  );
  await app.close();

  const unavailableApp = createApiComposition({
    commandDispatcher: new CommandDispatcher(
      [
        {
          commandType: 'SAVE_TEST_ADVANCE',
          async execute({ currentVersion }) {
            return { aggregateVersion: currentVersion + 1, result: { shouldNotRun: true } };
          },
        },
      ],
      new PersistenceRequiredCommandExecutionStore(),
    ),
    identitySecurity,
    testOnlyBypassClosedBetaEligibility: true,
  });
  assertD02Error(
    await unavailableApp.inject({
      method: 'POST',
      url: '/saves/save-1/actions/SAVE_TEST_ADVANCE',
      headers: { authorization: 'Bearer local-test-token' },
      payload: command(),
    }),
    503,
    'COMMAND_PERSISTENCE_REQUIRED',
  );
  await unavailableApp.close();
});
