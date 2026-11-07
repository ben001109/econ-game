import type { FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';

import {
  isMembershipRole,
  type CommandAuthorizationPolicy,
  type MembershipRole,
} from './authorization.js';
import { JwtVerificationError, type JwtVerifier } from './jwt-verifier.js';
import { CommandError, type TrustedCommandContext } from '../commands/command-contract.js';
import type { TrustedCommandContextResolver } from '../commands/command-routes.js';

export type PlayerRecord = Readonly<{ id: string; clerkUserId: string }>;

export type ActiveGameScope = Readonly<{
  playerId: string;
  membershipId: string;
  tenantId: string;
  saveId: string;
  role: MembershipRole;
  branchScope:
    | Readonly<{ kind: 'all' }>
    | Readonly<{ kind: 'restricted'; branchIds: readonly string[] }>;
}>;

export interface IdentityScopeRepository {
  findPlayerByClerkSubject(subject: string): Promise<PlayerRecord | undefined>;
  findPlayerByDiscordId(discordUserId: string): Promise<PlayerRecord | undefined>;
  findActiveGameScope(playerId: string, targetSaveId: string): Promise<ActiveGameScope | undefined>;
}

export type BotServicePrincipal = Readonly<{
  id: string;
  scopes: readonly string[];
}>;

export interface BotServiceCredentialVerifier {
  verify(credential: string): Promise<BotServicePrincipal | undefined>;
}

export type ResolvedBotActorAudit = Readonly<{
  servicePrincipalId: string;
  discordUserId: string;
  interactionId: string;
  correlationId: string;
  commandType: string;
  playerId: string;
  membershipId: string;
  tenantId: string;
  saveId: string;
  role: MembershipRole;
}>;

export interface BotActorAuditSink {
  recordResolvedActor(input: ResolvedBotActorAudit): Promise<void>;
}

/** Compares only fixed-length SHA-256 digests; the raw bot credential is never retained. */
export class HashedBotServiceCredentialVerifier implements BotServiceCredentialVerifier {
  private readonly expectedDigest: Buffer;

  constructor(
    expectedSha256: string,
    private readonly principal: BotServicePrincipal,
  ) {
    if (!/^[0-9a-f]{64}$/.test(expectedSha256) || !principal.id || principal.scopes.length === 0) {
      throw new Error('Bot credential digest and scoped principal configuration are required');
    }
    this.expectedDigest = Buffer.from(expectedSha256, 'hex');
  }

  async verify(credential: string): Promise<BotServicePrincipal | undefined> {
    if (!credential || credential.length > 4_096) return undefined;
    const actual = createHash('sha256').update(credential, 'utf8').digest();
    return timingSafeEqual(actual, this.expectedDigest) ? this.principal : undefined;
  }
}

export type TrustedContextSecurityOptions = Readonly<{
  jwtVerifier: JwtVerifier;
  repository: IdentityScopeRepository;
  authorization: CommandAuthorizationPolicy;
  botServiceCredentialVerifier?: BotServiceCredentialVerifier;
  botActorAuditSink?: BotActorAuditSink;
}>;

type ResolvedRequestIdentity = Readonly<{
  player: PlayerRecord;
  bot?: Readonly<{
    servicePrincipalId: string;
    discordUserId: string;
    interactionId: string;
    correlationId: string;
  }>;
}>;

export type TrustedPlayerIdentity = Readonly<{
  playerId: string;
  principal: Readonly<{ type: 'web' }> | Readonly<{ type: 'discord_bot'; interactionId: string }>;
  recordScopeResolution(input: Readonly<{
    operation: string;
    membershipId: string;
    tenantId: string;
    saveId: string;
    role: MembershipRole;
  }>): Promise<void>;
}>;

export type TrustedPlayerIdentityResolver = (
  request: FastifyRequest,
) => Promise<TrustedPlayerIdentity>;

/**
 * Resolves only the authenticated player. A read model must still resolve its
 * tenant, membership, and save scope from durable server state before calling
 * recordScopeResolution. This keeps active-save discovery possible without
 * accepting any client-supplied actor or tenant authority.
 */
export function createTrustedPlayerIdentityResolver(
  options: TrustedContextSecurityOptions,
): TrustedPlayerIdentityResolver {
  return async (request) => {
    const authorization = singleHeader(request.headers.authorization);
    if (!authorization) throw unauthenticated();

    const identity = authorization.startsWith('Bearer ')
      ? await resolveWebPlayer(authorization.slice('Bearer '.length), options)
      : authorization.startsWith('Bot ')
        ? await resolveBotPlayer(authorization.slice('Bot '.length), request, options)
        : undefined;
    if (!identity) throw unauthenticated();

    return Object.freeze({
      playerId: identity.player.id,
      principal: identity.bot
        ? Object.freeze({ type: 'discord_bot' as const, interactionId: identity.bot.interactionId })
        : Object.freeze({ type: 'web' as const }),
      async recordScopeResolution(scope) {
        if (!identity.bot) return;
        if (!options.botActorAuditSink) throw new CommandError(503, 'BOT_AUDIT_REQUIRED');
        await options.botActorAuditSink.recordResolvedActor({
          ...identity.bot,
          commandType: scope.operation,
          playerId: identity.player.id,
          membershipId: scope.membershipId,
          tenantId: scope.tenantId,
          saveId: scope.saveId,
          role: scope.role,
        });
      },
    });
  };
}

/**
 * Sole D04 adapter from transport credentials to the D02 trusted context.
 * Request body actor/role/tenant/save fields never participate in resolution.
 */
export function createTrustedCommandContextResolver(
  options: TrustedContextSecurityOptions,
): TrustedCommandContextResolver {
  const resolvePlayerIdentity = createTrustedPlayerIdentityResolver(options);
  return async (request) => {
    const target = commandTarget(request);
    const identity = await resolvePlayerIdentity(request);

    const scope = await options.repository.findActiveGameScope(identity.playerId, target.saveId);
    if (
      !scope ||
      scope.playerId !== identity.playerId ||
      scope.saveId !== target.saveId ||
      !isMembershipRole(scope.role) ||
      !options.authorization.isAllowed(target.commandType, scope.role)
    ) {
      throw new CommandError(403, 'COMMAND_SCOPE_FORBIDDEN');
    }
    await identity.recordScopeResolution({
      operation: target.commandType,
      membershipId: scope.membershipId,
      tenantId: scope.tenantId,
      saveId: scope.saveId,
      role: scope.role,
    });

    return Object.freeze<TrustedCommandContext>({
      actorId: identity.playerId,
      tenantId: scope.tenantId,
      saveId: scope.saveId,
      roles: Object.freeze([scope.role]),
      membershipId: scope.membershipId,
      branchScope: scope.branchScope,
      principal: identity.principal,
    });
  };
}

async function resolveWebPlayer(
  token: string,
  options: TrustedContextSecurityOptions,
): Promise<ResolvedRequestIdentity> {
  if (!token || token.includes(' ')) throw unauthenticated();
  try {
    const verified = await options.jwtVerifier.verify(token);
    const player = await options.repository.findPlayerByClerkSubject(verified.subject);
    if (!player) throw new CommandError(403, 'COMMAND_SCOPE_FORBIDDEN');
    return { player };
  } catch (error) {
    if (error instanceof JwtVerificationError) throw unauthenticated();
    throw error;
  }
}

async function resolveBotPlayer(
  credential: string,
  request: FastifyRequest,
  options: TrustedContextSecurityOptions,
): Promise<ResolvedRequestIdentity | undefined> {
  if (!credential || credential.includes(' ') || !options.botServiceCredentialVerifier) {
    throw unauthenticated();
  }
  const principal = await options.botServiceCredentialVerifier.verify(credential);
  if (!principal || !principal.scopes.includes('game:command')) throw unauthenticated();

  const discordUserId = boundedHeader(request.headers['x-discord-user-id'], 500);
  const interactionId = boundedHeader(request.headers['x-discord-interaction-id'], 200);
  const correlationId = boundedHeader(request.headers['x-correlation-id'], 500);
  if (!discordUserId || !interactionId || !correlationId) throw unauthenticated();

  const player = await options.repository.findPlayerByDiscordId(discordUserId);
  if (!player) throw new CommandError(403, 'DISCORD_IDENTITY_LINK_REQUIRED');
  return {
    player,
    bot: {
      servicePrincipalId: principal.id,
      discordUserId,
      interactionId,
      correlationId,
    },
  };
}

function commandTarget(request: FastifyRequest): Readonly<{ saveId: string; commandType: string }> {
  const params = request.params;
  if (typeof params !== 'object' || params === null) throw unauthenticated();
  const record = params as Readonly<Record<string, unknown>>;
  if (
    typeof record.saveId !== 'string' ||
    !record.saveId ||
    record.saveId.length > 200 ||
    typeof record.commandType !== 'string' ||
    !record.commandType ||
    record.commandType.length > 100
  ) {
    throw unauthenticated();
  }
  return { saveId: record.saveId, commandType: record.commandType };
}

function singleHeader(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || !value || value.includes(',')) return undefined;
  return value;
}

function boundedHeader(value: string | string[] | undefined, maximum: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function unauthenticated(): CommandError {
  return new CommandError(401, 'UNTRUSTED_COMMAND_CONTEXT');
}

export type D01IdentityDatabase = Readonly<{
  player: Readonly<{
    findUnique(input: unknown): Promise<PlayerRecord | null>;
  }>;
  identityLink: Readonly<{
    findUnique(input: unknown): Promise<Readonly<{
      player: PlayerRecord;
      revokedAt: Date | null;
    }> | null>;
  }>;
  competitiveSave: Readonly<{
    findUnique(input: unknown): Promise<Readonly<{
      id: string;
      restaurantId: string;
      retiredAt: Date | null;
    }> | null>;
  }>;
  restaurantMembership: Readonly<{
    findUnique(input: unknown): Promise<Readonly<{
      playerId: string;
      id: string;
      restaurantId: string;
      role: string;
      branchScope: unknown;
      revokedAt: Date | null;
    }> | null>;
  }>;
}>;

/** D01-backed lookup adapter; every scope component is loaded server-side. */
export class PrismaIdentityScopeRepository implements IdentityScopeRepository {
  constructor(private readonly database: D01IdentityDatabase) {}

  async findPlayerByClerkSubject(subject: string): Promise<PlayerRecord | undefined> {
    return (
      (await this.database.player.findUnique({
        where: { clerkUserId: subject },
        select: { id: true, clerkUserId: true },
      })) ?? undefined
    );
  }

  async findPlayerByDiscordId(discordUserId: string): Promise<PlayerRecord | undefined> {
    const link = await this.database.identityLink.findUnique({
      where: { provider_providerUserId: { provider: 'discord', providerUserId: discordUserId } },
      select: {
        revokedAt: true,
        player: { select: { id: true, clerkUserId: true } },
      },
    });
    return link && link.revokedAt === null ? link.player : undefined;
  }

  async findActiveGameScope(
    playerId: string,
    targetSaveId: string,
  ): Promise<ActiveGameScope | undefined> {
    const save = await this.database.competitiveSave.findUnique({
      where: { id: targetSaveId },
      select: { id: true, restaurantId: true, retiredAt: true },
    });
    if (!save || save.retiredAt !== null) return undefined;
    const membership = await this.database.restaurantMembership.findUnique({
      where: {
        playerId_restaurantId: { playerId, restaurantId: save.restaurantId },
      },
      select: {
        playerId: true,
        id: true,
        restaurantId: true,
        role: true,
        branchScope: true,
        revokedAt: true,
      },
    });
    if (!membership || membership.revokedAt !== null || !isMembershipRole(membership.role)) {
      return undefined;
    }
    const branchScope = parseBranchScope(membership.branchScope);
    if (branchScope === undefined) return undefined;
    return Object.freeze({
      playerId,
      membershipId: membership.id,
      tenantId: membership.restaurantId,
      saveId: save.id,
      role: membership.role,
      branchScope,
    });
  }
}

export type D01BotAuditDatabase = Readonly<{
  auditLog: Readonly<{ create(input: unknown): Promise<unknown> }>;
}>;

/** D01 AuditLog sink for authorized Discord command actor resolution. */
export class PrismaBotActorAuditSink implements BotActorAuditSink {
  constructor(private readonly database: D01BotAuditDatabase) {}

  async recordResolvedActor(input: ResolvedBotActorAudit): Promise<void> {
    await this.database.auditLog.create({
      data: {
        restaurantId: input.tenantId,
        actorPlayerId: input.playerId,
        actorType: 'discord_bot',
        action: 'discord_command_actor_resolved',
        targetType: 'CompetitiveSave',
        targetId: input.saveId,
        correlationId: input.correlationId,
        metadata: {
          servicePrincipalId: input.servicePrincipalId,
          discordUserId: input.discordUserId,
          interactionId: input.interactionId,
          membershipId: input.membershipId,
          commandType: input.commandType,
          role: input.role,
        },
      },
    });
  }
}

function parseBranchScope(value: unknown): ActiveGameScope['branchScope'] | undefined {
  if (value === null || value === undefined) return Object.freeze({ kind: 'all' });
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || !entry || entry.length > 200)
  ) {
    return undefined;
  }
  return Object.freeze({ kind: 'restricted', branchIds: Object.freeze([...value]) });
}
