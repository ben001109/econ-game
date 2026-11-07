import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  sign,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createProductionApiComposition,
  productionIdentityConfigurationFromEnvironment,
  type ProductionApiDatabase,
} from '../production-api-composition.js';
import { COMMAND_ENVELOPE_VERSION } from '../commands/command-contract.js';
import { POST_LEDGER_TRANSACTION } from '../domains/ledger/ledger-command.js';

const issuer = 'https://clerk.security.test';
const jwksUrl = `${issuer}/.well-known/jwks.json`;
const audience = 'econ-game-api';
const authorizedParty = 'https://game.security.test';
const botCredential = 'test-only-bot-service-credential';
const botCredentialSha256 = createHash('sha256').update(botCredential, 'utf8').digest('hex');

function signer(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    kid,
    privateKey,
    jwk: { ...jwk, kid, alg: 'RS256', use: 'sig', key_ops: ['verify'] } satisfies JsonWebKey,
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function token(
  signingKey: Readonly<{ kid: string; privateKey: KeyObject }>,
  subject = 'clerk-user-1',
): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = encode({ alg: 'RS256', kid: signingKey.kid, typ: 'JWT' });
  const payload = encode({
    sub: subject,
    iss: issuer,
    aud: audience,
    azp: authorizedParty,
    iat: now - 10,
    nbf: now - 10,
    exp: now + 60,
  });
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`, 'ascii'),
    signingKey.privateKey,
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

type DatabaseState = {
  saveTenant: string;
  membership: 'active-owner' | 'active-viewer' | 'revoked' | 'missing';
  closedBetaEligible: boolean;
  discordLinked: boolean;
  wipeBatchScopeState?: 'allowed' | 'no-access' | 'frozen';
  botAuditRecords: unknown[];
  queryCalls: Array<Readonly<{ query: string; values: readonly unknown[] }>>;
  gameplayActiveSave?: boolean;
};

function durableDatabase(state: DatabaseState): ProductionApiDatabase {
  const database: ProductionApiDatabase = {
    player: {
      async findUnique() {
        return { id: 'player-1', clerkUserId: 'clerk-user-1' };
      },
    },
    identityLink: {
      async findUnique() {
        return state.discordLinked
          ? {
              revokedAt: null,
              player: { id: 'player-1', clerkUserId: 'clerk-user-1' },
            }
          : null;
      },
    },
    competitiveSave: {
      async findUnique() {
        return { id: 'save-1', restaurantId: state.saveTenant, retiredAt: null };
      },
    },
    restaurantMembership: {
      async findUnique(input: unknown) {
        const tenant = (
          input as {
            where?: { playerId_restaurantId?: { restaurantId?: string } };
          }
        ).where?.playerId_restaurantId?.restaurantId;
        if (tenant !== 'tenant-one' || state.membership === 'missing') return null;
        return {
          playerId: 'player-1',
          id: 'membership-1',
          restaurantId: 'tenant-one',
          role: state.membership === 'active-viewer' ? 'VIEWER' : 'OWNER',
          branchScope: null,
          revokedAt: state.membership === 'revoked' ? new Date() : null,
        };
      },
    },
    auditLog: {
      async create(input: unknown) {
        state.botAuditRecords.push(input);
        return input;
      },
    },
    async $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T> {
      state.queryCalls.push({ query, values });
      if (query.includes('FROM "Player"')) {
        return [{ id: 'player-1', clerkUserId: 'clerk-user-1' }] as T;
      }
      const wipeScopeState = state.wipeBatchScopeState ?? 'allowed';
      if (
        query.includes('SELECT save."id" FROM "CompetitiveSave" save') &&
        query.includes('JOIN "RestaurantMembership" membership') &&
        query.includes('membership."revokedAt" IS NULL') &&
        query.includes('FOR SHARE OF save, membership')
      ) {
        return wipeScopeState !== 'no-access' ? [{ id: 'save-1' }] as T : [] as T;
      }
      if (
        query.includes(
          'SELECT scope."saveId" AS "id" FROM "WipeBatchSaveScope" scope',
        )
      ) {
        return wipeScopeState === 'frozen' ? [{ id: values[1] as string }] as T : [] as T;
      }
      if (query.includes('d05_is_entrance_eligible')) {
        return [{ eligible: state.closedBetaEligible }] as T;
      }
      if (query.includes('/* gameplay-read:bootstrap-version */')) {
        return [] as T;
      }
      if (query.includes('/* gameplay-read:scoped-save */')) {
        return (state.gameplayActiveSave
          ? [
              {
                id: 'save-1',
                restaurantId: 'tenant-one',
                membershipId: 'membership-1',
                role: 'OWNER',
                version: 1,
                openingScenario: 'DEFAULT_SMALL_SHOP',
                operatingMode: 'STRATEGY',
                servicePeriodPlan: 'TWO_PERIODS',
                difficultyGroup: 'STANDARD',
                simulationRuleVersion: 'mvp-e01-v1',
              },
            ]
          : []) as T;
      }
      throw new Error('unexpected durable query');
    },
    async $executeRawUnsafe(query: string): Promise<number> {
      throw new Error(`unexpected durable execution: ${query.slice(0, 80)}`);
    },
    async $transaction<T>(
      operation: (transaction: {
        $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T>;
        $executeRawUnsafe(query: string, ...values: readonly unknown[]): Promise<number>;
      }) => Promise<T>,
      _options?: Readonly<{ isolationLevel: 'Serializable' }>,
    ): Promise<T> {
      return operation(database);
    },
  };
  return database;
}

function commandUrl(): string {
  return `/saves/save-1/actions/${POST_LEDGER_TRANSACTION}`;
}

function gameplayCommandUrl(commandType: string): string {
  return `/saves/save-1/actions/${commandType}`;
}

function gameplayEnvelope(commandType: string) {
  return {
    schemaVersion: COMMAND_ENVELOPE_VERSION,
    commandId: '33333333-3333-4333-8333-333333333333',
    idempotencyKey: 'production-gameplay-policy-test',
    commandType,
    aggregateId: 'save-1',
    expectedVersion: 1,
    payload: {},
  };
}

function errorCode(response: Readonly<{ json(): unknown }>): string | undefined {
  return (response.json() as { error?: { code?: string } }).error?.code;
}

test('runtime identity configuration is all-or-nothing and rejects ambiguous provider metadata', () => {
  assert.equal(productionIdentityConfigurationFromEnvironment({}), undefined);
  assert.equal(
    productionIdentityConfigurationFromEnvironment({
      CLERK_ISSUER: issuer,
      CLERK_JWKS_URL: jwksUrl,
      CLERK_AUDIENCES: audience,
    }),
    undefined,
  );
  assert.equal(
    productionIdentityConfigurationFromEnvironment({
      CLERK_ISSUER: issuer,
      CLERK_JWKS_URL: 'https://attacker.security.test/jwks.json',
      CLERK_AUDIENCES: audience,
      CLERK_AUTHORIZED_PARTIES: authorizedParty,
    }),
    undefined,
  );
  assert.deepEqual(
    productionIdentityConfigurationFromEnvironment({
      CLERK_ISSUER: issuer,
      CLERK_JWKS_URL: jwksUrl,
      CLERK_AUDIENCES: ` ${audience},econ-game-worker `,
      CLERK_AUTHORIZED_PARTIES: ` ${authorizedParty} `,
    }),
    {
      issuer,
      jwksUrl,
      audiences: [audience, 'econ-game-worker'],
      authorizedParties: [authorizedParty],
    },
  );
});

test('complete production composition jointly exposes no-save discovery and durable bootstrap POST', async () => {
  const signingKey = signer('production-bootstrap-read-key');
  const state: DatabaseState = {
    saveTenant: 'tenant-one',
    membership: 'active-owner',
    closedBetaEligible: true,
    discordLinked: true,
    botAuditRecords: [],
    queryCalls: [],
    gameplayActiveSave: false,
  };
  const calls: unknown[] = [];
  const app = createProductionApiComposition({
    database: durableDatabase(state),
    identityConfiguration: {
      issuer,
      jwksUrl,
      audiences: [audience],
      authorizedParties: [authorizedParty],
    },
    bootstrapInitializer: {
      durability: 'durable',
      async initialize(input) {
        calls.push(input);
        return {
          commandId: input.commandId,
          aggregateVersion: 1,
          result: {
            saveId: 'save-created-server-side',
            provisionedRestaurantId: 'restaurant-created-server-side',
          },
        };
      },
    },
    loadJwks: async () => ({ keys: [signingKey.jwk] }),
  });
  const authorization = `Bearer ${token(signingKey)}`;
  const discovery = await app.inject({
    method: 'GET',
    url: '/gameplay/active-save',
    headers: { authorization },
  });
  assert.equal(discovery.statusCode, 200);
  assert.deepEqual(discovery.json(), {
    schemaVersion: 'gameplay.active-save-discovery/v1',
    state: 'INITIALIZE_REQUIRED',
    bootstrap: {
      route: '/bootstrap/actions/INITIALIZE_COMPETITIVE_SAVE',
      aggregateId: 'bootstrap-player:player-1',
      expectedVersion: 0,
    },
    activeSave: null,
  });

  const commandId = '44444444-4444-4444-8444-444444444444';
  const initialized = await app.inject({
    method: 'POST',
    url: '/bootstrap/actions/INITIALIZE_COMPETITIVE_SAVE',
    headers: { authorization },
    payload: {
      schemaVersion: 'd02-bootstrap-command/v1',
      commandId,
      idempotencyKey: 'production-bootstrap-1',
      commandType: 'INITIALIZE_COMPETITIVE_SAVE',
      expectedVersion: 0,
      payload: {
        scenario: 'DEFAULT_SMALL_SHOP',
        operatingMode: 'STRATEGY',
        settlementCurrency: 'TWD',
        servicePeriodPlan: 'TWO_PERIODS',
      },
    },
  });
  assert.equal(initialized.statusCode, 200);
  assert.equal((initialized.json() as { aggregateVersion: number }).aggregateVersion, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    (calls[0] as { actorPlayerId: string; aggregateScope: string; expectedVersion: number }),
    {
      actorPlayerId: 'player-1',
      aggregateScope: 'bootstrap-player:player-1',
      commandId,
      idempotencyKey: 'production-bootstrap-1',
      expectedVersion: 0,
      requestFingerprint: (calls[0] as { requestFingerprint: string }).requestFingerprint,
      intent: {
        scenario: 'DEFAULT_SMALL_SHOP',
        operatingMode: 'STRATEGY',
        settlementCurrency: 'TWD',
        servicePeriodPlan: 'TWO_PERIODS',
      },
    },
  );
  assert.match((calls[0] as { requestFingerprint: string }).requestFingerprint, /^[0-9a-f]{64}$/);

  const rejectedEmptyPremises = await app.inject({
    method: 'POST',
    url: '/bootstrap/actions/INITIALIZE_COMPETITIVE_SAVE',
    headers: { authorization },
    payload: {
      schemaVersion: 'd02-bootstrap-command/v1',
      commandId: '55555555-5555-4555-8555-555555555555',
      idempotencyKey: 'production-bootstrap-empty-premises',
      commandType: 'INITIALIZE_COMPETITIVE_SAVE',
      expectedVersion: 1,
      payload: {
        scenario: 'EMPTY_PREMISES',
        operatingMode: 'STRATEGY',
        settlementCurrency: 'TWD',
        servicePeriodPlan: 'TWO_PERIODS',
      },
    },
  });
  assert.equal(rejectedEmptyPremises.statusCode, 422);
  assert.equal(errorCode(rejectedEmptyPremises), 'INITIALIZE_COMPETITIVE_SAVE_INTENT_INVALID');
  assert.equal(calls.length, 1);
  await app.close();

  const compositionSource = readFileSync(
    new URL('../production-api-composition.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    compositionSource,
    /new PrismaDurableBootstrapInitializer\(\s*options\.database,\s*createMvpServerBootstrapPlan,\s*assertMvpBootstrapIntent,\s*\)/,
  );
  assert.match(compositionSource, /guardMvpBootstrapInitializer\(\s*options\.bootstrapInitializer/);
});

test('default production surface has no direct legacy reads or mutations and leaks no database data', async () => {
  const state: DatabaseState = {
    saveTenant: 'tenant-one',
    membership: 'active-owner',
    closedBetaEligible: true,
    discordLinked: true,
    botAuditRecords: [],
    queryCalls: [],
  };
  const app = createProductionApiComposition({ database: durableDatabase(state) });

  const legacyRequests = [
    { method: 'GET' as const, url: '/restaurants' },
    { method: 'GET' as const, url: '/menus' },
    { method: 'GET' as const, url: '/orders/order-secret' },
    { method: 'GET' as const, url: '/kds/tickets' },
    { method: 'POST' as const, url: '/bootstrap', payload: {} },
    { method: 'POST' as const, url: '/orders', payload: {} },
    { method: 'POST' as const, url: '/orders/order-secret/items', payload: {} },
    { method: 'POST' as const, url: '/orders/order-secret/payments', payload: {} },
    { method: 'POST' as const, url: '/kds/tickets/order-secret/start', payload: {} },
    { method: 'POST' as const, url: '/kds/tickets/order-secret/serve', payload: {} },
  ];
  for (const request of legacyRequests) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 404, `${request.method} ${request.url}`);
  }

  const anonymousCommand = await app.inject({ method: 'POST', url: commandUrl(), payload: {} });
  assert.equal(anonymousCommand.statusCode, 401);
  assert.equal(errorCode(anonymousCommand), 'UNTRUSTED_COMMAND_CONTEXT');
  const closedBetaUnavailable = await app.inject({
    method: 'GET',
    url: '/closed-beta/tenants/tenant-one/eligibility',
    headers: { authorization: 'Bearer attacker-token' },
  });
  assert.equal(closedBetaUnavailable.statusCode, 503);
  assert.equal(errorCode(closedBetaUnavailable), 'CLOSED_BETA_NOT_CONFIGURED');
  assert.equal(closedBetaUnavailable.body.includes('attacker-token'), false);
  assert.equal(state.queryCalls.length, 0);
  await app.close();

  const entrypoint = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(entrypoint, /app\.get\(['"]\/(?:restaurants|menus|orders|kds\/tickets)/);
  assert.doesNotMatch(entrypoint, /registerLegacyCompatibilityRoutes|findMany\s*\(/);
});

test('production Fastify path rejects oversized and over-deep JSON before database mutation', async () => {
  const state: DatabaseState = {
    saveTenant: 'tenant-one',
    membership: 'active-owner',
    closedBetaEligible: true,
    discordLinked: true,
    botAuditRecords: [],
    queryCalls: [],
  };
  const app = createProductionApiComposition({ database: durableDatabase(state) });
  const oversized = await app.inject({
    method: 'POST',
    url: commandUrl(),
    payload: { padding: 'x'.repeat(70 * 1024) },
  });
  assert.equal(oversized.statusCode, 413);
  assert.deepEqual(oversized.json(), {
    error: {
      version: 'b2-request-limit-error/v1',
      code: 'REQUEST_BODY_RESOURCE_LIMIT_EXCEEDED',
      details: { limit: 'BODY_BYTES' },
    },
  });

  let nested: Record<string, unknown> = { value: true };
  for (let depth = 0; depth < 40; depth += 1) nested = { nested };
  const tooDeep = await app.inject({ method: 'POST', url: commandUrl(), payload: nested });
  assert.equal(tooDeep.statusCode, 413);
  assert.deepEqual(tooDeep.json(), {
    error: {
      version: 'b2-request-limit-error/v1',
      code: 'REQUEST_BODY_RESOURCE_LIMIT_EXCEEDED',
      details: { limit: 'DEPTH' },
    },
  });
  assert.equal(state.queryCalls.length, 0);
  assert.equal(state.botAuditRecords.length, 0);
  await app.close();
});

test('configured production composition denies anonymous, cross-tenant, role, membership, and closed-beta refusal', async () => {
  const signingKey = signer('production-test-key');
  const state: DatabaseState = {
    saveTenant: 'tenant-one',
    membership: 'active-owner',
    wipeBatchScopeState: 'allowed',
    closedBetaEligible: false,
    discordLinked: true,
    botAuditRecords: [],
    queryCalls: [],
  };
  const app = createProductionApiComposition({
    database: durableDatabase(state),
    identityConfiguration: {
      issuer,
      jwksUrl,
      audiences: [audience],
      authorizedParties: [authorizedParty],
    },
    loadJwks: async (url) => {
      assert.equal(url, jwksUrl);
      return { keys: [signingKey.jwk] };
    },
  });
  const authorization = `Bearer ${token(signingKey)}`;

  const anonymous = await app.inject({ method: 'POST', url: commandUrl(), payload: {} });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(errorCode(anonymous), 'UNTRUSTED_COMMAND_CONTEXT');

  state.saveTenant = 'tenant-other';
  const crossTenant = await app.inject({
    method: 'POST',
    url: commandUrl(),
    headers: { authorization },
    payload: {},
  });
  assert.equal(crossTenant.statusCode, 403);
  assert.equal(errorCode(crossTenant), 'COMMAND_SCOPE_FORBIDDEN');

  state.saveTenant = 'tenant-one';
  state.membership = 'active-viewer';
  const insufficientRole = await app.inject({
    method: 'POST',
    url: commandUrl(),
    headers: { authorization },
    payload: {},
  });
  assert.equal(insufficientRole.statusCode, 403);
  assert.equal(errorCode(insufficientRole), 'COMMAND_SCOPE_FORBIDDEN');

  state.membership = 'revoked';
  const revokedMembership = await app.inject({
    method: 'POST',
    url: commandUrl(),
    headers: { authorization },
    payload: {},
  });
  assert.equal(revokedMembership.statusCode, 403);
  assert.equal(errorCode(revokedMembership), 'COMMAND_SCOPE_FORBIDDEN');

  state.membership = 'active-owner';
  const refusedByClosedBeta = await app.inject({
    method: 'POST',
    url: commandUrl(),
    headers: { authorization },
    payload: {},
  });
  assert.equal(refusedByClosedBeta.statusCode, 403);
  assert.equal(errorCode(refusedByClosedBeta), 'CLOSED_BETA_NOT_ELIGIBLE');

  const eligibility = await app.inject({
    method: 'GET',
    url: '/closed-beta/tenants/tenant-one/eligibility',
    headers: { authorization },
  });
  assert.equal(eligibility.statusCode, 200);
  assert.deepEqual(eligibility.json(), { eligible: false });
  const gateQueries = state.queryCalls.filter((call) =>
    call.query.includes('d05_is_entrance_eligible'),
  );
  assert.equal(gateQueries.length, 2);
  assert.deepEqual(gateQueries[0]?.values.slice(0, 2), ['player-1', 'tenant-one']);
  await app.close();
});

test('production composition command path applies wipe-scope states correctly', async () => {
  const signingKey = signer('production-wipe-guard-key');
  const state: DatabaseState = {
    saveTenant: 'tenant-one',
    membership: 'active-owner',
    wipeBatchScopeState: 'allowed',
    closedBetaEligible: true,
    discordLinked: true,
    botAuditRecords: [],
    queryCalls: [],
  };
  const app = createProductionApiComposition({
    database: durableDatabase(state),
    identityConfiguration: {
      issuer,
      jwksUrl,
      audiences: [audience],
      authorizedParties: [authorizedParty],
    },
    loadJwks: async (url) => {
      assert.equal(url, jwksUrl);
      return { keys: [signingKey.jwk] };
    },
  });
  const authorization = `Bearer ${token(signingKey)}`;

  const accessQuery = 'SELECT save."id" FROM "CompetitiveSave" save';
  const frozenScopeQuery = 'SELECT scope."saveId" AS "id" FROM "WipeBatchSaveScope" scope';

  const allowedCommand = await app.inject({ method: 'POST', url: commandUrl(), headers: { authorization }, payload: {} });
  assert.equal(allowedCommand.statusCode, 422);
  assert.equal(errorCode(allowedCommand), 'COMMAND_ENVELOPE_INVALID');
  assert.equal(
    state.queryCalls.some((call) => call.query.includes(accessQuery)),
    true,
  );

  state.wipeBatchScopeState = 'no-access';
  const noAccessCommand = await app.inject({
    method: 'POST',
    url: commandUrl(),
    headers: { authorization },
    payload: {},
  });
  assert.equal(noAccessCommand.statusCode, 403);
  assert.equal(errorCode(noAccessCommand), 'WIPE_SCOPE_FORBIDDEN');

  state.wipeBatchScopeState = 'frozen';
  const frozenCommand = await app.inject({
    method: 'POST',
    url: commandUrl(),
    headers: { authorization },
    payload: {},
  });
  assert.equal(frozenCommand.statusCode, 409);
  assert.equal(errorCode(frozenCommand), 'WIPE_SCOPE_FROZEN');
  assert.equal(
    state.queryCalls.some((call) => call.query.includes(frozenScopeQuery)),
    true,
  );
  await app.close();
});

test('production policy authorizes a known save-scoped gameplay command before its absent handler fails closed', async () => {
  const signingKey = signer('production-gameplay-policy-key');
  const state: DatabaseState = {
    saveTenant: 'tenant-one',
    membership: 'active-owner',
    wipeBatchScopeState: 'allowed',
    closedBetaEligible: true,
    discordLinked: true,
    botAuditRecords: [],
    queryCalls: [],
  };
  const app = createProductionApiComposition({
    database: durableDatabase(state),
    identityConfiguration: {
      issuer,
      jwksUrl,
      audiences: [audience],
      authorizedParties: [authorizedParty],
    },
    loadJwks: async () => ({ keys: [signingKey.jwk] }),
  });

  const response = await app.inject({
    method: 'POST',
    url: gameplayCommandUrl('CONFIGURE_PREOPEN_DAY'),
    headers: { authorization: `Bearer ${token(signingKey)}` },
    payload: gameplayEnvelope('CONFIGURE_PREOPEN_DAY'),
  });

  assert.equal(response.statusCode, 422);
  assert.equal(errorCode(response), 'UNKNOWN_COMMAND');
  assert.equal(
    state.queryCalls.some((call) => call.query.includes('INSERT INTO "IdempotencyRecord"')),
    false,
  );
  await app.close();
});

test('production Bot composition is all-or-nothing, uses only server-owned scopes, and audits linked actors', async () => {
  const signingKey = signer('production-bot-test-key');
  const state: DatabaseState = {
    saveTenant: 'tenant-one',
    membership: 'active-owner',
    closedBetaEligible: true,
    discordLinked: true,
    botAuditRecords: [],
    queryCalls: [],
  };
  const identityConfiguration = productionIdentityConfigurationFromEnvironment({
    CLERK_ISSUER: issuer,
    CLERK_JWKS_URL: jwksUrl,
    CLERK_AUDIENCES: audience,
    CLERK_AUTHORIZED_PARTIES: authorizedParty,
    BOT_SERVICE_CREDENTIAL_SHA256: botCredentialSha256,
    BOT_SERVICE_PRINCIPAL_ID: 'discord-bot-primary',
    BOT_SERVICE_SCOPES: 'game:command',
  });
  assert.ok(identityConfiguration);
  const app = createProductionApiComposition({
    database: durableDatabase(state),
    identityConfiguration,
    loadJwks: async () => ({ keys: [signingKey.jwk] }),
  });
  const botHeaders = {
    authorization: `Bot ${botCredential}`,
    'x-correlation-id': 'interaction-1',
    'x-discord-interaction-id': 'interaction-1',
    'x-discord-user-id': 'discord-user-1',
    // Request-supplied scopes are deliberately ignored by the trusted resolver.
    'x-bot-scopes': 'owner,game:command,admin',
  };

  const valid = await app.inject({
    method: 'POST',
    url: commandUrl(),
    headers: botHeaders,
    payload: {},
  });
  assert.equal(valid.statusCode, 422);
  assert.equal(errorCode(valid), 'COMMAND_ENVELOPE_INVALID');
  assert.deepEqual(state.botAuditRecords, [
    {
      data: {
        restaurantId: 'tenant-one',
        actorPlayerId: 'player-1',
        actorType: 'discord_bot',
        action: 'discord_command_actor_resolved',
        targetType: 'CompetitiveSave',
        targetId: 'save-1',
        correlationId: 'interaction-1',
        metadata: {
          servicePrincipalId: 'discord-bot-primary',
          discordUserId: 'discord-user-1',
          interactionId: 'interaction-1',
          membershipId: 'membership-1',
          commandType: POST_LEDGER_TRANSACTION,
          role: 'OWNER',
        },
      },
    },
  ]);

  const invalidCredential = await app.inject({
    method: 'POST',
    url: commandUrl(),
    headers: { ...botHeaders, authorization: 'Bot wrong-credential' },
    payload: {},
  });
  assert.equal(invalidCredential.statusCode, 401);
  assert.equal(errorCode(invalidCredential), 'UNTRUSTED_COMMAND_CONTEXT');

  const missingHeaders = await app.inject({
    method: 'POST',
    url: commandUrl(),
    headers: { authorization: `Bot ${botCredential}` },
    payload: {},
  });
  assert.equal(missingHeaders.statusCode, 401);
  assert.equal(errorCode(missingHeaders), 'UNTRUSTED_COMMAND_CONTEXT');

  state.discordLinked = false;
  const unlinkedIdentity = await app.inject({
    method: 'POST',
    url: commandUrl(),
    headers: botHeaders,
    payload: {},
  });
  assert.equal(unlinkedIdentity.statusCode, 403);
  assert.equal(errorCode(unlinkedIdentity), 'DISCORD_IDENTITY_LINK_REQUIRED');
  assert.equal(state.botAuditRecords.length, 1);
  await app.close();

  const incompleteConfiguration = productionIdentityConfigurationFromEnvironment({
    CLERK_ISSUER: issuer,
    CLERK_JWKS_URL: jwksUrl,
    CLERK_AUDIENCES: audience,
    CLERK_AUTHORIZED_PARTIES: authorizedParty,
    BOT_SERVICE_CREDENTIAL_SHA256: botCredentialSha256,
    BOT_SERVICE_PRINCIPAL_ID: 'discord-bot-primary',
  });
  assert.ok(incompleteConfiguration);
  const noFallbackApp = createProductionApiComposition({
    database: durableDatabase({ ...state, discordLinked: true, botAuditRecords: [] }),
    identityConfiguration: incompleteConfiguration,
    loadJwks: async () => ({ keys: [signingKey.jwk] }),
  });
  const missingBotConfiguration = await noFallbackApp.inject({
    method: 'POST',
    url: commandUrl(),
    headers: botHeaders,
    payload: {},
  });
  assert.equal(missingBotConfiguration.statusCode, 401);
  assert.equal(errorCode(missingBotConfiguration), 'UNTRUSTED_COMMAND_CONTEXT');
  await noFallbackApp.close();
});
