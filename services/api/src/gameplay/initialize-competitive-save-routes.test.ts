import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiComposition } from '../app-composition.js';
import { CommandError } from '../commands/command-contract.js';
import {
  BOOTSTRAP_COMMAND_ENVELOPE_VERSION,
  INITIALIZE_COMPETITIVE_SAVE_ROUTE,
  type BootstrapWebIdentityResolver,
  type TestBootstrapInitializer,
} from './initialize-competitive-save-routes.js';
import { INITIALIZE_COMPETITIVE_SAVE, type JsonValue } from './initialize-competitive-save.js';

const FIRST_COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const REPLAY_COMMAND_ID = '22222222-2222-4222-8222-222222222222';

const envelope = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  schemaVersion: BOOTSTRAP_COMMAND_ENVELOPE_VERSION,
  commandId: FIRST_COMMAND_ID,
  idempotencyKey: 'bootstrap-key-1',
  commandType: INITIALIZE_COMPETITIVE_SAVE,
  expectedVersion: 0,
  payload: {
    scenario: 'closed-beta-opening',
    operatingMode: 'table-service',
    settlementCurrency: 'TWD',
    servicePeriodPlan: 'lunch-dinner',
  },
  ...overrides,
});

type InitializerInput = Parameters<TestBootstrapInitializer['initialize']>[0];
type InitializerOutput = Awaited<ReturnType<TestBootstrapInitializer['initialize']>>;
type BootstrapInitializeRequest = ReturnType<typeof envelope>;

class FakeDurableBootstrapProtocol implements TestBootstrapInitializer {
  readonly durability = 'test' as const;
  readonly calls: InitializerInput[] = [];
  private readonly outcomes = new Map<
    string,
    Readonly<{ fingerprint: string; output: InitializerOutput }>
  >();
  private readonly versions = new Map<string, number>();

  async initialize(input: InitializerInput): Promise<InitializerOutput> {
    this.calls.push(input);
    if (input.actorPlayerId === 'player-not-qualified') {
      throw new CommandError(403, 'INITIALIZE_COMPETITIVE_SAVE_FORBIDDEN');
    }
    const idempotencyScope = `${input.actorPlayerId}:${input.idempotencyKey}`;
    const previous = this.outcomes.get(idempotencyScope);
    if (previous) {
      if (previous.fingerprint !== input.requestFingerprint) {
        throw new CommandError(409, 'IDEMPOTENCY_KEY_REUSED');
      }
      return previous.output;
    }
    const currentVersion = this.versions.get(input.aggregateScope) ?? 0;
    if (input.expectedVersion !== currentVersion) {
      throw new CommandError(409, 'EXPECTED_VERSION_CONFLICT', {
        actualVersion: currentVersion,
        expectedVersion: input.expectedVersion,
      });
    }
    const aggregateVersion = currentVersion + 1;
    const result: JsonValue = Object.freeze({
      authorityId: 'authority-server-derived',
      provisionedRestaurantId: 'restaurant-server-derived',
      ownerMembershipId: 'membership-server-derived',
      saveId: 'save-server-derived',
      mode: 'COMPETITIVE',
    });
    const output = Object.freeze({ commandId: input.commandId, aggregateVersion, result });
    this.versions.set(input.aggregateScope, aggregateVersion);
    this.outcomes.set(
      idempotencyScope,
      Object.freeze({ fingerprint: input.requestFingerprint, output }),
    );
    return output;
  }
}

function identityResolver(calls: string[]): BootstrapWebIdentityResolver {
  return async (token) => {
    calls.push(token);
    if (token === 'qualified-web') return { playerId: 'player-1' };
    if (token === 'unqualified-web') return { playerId: 'player-not-qualified' };
    return undefined;
  };
}

function assertD02Error(
  response: Readonly<{ statusCode: number; json(): unknown }>,
  status: number,
  code: string,
): void {
  assert.equal(response.statusCode, status);
  assert.deepEqual(response.json(), {
    error: { version: 'd02-command-error/v1', code },
  });
}

test('qualified Web bootstrap derives the Player scope and all target authority server-side', async () => {
  const initializer = new FakeDurableBootstrapProtocol();
  const resolverCalls: string[] = [];
  const app = createApiComposition({
    testOnlyBootstrapInitializer: initializer,
    testOnlyBootstrapWebIdentityResolver: identityResolver(resolverCalls),
  });

  const response = await app.inject({
    method: 'POST',
    url: INITIALIZE_COMPETITIVE_SAVE_ROUTE,
    headers: { authorization: 'Bearer qualified-web' },
    payload: envelope(),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    commandId: FIRST_COMMAND_ID,
    idempotencyKey: 'bootstrap-key-1',
    commandType: INITIALIZE_COMPETITIVE_SAVE,
    aggregateId: 'bootstrap-player:player-1',
    aggregateVersion: 1,
    result: {
      authorityId: 'authority-server-derived',
      provisionedRestaurantId: 'restaurant-server-derived',
      ownerMembershipId: 'membership-server-derived',
      saveId: 'save-server-derived',
      mode: 'COMPETITIVE',
    },
  });
  assert.deepEqual(resolverCalls, ['qualified-web']);
  assert.equal(initializer.calls.length, 1);
  assert.equal(initializer.calls[0]?.actorPlayerId, 'player-1');
  assert.equal(initializer.calls[0]?.aggregateScope, 'bootstrap-player:player-1');
  assert.equal(initializer.calls[0]?.expectedVersion, 0);
  assert.deepEqual(Object.keys(initializer.calls[0] ?? {}).sort(), [
    'actorPlayerId',
    'aggregateScope',
    'commandId',
    'expectedVersion',
    'idempotencyKey',
    'intent',
    'requestFingerprint',
  ]);
  await app.close();
});

test('missing, Bot, unmapped, and nonqualifying principals fail closed without existence detail', async () => {
  const initializer = new FakeDurableBootstrapProtocol();
  const resolverCalls: string[] = [];
  const app = createApiComposition({
    testOnlyBootstrapInitializer: initializer,
    testOnlyBootstrapWebIdentityResolver: identityResolver(resolverCalls),
  });

  assertD02Error(
    await app.inject({
      method: 'POST',
      url: INITIALIZE_COMPETITIVE_SAVE_ROUTE,
      payload: envelope(),
    }),
    401,
    'UNTRUSTED_COMMAND_CONTEXT',
  );
  assertD02Error(
    await app.inject({
      method: 'POST',
      url: INITIALIZE_COMPETITIVE_SAVE_ROUTE,
      headers: { authorization: 'Bot discord-service-credential' },
      payload: envelope(),
    }),
    401,
    'UNTRUSTED_COMMAND_CONTEXT',
  );
  assert.equal(resolverCalls.length, 0, 'Bot and missing identity must fail before lookup');
  assert.equal(initializer.calls.length, 0);

  assertD02Error(
    await app.inject({
      method: 'POST',
      url: INITIALIZE_COMPETITIVE_SAVE_ROUTE,
      headers: { authorization: 'Bearer unmapped-web' },
      payload: envelope(),
    }),
    403,
    'INITIALIZE_COMPETITIVE_SAVE_FORBIDDEN',
  );
  assertD02Error(
    await app.inject({
      method: 'POST',
      url: INITIALIZE_COMPETITIVE_SAVE_ROUTE,
      headers: { authorization: 'Bearer unqualified-web' },
      payload: envelope(),
    }),
    403,
    'INITIALIZE_COMPETITIVE_SAVE_FORBIDDEN',
  );
  assert.equal(initializer.calls.length, 1);
  await app.close();
});

test('client targets are rejected and cannot reach persistence', async () => {
  const initializer = new FakeDurableBootstrapProtocol();
  const app = createApiComposition({
    testOnlyBootstrapInitializer: initializer,
    testOnlyBootstrapWebIdentityResolver: identityResolver([]),
  });

  for (const payload of [
    envelope({ aggregateId: 'bootstrap-player:attacker' }),
    envelope({ saveId: 'attacker-save' }),
    envelope({
      payload: {
        scenario: 'closed-beta-opening',
        operatingMode: 'table-service',
        settlementCurrency: 'TWD',
        servicePeriodPlan: 'lunch-dinner',
        playerId: 'attacker',
      },
    }),
  ]) {
    assertD02Error(
      await app.inject({
        method: 'POST',
        url: INITIALIZE_COMPETITIVE_SAVE_ROUTE,
        headers: { authorization: 'Bearer qualified-web' },
        payload,
      }),
      422,
      'COMMAND_ENVELOPE_INVALID',
    );
  }
  assert.equal(initializer.calls.length, 0);
  await app.close();
});

test('Player-scoped version and idempotency semantics are stable across injection retries', async () => {
  const initializer = new FakeDurableBootstrapProtocol();
  const app = createApiComposition({
    testOnlyBootstrapInitializer: initializer,
    testOnlyBootstrapWebIdentityResolver: identityResolver([]),
  });
  const inject = (payload: BootstrapInitializeRequest) =>
    app.inject({
      method: 'POST',
      url: INITIALIZE_COMPETITIVE_SAVE_ROUTE,
      headers: { authorization: 'Bearer qualified-web' },
      payload,
    });

  const first = await inject(envelope());
  const replay = await inject(envelope({ commandId: REPLAY_COMMAND_ID }));
  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), first.json(), 'replay returns the original persisted outcome');

  assertD02Error(
    await inject(
      envelope({
        commandId: REPLAY_COMMAND_ID,
        payload: {
          scenario: 'changed-request',
          operatingMode: 'table-service',
          settlementCurrency: 'TWD',
          servicePeriodPlan: 'lunch-dinner',
        },
      }),
    ),
    409,
    'IDEMPOTENCY_KEY_REUSED',
  );
  const stale = await inject(
    envelope({ commandId: REPLAY_COMMAND_ID, idempotencyKey: 'bootstrap-key-stale' }),
  );
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.json(), {
    error: {
      version: 'd02-command-error/v1',
      code: 'EXPECTED_VERSION_CONFLICT',
      details: { actualVersion: 1, expectedVersion: 0 },
    },
  });
  await app.close();
});

test('default composition leaves bootstrap unregistered and existing save D02 route unchanged', async () => {
  const app = createApiComposition();
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: INITIALIZE_COMPETITIVE_SAVE_ROUTE,
        headers: { authorization: 'Bearer qualified-web' },
        payload: envelope(),
      })
    ).statusCode,
    404,
  );
  assertD02Error(
    await app.inject({
      method: 'POST',
      url: '/saves/save-1/actions/SAVE_TEST_ADVANCE',
      payload: {},
    }),
    401,
    'UNTRUSTED_COMMAND_CONTEXT',
  );
  await app.close();

  assert.throws(
    () =>
      createApiComposition({
        testOnlyBootstrapInitializer: new FakeDurableBootstrapProtocol(),
      }),
    /must be configured together/,
  );
});
