import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { JwtVerificationError, type JwtVerifier } from '../auth/jwt-verifier.js';
import type {
  BotServiceCredentialVerifier,
  PlayerRecord,
} from '../auth/trusted-command-context.js';

export class IdentityLinkError extends Error {
  readonly status: 401 | 403 | 409 | 422 | 503;
  readonly code: string;

  constructor(status: 401 | 403 | 409 | 422 | 503, code: string) {
    super(code);
    this.name = 'IdentityLinkError';
    this.status = status;
    this.code = code;
  }
}

export type DiscordLinkChallenge = Readonly<{ token: string; expiresAt: Date }>;

export type StoredDiscordLinkChallenge = Readonly<{
  id: string;
  tokenDigest: string;
  discordUserId: string;
  expiresAt: Date;
  correlationId: string;
  createdAt: Date;
}>;

export type AtomicLinkResult =
  | 'linked'
  | 'already_linked'
  | 'recovery_required'
  | 'challenge_invalid';

export interface DiscordIdentityRepository {
  readonly durability: 'durable' | 'test';
  createChallenge(challenge: StoredDiscordLinkChallenge): Promise<void>;
  findPlayerByClerkSubject(subject: string): Promise<PlayerRecord | undefined>;
  consumeAndActivateLink(
    input: Readonly<{
      tokenDigest: string;
      discordUserId: string;
      player: PlayerRecord;
      confirmedAt: Date;
      reauthenticatedAt?: Date;
      identityLinkId: string;
      auditId: string;
    }>,
  ): Promise<AtomicLinkResult>;
  revokeDiscordLink(
    input: Readonly<{
      player: PlayerRecord;
      revokedAt: Date;
      correlationId: string;
      action: 'unlink' | 'revoke';
    }>,
  ): Promise<'revoked' | 'not_active'>;
}

export interface DiscordOAuthProofVerifier {
  verify(proof: string): Promise<Readonly<{ discordUserId: string }> | undefined>;
}

export interface ReauthenticationVerifier {
  verify(
    proof: string,
    expectedSubject: string,
  ): Promise<Readonly<{ subject: string; authenticatedAt: Date }> | undefined>;
}

export type DiscordIdentityLinkServiceOptions = Readonly<{
  jwtVerifier: JwtVerifier;
  botCredentialVerifier: BotServiceCredentialVerifier;
  oauthProofVerifier: DiscordOAuthProofVerifier;
  reauthenticationVerifier: ReauthenticationVerifier;
  repository: DiscordIdentityRepository;
  challengeTtlMs?: number;
  maximumReauthenticationAgeMs?: number;
  now?: () => Date;
  randomToken?: () => string;
  randomId?: () => string;
}>;

export class DiscordIdentityLinkService {
  private readonly challengeTtlMs: number;
  private readonly maximumReauthenticationAgeMs: number;
  private readonly now: () => Date;
  private readonly randomToken: () => string;
  private readonly randomId: () => string;

  constructor(private readonly options: DiscordIdentityLinkServiceOptions) {
    this.challengeTtlMs = options.challengeTtlMs ?? 10 * 60_000;
    this.maximumReauthenticationAgeMs = options.maximumReauthenticationAgeMs ?? 5 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.randomId = options.randomId ?? randomUUID;
    if (this.challengeTtlMs <= 0 || this.challengeTtlMs > 10 * 60_000) {
      throw new Error('Discord link challenge TTL must be at most ten minutes');
    }
    if (this.maximumReauthenticationAgeMs <= 0 || this.maximumReauthenticationAgeMs > 10 * 60_000) {
      throw new Error('Discord reauthentication age must be bounded');
    }
  }

  isDurable(): boolean {
    return this.options.repository.durability === 'durable';
  }

  async createChallenge(
    input: Readonly<{
      botCredential: string;
      discordUserId: string;
      correlationId: string;
    }>,
  ): Promise<DiscordLinkChallenge> {
    const principal = await this.options.botCredentialVerifier.verify(input.botCredential);
    if (!principal || !principal.scopes.includes('identity:link')) {
      throw new IdentityLinkError(401, 'BOT_SERVICE_UNAUTHORIZED');
    }
    validateOpaqueIdentifier(input.discordUserId, 'DISCORD_USER_ID_INVALID');
    validateOpaqueIdentifier(input.correlationId, 'CORRELATION_ID_INVALID');
    const token = this.randomToken();
    if (!token || token.length < 32 || token.length > 500) {
      throw new Error('challenge token generator returned an unsafe token');
    }
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.challengeTtlMs);
    await this.options.repository.createChallenge({
      id: this.randomId(),
      tokenDigest: digestToken(token),
      discordUserId: input.discordUserId,
      expiresAt,
      correlationId: input.correlationId,
      createdAt,
    });
    return Object.freeze({ token, expiresAt });
  }

  async confirmLink(
    input: Readonly<{
      clerkJwt: string;
      challengeToken: string;
      discordOAuthProof: string;
      reauthenticationProof?: string;
    }>,
  ): Promise<'linked' | 'already_linked'> {
    const identity = await this.verifyWebIdentity(input.clerkJwt);
    const player = await this.options.repository.findPlayerByClerkSubject(identity.subject);
    if (!player) throw new IdentityLinkError(403, 'PLAYER_NOT_PROVISIONED');

    const oauthIdentity = await this.options.oauthProofVerifier.verify(input.discordOAuthProof);
    if (!oauthIdentity) throw new IdentityLinkError(401, 'DISCORD_OAUTH_PROOF_INVALID');
    validateOpaqueIdentifier(oauthIdentity.discordUserId, 'DISCORD_USER_ID_INVALID');
    const confirmedAt = this.now();
    const reauthenticatedAt = input.reauthenticationProof
      ? await this.verifyRecentReauthentication(
          input.reauthenticationProof,
          identity.subject,
          confirmedAt,
        )
      : undefined;

    const result = await this.options.repository.consumeAndActivateLink({
      tokenDigest: digestToken(input.challengeToken),
      discordUserId: oauthIdentity.discordUserId,
      player,
      confirmedAt,
      ...(reauthenticatedAt ? { reauthenticatedAt } : {}),
      identityLinkId: this.randomId(),
      auditId: this.randomId(),
    });
    if (result === 'challenge_invalid') {
      throw new IdentityLinkError(409, 'DISCORD_LINK_CHALLENGE_INVALID');
    }
    if (result === 'recovery_required') {
      throw new IdentityLinkError(409, 'DISCORD_LINK_CONFLICT_RECOVERY_REQUIRED');
    }
    return result;
  }

  async unlink(
    input: Readonly<{
      clerkJwt: string;
      reauthenticationProof: string;
      correlationId: string;
    }>,
  ): Promise<'revoked' | 'not_active'> {
    return this.revokeLink(input, 'unlink');
  }

  async revoke(
    input: Readonly<{
      clerkJwt: string;
      reauthenticationProof: string;
      correlationId: string;
    }>,
  ): Promise<'revoked' | 'not_active'> {
    return this.revokeLink(input, 'revoke');
  }

  private async revokeLink(
    input: Readonly<{
      clerkJwt: string;
      reauthenticationProof: string;
      correlationId: string;
    }>,
    action: 'unlink' | 'revoke',
  ): Promise<'revoked' | 'not_active'> {
    validateOpaqueIdentifier(input.correlationId, 'CORRELATION_ID_INVALID');
    const identity = await this.verifyWebIdentity(input.clerkJwt);
    const player = await this.options.repository.findPlayerByClerkSubject(identity.subject);
    if (!player) throw new IdentityLinkError(403, 'PLAYER_NOT_PROVISIONED');
    const now = this.now();
    await this.verifyRecentReauthentication(input.reauthenticationProof, identity.subject, now);
    return this.options.repository.revokeDiscordLink({
      player,
      revokedAt: now,
      correlationId: input.correlationId,
      action,
    });
  }

  private async verifyRecentReauthentication(
    proof: string,
    subject: string,
    now: Date,
  ): Promise<Date> {
    const verified = await this.options.reauthenticationVerifier.verify(proof, subject);
    if (!verified || verified.subject !== subject) {
      throw new IdentityLinkError(403, 'RECENT_REAUTHENTICATION_REQUIRED');
    }
    const age = now.getTime() - verified.authenticatedAt.getTime();
    if (!Number.isFinite(age) || age < 0 || age > this.maximumReauthenticationAgeMs) {
      throw new IdentityLinkError(403, 'RECENT_REAUTHENTICATION_REQUIRED');
    }
    return verified.authenticatedAt;
  }

  private async verifyWebIdentity(token: string) {
    try {
      return await this.options.jwtVerifier.verify(token);
    } catch (error) {
      if (error instanceof JwtVerificationError) {
        throw new IdentityLinkError(401, 'CLERK_JWT_INVALID');
      }
      throw error;
    }
  }
}

type MemoryLink = {
  playerId: string;
  clerkUserId: string;
  discordUserId: string;
  revokedAt?: Date;
};

/** Test-only atomic repository; production composition rejects this durability marker. */
export class InMemoryDiscordIdentityRepository implements DiscordIdentityRepository {
  readonly durability = 'test' as const;
  private readonly challenges = new Map<
    string,
    StoredDiscordLinkChallenge & Readonly<{ consumedAt?: Date; consumedByPlayerId?: string }>
  >();
  private readonly linksByDiscord = new Map<string, MemoryLink>();
  private readonly linksByClerk = new Map<string, MemoryLink>();
  readonly audits: Array<Readonly<Record<string, unknown>>> = [];

  constructor(private readonly players: readonly PlayerRecord[]) {}

  async createChallenge(challenge: StoredDiscordLinkChallenge): Promise<void> {
    if (this.challenges.has(challenge.tokenDigest)) throw new Error('challenge digest collision');
    this.challenges.set(challenge.tokenDigest, Object.freeze({ ...challenge }));
  }

  async findPlayerByClerkSubject(subject: string): Promise<PlayerRecord | undefined> {
    return this.players.find((player) => player.clerkUserId === subject);
  }

  async consumeAndActivateLink(
    input: Readonly<{
      tokenDigest: string;
      discordUserId: string;
      player: PlayerRecord;
      confirmedAt: Date;
      reauthenticatedAt?: Date;
    }>,
  ): Promise<AtomicLinkResult> {
    const challenge = this.challenges.get(input.tokenDigest);
    if (
      !challenge ||
      challenge.discordUserId !== input.discordUserId ||
      challenge.consumedAt ||
      challenge.expiresAt.getTime() <= input.confirmedAt.getTime()
    ) {
      return 'challenge_invalid';
    }
    const byDiscord = this.linksByDiscord.get(input.discordUserId);
    const byClerk = this.linksByClerk.get(input.player.clerkUserId);
    let result: AtomicLinkResult;
    if (
      (byDiscord && byDiscord.playerId !== input.player.id) ||
      (byClerk && byClerk.discordUserId !== input.discordUserId)
    ) {
      result = 'recovery_required';
    } else {
      const existing = byDiscord ?? byClerk;
      if (existing?.revokedAt) {
        if (!input.reauthenticatedAt) {
          this.audit(challenge, input, 'recovery_required');
          return 'recovery_required';
        }
        existing.revokedAt = undefined;
        result = 'linked';
      } else if (existing) {
        result = 'already_linked';
      } else {
        const link: MemoryLink = {
          playerId: input.player.id,
          clerkUserId: input.player.clerkUserId,
          discordUserId: input.discordUserId,
        };
        this.linksByDiscord.set(input.discordUserId, link);
        this.linksByClerk.set(input.player.clerkUserId, link);
        result = 'linked';
      }
    }
    this.challenges.set(
      input.tokenDigest,
      Object.freeze({
        ...challenge,
        consumedAt: input.confirmedAt,
        consumedByPlayerId: input.player.id,
      }),
    );
    this.audit(challenge, input, result);
    return result;
  }

  async revokeDiscordLink(
    input: Readonly<{
      player: PlayerRecord;
      revokedAt: Date;
      correlationId: string;
      action: 'unlink' | 'revoke';
    }>,
  ): Promise<'revoked' | 'not_active'> {
    const link = this.linksByClerk.get(input.player.clerkUserId);
    const result =
      !link || link.playerId !== input.player.id || link.revokedAt ? 'not_active' : 'revoked';
    if (result === 'revoked' && link) link.revokedAt = input.revokedAt;
    this.audits.push(
      Object.freeze({ action: input.action, correlationId: input.correlationId, result }),
    );
    return result;
  }

  seedLink(
    input: Readonly<{
      player: PlayerRecord;
      discordUserId: string;
      revokedAt?: Date;
    }>,
  ): void {
    const link: MemoryLink = {
      playerId: input.player.id,
      clerkUserId: input.player.clerkUserId,
      discordUserId: input.discordUserId,
      ...(input.revokedAt ? { revokedAt: input.revokedAt } : {}),
    };
    this.linksByDiscord.set(input.discordUserId, link);
    this.linksByClerk.set(input.player.clerkUserId, link);
  }

  storedDigests(): readonly string[] {
    return Object.freeze([...this.challenges.keys()]);
  }

  private audit(
    challenge: StoredDiscordLinkChallenge,
    input: Readonly<{ player: PlayerRecord; discordUserId: string }>,
    result: AtomicLinkResult,
  ): void {
    this.audits.push(
      Object.freeze({
        action: 'link',
        correlationId: challenge.correlationId,
        discordUserId: input.discordUserId,
        playerId: input.player.id,
        result,
      }),
    );
  }
}

type D01LinkRow = Readonly<{
  id: string;
  playerId: string;
  clerkUserId: string;
  providerUserId: string;
  revokedAt: Date | null;
}>;

type D04IdentityTransaction = Readonly<{
  identityLink: Readonly<{
    findUnique(input: unknown): Promise<D01LinkRow | null>;
    update(input: unknown): Promise<D01LinkRow>;
  }>;
  auditLog: Readonly<{ create(input: unknown): Promise<unknown> }>;
}>;

type D04IdentityDatabase = Readonly<{
  player: Readonly<{ findUnique(input: unknown): Promise<PlayerRecord | null> }>;
  discordLinkChallenge: Readonly<{ create(input: unknown): Promise<unknown> }>;
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $transaction<T>(operation: (transaction: D04IdentityTransaction) => Promise<T>): Promise<T>;
}>;

type AtomicLinkRow = Readonly<{ status: AtomicLinkResult; correlationId: string | null }>;

/** Durable D04 adapter backed by the reviewed PostgreSQL atomic functions. */
export class PrismaDurableDiscordIdentityRepository implements DiscordIdentityRepository {
  readonly durability = 'durable' as const;

  constructor(private readonly database: D04IdentityDatabase) {}

  async createChallenge(challenge: StoredDiscordLinkChallenge): Promise<void> {
    await this.database.discordLinkChallenge.create({ data: challenge });
  }

  async findPlayerByClerkSubject(subject: string): Promise<PlayerRecord | undefined> {
    return (
      (await this.database.player.findUnique({
        where: { clerkUserId: subject },
        select: { id: true, clerkUserId: true },
      })) ?? undefined
    );
  }

  async consumeAndActivateLink(
    input: Readonly<{
      tokenDigest: string;
      discordUserId: string;
      player: PlayerRecord;
      confirmedAt: Date;
      reauthenticatedAt?: Date;
      identityLinkId: string;
      auditId: string;
    }>,
  ): Promise<AtomicLinkResult> {
    try {
      const rows = await this.database.$queryRawUnsafe<readonly AtomicLinkRow[]>(
        'SELECT * FROM d04_consume_discord_link_challenge($1,$2,$3,$4,$5,$6,$7,$8)',
        input.tokenDigest,
        input.discordUserId,
        input.player.id,
        input.player.clerkUserId,
        input.confirmedAt,
        input.reauthenticatedAt ?? null,
        input.identityLinkId,
        input.auditId,
      );
      return parseAtomicResult(rows);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const rows = await this.database.$queryRawUnsafe<readonly AtomicLinkRow[]>(
        'SELECT * FROM d04_compensate_discord_link_unique_race($1,$2,$3,$4,$5)',
        input.tokenDigest,
        input.discordUserId,
        input.player.id,
        input.confirmedAt,
        input.auditId,
      );
      return parseAtomicResult(rows);
    }
  }

  revokeDiscordLink(
    input: Readonly<{
      player: PlayerRecord;
      revokedAt: Date;
      correlationId: string;
      action: 'unlink' | 'revoke';
    }>,
  ): Promise<'revoked' | 'not_active'> {
    return this.database.$transaction(async (transaction) => {
      const link = await transaction.identityLink.findUnique({
        where: {
          clerkUserId_provider: { clerkUserId: input.player.clerkUserId, provider: 'discord' },
        },
      });
      const result =
        !link || link.playerId !== input.player.id || link.revokedAt ? 'not_active' : 'revoked';
      if (result === 'revoked' && link) {
        await transaction.identityLink.update({
          where: { id: link.id },
          data: { revokedAt: input.revokedAt },
        });
      }
      await transaction.auditLog.create({
        data: {
          actorPlayerId: input.player.id,
          actorType: 'clerk_user',
          action: `discord_identity_${input.action}`,
          targetType: 'IdentityLink',
          targetId: link?.providerUserId ?? 'not-active',
          correlationId: input.correlationId,
          metadata: { provider: 'discord', result },
        },
      });
      return result;
    });
  }
}

function parseAtomicResult(rows: readonly AtomicLinkRow[]): AtomicLinkResult {
  const result = rows[0]?.status;
  if (
    result !== 'linked' &&
    result !== 'already_linked' &&
    result !== 'recovery_required' &&
    result !== 'challenge_invalid'
  ) {
    throw new IdentityLinkError(503, 'IDENTITY_PERSISTENCE_RESULT_INVALID');
  }
  return result;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Readonly<Record<string, unknown>>;
  if (record.code === 'P2002' || record.code === '23505') return true;
  const meta = record.meta;
  return (
    typeof meta === 'object' &&
    meta !== null &&
    (meta as Readonly<Record<string, unknown>>).code === '23505'
  );
}

function digestToken(token: string): string {
  if (!token || token.length > 500) throw new IdentityLinkError(422, 'LINK_TOKEN_INVALID');
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function validateOpaqueIdentifier(value: string, code: string): void {
  if (
    !value ||
    value.length > 500 ||
    [...value].some((character) => character.codePointAt(0)! < 32)
  ) {
    throw new IdentityLinkError(422, code);
  }
}
