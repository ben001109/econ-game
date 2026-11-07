import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiComposition } from '../app-composition.js';
import {
  DiscordIdentityLinkService,
  IdentityLinkError,
  InMemoryDiscordIdentityRepository,
  PrismaDurableDiscordIdentityRepository,
  type AtomicLinkResult,
  type DiscordIdentityRepository,
  type StoredDiscordLinkChallenge,
} from './discord-identity-link.js';
import type { JwtVerifier, VerifiedJwtIdentity } from '../auth/jwt-verifier.js';

const player = { id: 'player-1', clerkUserId: 'clerk-user-1' } as const;
const otherPlayer = { id: 'player-2', clerkUserId: 'clerk-user-2' } as const;
const verifiedIdentity: VerifiedJwtIdentity = {
  subject: player.clerkUserId,
  issuer: 'local-test',
  audience: ['econ-game-api'],
  authorizedParty: 'local-web',
  expiresAt: 2_000_000_000,
};

class DurableTestRepository implements DiscordIdentityRepository {
  readonly durability = 'durable' as const;
  constructor(readonly memory = new InMemoryDiscordIdentityRepository([player, otherPlayer])) {}
  createChallenge(challenge: StoredDiscordLinkChallenge) {
    return this.memory.createChallenge(challenge);
  }
  findPlayerByClerkSubject(subject: string) {
    return this.memory.findPlayerByClerkSubject(subject);
  }
  consumeAndActivateLink(
    input: Parameters<DiscordIdentityRepository['consumeAndActivateLink']>[0],
  ) {
    return this.memory.consumeAndActivateLink(input);
  }
  revokeDiscordLink(input: Parameters<DiscordIdentityRepository['revokeDiscordLink']>[0]) {
    return this.memory.revokeDiscordLink(input);
  }
}

function service(
  options: Readonly<{
    nowMs?: number;
    repository?: DiscordIdentityRepository;
    subject?: string;
  }> = {},
) {
  const repository =
    options.repository ?? new InMemoryDiscordIdentityRepository([player, otherPlayer]);
  let nowMs = options.nowMs ?? 1_800_000_000_000;
  let id = 0;
  const jwtVerifier: JwtVerifier = {
    async verify() {
      return { ...verifiedIdentity, subject: options.subject ?? verifiedIdentity.subject };
    },
  };
  return {
    repository,
    advance(milliseconds: number) {
      nowMs += milliseconds;
    },
    value: new DiscordIdentityLinkService({
      jwtVerifier,
      botCredentialVerifier: {
        async verify(credential) {
          return credential === 'bot-link-credential'
            ? { id: 'discord-bot', scopes: ['identity:link'] }
            : undefined;
        },
      },
      oauthProofVerifier: {
        async verify(proof) {
          return proof.startsWith('oauth:')
            ? { discordUserId: proof.slice('oauth:'.length) }
            : undefined;
        },
      },
      reauthenticationVerifier: {
        async verify(proof, expectedSubject) {
          if (!proof.startsWith('reauth:')) return undefined;
          return {
            subject: expectedSubject,
            authenticatedAt: new Date(Number(proof.slice('reauth:'.length))),
          };
        },
      },
      repository,
      now: () => new Date(nowMs),
      randomToken: () => `local-random-token-with-at-least-32-bytes-${id}`,
      randomId: () => `local-id-${(id += 1)}`,
    }),
  };
}

async function rejectsCode(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof IdentityLinkError);
    assert.equal(error.code, code);
    return true;
  });
}

async function challenge(fixture: ReturnType<typeof service>, discordUserId = 'discord-1') {
  return fixture.value.createChallenge({
    botCredential: 'bot-link-credential',
    discordUserId,
    correlationId: 'stored-correlation',
  });
}

test('challenge is Discord-bound, hashed, one-use, and audits its stored correlation', async () => {
  const fixture = service();
  const created = await challenge(fixture);
  const memory = fixture.repository as InMemoryDiscordIdentityRepository;
  assert.equal(memory.storedDigests().length, 1);
  assert.notEqual(memory.storedDigests()[0], created.token);
  assert.equal(
    await fixture.value.confirmLink({
      clerkJwt: 'local-jwt',
      challengeToken: created.token,
      discordOAuthProof: 'oauth:discord-1',
    }),
    'linked',
  );
  assert.equal(memory.audits[0]?.correlationId, 'stored-correlation');
  await rejectsCode(
    fixture.value.confirmLink({
      clerkJwt: 'local-jwt',
      challengeToken: created.token,
      discordOAuthProof: 'oauth:discord-1',
    }),
    'DISCORD_LINK_CHALLENGE_INVALID',
  );
});

test('wrong Discord OAuth identity and expiry fail closed', async () => {
  const wrong = service();
  const created = await challenge(wrong);
  await rejectsCode(
    wrong.value.confirmLink({
      clerkJwt: 'local-jwt',
      challengeToken: created.token,
      discordOAuthProof: 'oauth:discord-2',
    }),
    'DISCORD_LINK_CHALLENGE_INVALID',
  );
  const expired = service();
  const expiring = await challenge(expired);
  expired.advance(10 * 60_000);
  await rejectsCode(
    expired.value.confirmLink({
      clerkJwt: 'local-jwt',
      challengeToken: expiring.token,
      discordOAuthProof: 'oauth:discord-1',
    }),
    'DISCORD_LINK_CHALLENGE_INVALID',
  );
});

test('revoked link never reactivates without same-subject recent server reauthentication', async () => {
  const fixture = service();
  const memory = fixture.repository as InMemoryDiscordIdentityRepository;
  memory.seedLink({ player, discordUserId: 'discord-1', revokedAt: new Date(1_799_999_000_000) });
  const created = await challenge(fixture);
  await rejectsCode(
    fixture.value.confirmLink({
      clerkJwt: 'local-jwt',
      challengeToken: created.token,
      discordOAuthProof: 'oauth:discord-1',
    }),
    'DISCORD_LINK_CONFLICT_RECOVERY_REQUIRED',
  );
  assert.equal(memory.audits[0]?.result, 'recovery_required');
  assert.equal(
    await fixture.value.confirmLink({
      clerkJwt: 'local-jwt',
      challengeToken: created.token,
      discordOAuthProof: 'oauth:discord-1',
      reauthenticationProof: 'reauth:1800000000000',
    }),
    'linked',
  );
});

test('ownership conflict is stable, consumes once, and is audited for recovery', async () => {
  const fixture = service();
  const memory = fixture.repository as InMemoryDiscordIdentityRepository;
  memory.seedLink({ player: otherPlayer, discordUserId: 'discord-conflict' });
  const created = await challenge(fixture, 'discord-conflict');
  await rejectsCode(
    fixture.value.confirmLink({
      clerkJwt: 'local-jwt',
      challengeToken: created.token,
      discordOAuthProof: 'oauth:discord-conflict',
    }),
    'DISCORD_LINK_CONFLICT_RECOVERY_REQUIRED',
  );
  assert.deepEqual(memory.audits.at(-1), {
    action: 'link',
    correlationId: 'stored-correlation',
    discordUserId: 'discord-conflict',
    playerId: 'player-1',
    result: 'recovery_required',
  });
  await rejectsCode(
    fixture.value.confirmLink({
      clerkJwt: 'local-jwt',
      challengeToken: created.token,
      discordOAuthProof: 'oauth:discord-conflict',
    }),
    'DISCORD_LINK_CHALLENGE_INVALID',
  );
});

test('unlink and revoke require recent proof and retain explicit audit correlation', async () => {
  const fixture = service();
  const memory = fixture.repository as InMemoryDiscordIdentityRepository;
  memory.seedLink({ player, discordUserId: 'discord-1' });
  await rejectsCode(
    fixture.value.unlink({
      clerkJwt: 'local-jwt',
      reauthenticationProof: `reauth:${1_800_000_000_000 - 5 * 60_000 - 1}`,
      correlationId: 'unlink-correlation',
    }),
    'RECENT_REAUTHENTICATION_REQUIRED',
  );
  assert.equal(
    await fixture.value.unlink({
      clerkJwt: 'local-jwt',
      reauthenticationProof: 'reauth:1800000000000',
      correlationId: 'unlink-correlation',
    }),
    'revoked',
  );
  assert.equal(memory.audits.at(-1)?.correlationId, 'unlink-correlation');
});

test('default composition returns explicit 503 while configured durable composition exposes routes', async () => {
  const defaultApp = createApiComposition();
  const unavailable = await defaultApp.inject({
    method: 'POST',
    url: '/identity/discord/challenges',
    payload: { discordUserId: 'discord-1', correlationId: 'correlation-1' },
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(
    (unavailable.json() as { error: { code: string } }).error.code,
    'IDENTITY_SECURITY_NOT_CONFIGURED',
  );
  assert.deepEqual((await defaultApp.inject({ method: 'GET', url: '/health' })).json(), {
    status: 'ok',
  });
  await defaultApp.close();

  const durable = service({ repository: new DurableTestRepository() });
  const app = createApiComposition({ discordIdentityLinkService: durable.value });
  const created = await app.inject({
    method: 'POST',
    url: '/identity/discord/challenges',
    headers: { authorization: 'Bot bot-link-credential' },
    payload: { discordUserId: 'discord-1', correlationId: 'stored-correlation' },
  });
  assert.equal(created.statusCode, 201);
  const token = (created.json() as { token: string }).token;
  const linked = await app.inject({
    method: 'POST',
    url: '/identity/discord/links',
    headers: { authorization: 'Bearer local-jwt' },
    payload: { challengeToken: token, discordOAuthProof: 'oauth:discord-1' },
  });
  assert.equal(linked.statusCode, 200);
  assert.deepEqual(linked.json(), { status: 'linked' });
  await app.close();
});

test('test-only repository cannot be wired through the production composition option', async () => {
  const fixture = service();
  const app = createApiComposition({ discordIdentityLinkService: fixture.value });
  const response = await app.inject({
    method: 'POST',
    url: '/identity/discord/challenges',
    headers: { authorization: 'Bot bot-link-credential' },
    payload: { discordUserId: 'discord-1', correlationId: 'correlation-1' },
  });
  assert.equal(response.statusCode, 503);
  await app.close();
});

test('Prisma durable adapter compensates and audits a P2002 unique race', async () => {
  const queries: string[] = [];
  let calls = 0;
  const repository = new PrismaDurableDiscordIdentityRepository({
    player: {
      async findUnique() {
        return player;
      },
    },
    discordLinkChallenge: { async create() {} },
    async $queryRawUnsafe<T>(query: string): Promise<T> {
      queries.push(query);
      calls += 1;
      if (calls === 1) throw { code: 'P2002' };
      return [{ status: 'recovery_required', correlationId: 'stored-correlation' }] as T;
    },
    async $transaction(operation) {
      return operation({
        identityLink: {
          async findUnique() {
            return null;
          },
          async update() {
            throw new Error('not used');
          },
        },
        auditLog: { async create() {} },
      });
    },
  });
  const result: AtomicLinkResult = await repository.consumeAndActivateLink({
    tokenDigest: 'a'.repeat(64),
    discordUserId: 'discord-1',
    player,
    confirmedAt: new Date(),
    identityLinkId: 'link-id',
    auditId: 'audit-id',
  });
  assert.equal(result, 'recovery_required');
  assert.match(queries[0], /d04_consume_discord_link_challenge/);
  assert.match(queries[1], /d04_compensate_discord_link_unique_race/);
});
