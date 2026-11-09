import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createApiComposition } from '../app-composition.js';
import { RoleMatrixAuthorizationPolicy, type MembershipRole } from './authorization.js';
import { JwtVerificationError, type JwtVerifier } from './jwt-verifier.js';
import {
  type ActiveGameScope,
  HashedBotServiceCredentialVerifier,
  type IdentityScopeRepository,
  PrismaIdentityScopeRepository,
  type TrustedContextSecurityOptions,
} from './trusted-command-context.js';
import { COMMAND_ENVELOPE_VERSION } from '../commands/command-contract.js';
import {
  CommandDispatcher,
  InMemoryCommandExecutionStore,
  PersistenceRequiredCommandExecutionStore,
} from '../commands/command-dispatcher.js';

const command = {
  schemaVersion: COMMAND_ENVELOPE_VERSION,
  commandId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'identity-context-1',
  commandType: 'SAVE_TEST_ADVANCE',
  aggregateId: 'save-1',
  expectedVersion: 1,
  payload: {},
} as const;

class FakeRepository implements IdentityScopeRepository {
  playerExists = true;
  discordLinked = true;
  scope: ActiveGameScope | undefined = {
    playerId: 'player-1',
    membershipId: 'membership-1',
    tenantId: 'restaurant-1',
    saveId: 'save-1',
    role: 'OWNER',
    branchScope: { kind: 'all' },
  };
  botAudits: unknown[] = [];

  async findPlayerByClerkSubject(subject: string) {
    return this.playerExists && subject === 'clerk-user-1'
      ? { id: 'player-1', clerkUserId: subject }
      : undefined;
  }

  async findPlayerByDiscordId(discordUserId: string) {
    return this.discordLinked && discordUserId === 'discord-1'
      ? { id: 'player-1', clerkUserId: 'clerk-user-1' }
      : undefined;
  }

  async findActiveGameScope() {
    return this.scope;
  }
}

function dispatcher(persistent = true) {
  return new CommandDispatcher(
    [
      {
        commandType: 'SAVE_TEST_ADVANCE',
        async execute({ context, currentVersion }) {
          return {
            aggregateVersion: currentVersion + 1,
            result: {
              actorId: context.actorId,
              tenantId: context.tenantId,
              role: context.roles[0],
            },
          };
        },
      },
    ],
    persistent
      ? new InMemoryCommandExecutionStore()
      : new PersistenceRequiredCommandExecutionStore(),
  );
}

function security(
  repository: FakeRepository,
  options: Readonly<{ invalidJwt?: boolean; allowedRoles?: readonly MembershipRole[] }> = {},
): TrustedContextSecurityOptions {
  const jwtVerifier: JwtVerifier = {
    async verify() {
      if (options.invalidJwt) throw new JwtVerificationError('JWT_SIGNATURE_INVALID');
      return {
        subject: 'clerk-user-1',
        issuer: 'local-test',
        audience: ['econ-game-api'],
        authorizedParty: 'local-web',
        expiresAt: 2_000_000_000,
      };
    },
  };
  return {
    jwtVerifier,
    repository,
    authorization: new RoleMatrixAuthorizationPolicy({
      SAVE_TEST_ADVANCE: options.allowedRoles ?? ['OWNER'],
    }),
    botServiceCredentialVerifier: {
      async verify(credential) {
        return credential === 'local-bot-credential'
          ? { id: 'discord-bot', scopes: ['game:command'] }
          : undefined;
      },
    },
    botActorAuditSink: {
      async recordResolvedActor(input) {
        repository.botAudits.push(input);
      },
    },
  };
}

function request(
  authorization: string | undefined,
  overrides: Readonly<Record<string, string>> = {},
) {
  return {
    method: 'POST' as const,
    url: '/saves/save-1/actions/SAVE_TEST_ADVANCE',
    headers: {
      ...(authorization ? { authorization } : {}),
      ...overrides,
    },
    payload: command,
  };
}

function errorCode(response: Readonly<{ json(): unknown }>): string | undefined {
  return (response.json() as { error?: { code?: string } }).error?.code;
}

test('missing D04 configuration leaves health non-sensitive and protected routes fail closed', async () => {
  const app = createApiComposition();
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: 'ok' });
  const protectedResponse = await app.inject(request('Bearer unconfigured'));
  assert.equal(protectedResponse.statusCode, 401);
  assert.equal(errorCode(protectedResponse), 'UNTRUSTED_COMMAND_CONTEXT');
  await app.close();
});

test('missing JWT and missing server-side player fail with stable D02 401/403 envelopes', async () => {
  const repository = new FakeRepository();
  const app = createApiComposition({
    commandDispatcher: dispatcher(),
    identitySecurity: security(repository),
    testOnlyBypassClosedBetaEligibility: true,
  });
  const missing = await app.inject(request(undefined));
  assert.equal(missing.statusCode, 401);
  assert.equal(errorCode(missing), 'UNTRUSTED_COMMAND_CONTEXT');

  repository.playerExists = false;
  const absentPlayer = await app.inject(request('Bearer local-jwt'));
  assert.equal(absentPlayer.statusCode, 403);
  assert.equal(errorCode(absentPlayer), 'COMMAND_SCOPE_FORBIDDEN');
  await app.close();

  const invalidApp = createApiComposition({
    commandDispatcher: dispatcher(),
    identitySecurity: security(new FakeRepository(), { invalidJwt: true }),
    testOnlyBypassClosedBetaEligibility: true,
  });
  const invalid = await invalidApp.inject(request('Bearer tampered'));
  assert.equal(invalid.statusCode, 401);
  assert.equal(errorCode(invalid), 'UNTRUSTED_COMMAND_CONTEXT');
  await invalidApp.close();
});

test('cross-tenant/save, revoked membership, and insufficient persisted role deny', async () => {
  for (const scope of [
    undefined,
    {
      playerId: 'player-1',
      membershipId: 'membership-1',
      tenantId: 'restaurant-other',
      saveId: 'save-other',
      role: 'OWNER' as const,
      branchScope: { kind: 'all' as const },
    },
    {
      playerId: 'player-1',
      membershipId: 'membership-1',
      tenantId: 'restaurant-1',
      saveId: 'save-1',
      role: 'VIEWER' as const,
      branchScope: { kind: 'all' as const },
    },
  ]) {
    const repository = new FakeRepository();
    repository.scope = scope;
    const app = createApiComposition({
      commandDispatcher: dispatcher(),
      identitySecurity: security(repository),
      testOnlyBypassClosedBetaEligibility: true,
    });
    const response = await app.inject(request('Bearer local-jwt'));
    assert.equal(response.statusCode, 403);
    assert.equal(errorCode(response), 'COMMAND_SCOPE_FORBIDDEN');
    await app.close();
  }
});

test('trusted context uses persisted role and tenant, ignoring client context attempts', async () => {
  const repository = new FakeRepository();
  const app = createApiComposition({
    commandDispatcher: dispatcher(),
    identitySecurity: security(repository),
    testOnlyBypassClosedBetaEligibility: true,
  });
  const response = await app.inject({
    ...request('Bearer local-jwt'),
    payload: { ...command, payload: { actorId: 'attacker', roles: ['OWNER'] } },
  });
  assert.equal(response.statusCode, 422);
  assert.equal(errorCode(response), 'CLIENT_CONTEXT_FIELD_FORBIDDEN');

  const accepted = await app.inject(request('Bearer local-jwt'));
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual((accepted.json() as { result: unknown }).result, {
    actorId: 'player-1',
    tenantId: 'restaurant-1',
    role: 'OWNER',
  });
  await app.close();
});

test('bot credential still requires Discord link and resolves the same persisted game scope', async () => {
  const repository = new FakeRepository();
  repository.discordLinked = false;
  const identitySecurity = security(repository);
  const app = createApiComposition({
    commandDispatcher: dispatcher(),
    identitySecurity,
    testOnlyBypassClosedBetaEligibility: true,
  });
  const headers = {
    'x-discord-user-id': 'discord-1',
    'x-discord-interaction-id': 'interaction-1',
    'x-correlation-id': 'correlation-1',
  };
  const unlinked = await app.inject(request('Bot local-bot-credential', headers));
  assert.equal(unlinked.statusCode, 403);
  assert.equal(errorCode(unlinked), 'DISCORD_IDENTITY_LINK_REQUIRED');

  repository.discordLinked = true;
  const missingAuditApp = createApiComposition({
    commandDispatcher: dispatcher(),
    identitySecurity: { ...identitySecurity, botActorAuditSink: undefined },
    testOnlyBypassClosedBetaEligibility: true,
  });
  const missingAudit = await missingAuditApp.inject(request('Bot local-bot-credential', headers));
  assert.equal(missingAudit.statusCode, 503);
  assert.equal(errorCode(missingAudit), 'BOT_AUDIT_REQUIRED');
  await missingAuditApp.close();

  const linkedWithInteractionKey = await app.inject({
    ...request('Bot local-bot-credential', headers),
    payload: { ...command, idempotencyKey: 'interaction-1' },
  });
  assert.equal(linkedWithInteractionKey.statusCode, 200);
  assert.deepEqual((linkedWithInteractionKey.json() as { result: unknown }).result, {
    actorId: 'player-1',
    tenantId: 'restaurant-1',
    role: 'OWNER',
  });
  assert.deepEqual(repository.botAudits, [
    {
      servicePrincipalId: 'discord-bot',
      discordUserId: 'discord-1',
      interactionId: 'interaction-1',
      correlationId: 'correlation-1',
      commandType: 'SAVE_TEST_ADVANCE',
      playerId: 'player-1',
      membershipId: 'membership-1',
      tenantId: 'restaurant-1',
      saveId: 'save-1',
      role: 'OWNER',
    },
  ]);
  await app.close();
});

test('restricted branch membership denies missing/cross-branch commands before handler', async () => {
  for (const [payload, expectedStatus] of [
    [{}, 403],
    [{ branchId: 'branch-2' }, 403],
    [{ branchId: 'branch-1' }, 200],
  ] as const) {
    const repository = new FakeRepository();
    repository.scope = {
      ...repository.scope!,
      branchScope: { kind: 'restricted', branchIds: ['branch-1'] },
    };
    const app = createApiComposition({
      commandDispatcher: dispatcher(),
      identitySecurity: security(repository),
      testOnlyBypassClosedBetaEligibility: true,
    });
    const response = await app.inject({
      ...request('Bearer local-jwt'),
      payload: { ...command, payload },
    });
    assert.equal(response.statusCode, expectedStatus);
    if (expectedStatus === 403) assert.equal(errorCode(response), 'COMMAND_BRANCH_SCOPE_FORBIDDEN');
    await app.close();
  }
});

test('valid D04 context reaches the unchanged D02 persistence-required 503 boundary', async () => {
  const repository = new FakeRepository();
  const app = createApiComposition({
    commandDispatcher: dispatcher(false),
    identitySecurity: security(repository),
    testOnlyBypassClosedBetaEligibility: true,
  });
  const response = await app.inject(request('Bearer local-jwt'));
  assert.equal(response.statusCode, 503);
  assert.equal(errorCode(response), 'COMMAND_PERSISTENCE_REQUIRED');
  await app.close();
});

test('D01 repository adapter rejects retired saves/revoked membership and ignores JWT role claims', async () => {
  let retiredAt: Date | null = null;
  let membershipRevokedAt: Date | null = null;
  let linkRevokedAt: Date | null = null;
  const repository = new PrismaIdentityScopeRepository({
    player: {
      async findUnique() {
        return { id: 'player-1', clerkUserId: 'clerk-user-1' };
      },
    },
    identityLink: {
      async findUnique() {
        return {
          player: { id: 'player-1', clerkUserId: 'clerk-user-1' },
          revokedAt: linkRevokedAt,
        };
      },
    },
    competitiveSave: {
      async findUnique() {
        return { id: 'save-1', restaurantId: 'restaurant-1', retiredAt };
      },
    },
    restaurantMembership: {
      async findUnique() {
        return {
          id: 'membership-1',
          playerId: 'player-1',
          restaurantId: 'restaurant-1',
          role: 'KITCHEN',
          branchScope: ['branch-1'],
          revokedAt: membershipRevokedAt,
        };
      },
    },
  });
  assert.deepEqual(await repository.findActiveGameScope('player-1', 'save-1'), {
    playerId: 'player-1',
    membershipId: 'membership-1',
    tenantId: 'restaurant-1',
    saveId: 'save-1',
    role: 'KITCHEN',
    branchScope: { kind: 'restricted', branchIds: ['branch-1'] },
  });
  membershipRevokedAt = new Date();
  assert.equal(await repository.findActiveGameScope('player-1', 'save-1'), undefined);
  membershipRevokedAt = null;
  retiredAt = new Date();
  assert.equal(await repository.findActiveGameScope('player-1', 'save-1'), undefined);
  linkRevokedAt = new Date();
  assert.equal(await repository.findPlayerByDiscordId('discord-1'), undefined);
});

test('bot service verifier uses a scoped principal and constant-length digest comparison', async () => {
  const credential = 'local-bot-credential';
  const verifier = new HashedBotServiceCredentialVerifier(
    createHash('sha256').update(credential).digest('hex'),
    { id: 'bot-1', scopes: ['game:command'] },
  );
  assert.deepEqual(await verifier.verify(credential), {
    id: 'bot-1',
    scopes: ['game:command'],
  });
  assert.equal(await verifier.verify('wrong'), undefined);
});
