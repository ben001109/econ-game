import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { JwtVerificationError, type JwtVerifier } from '../auth/jwt-verifier.js';
import type { PlayerRecord } from '../auth/trusted-command-context.js';
import {
  assertJsonWithinResourceLimits,
  JsonResourceLimitError,
} from '../security/json-resource-limits.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const NON_COMPETITIVE_REWARDS = new Set(['TITLE', 'COSMETIC', 'NON_COMPETITIVE_STARTER_PACK']);

export class ClosedBetaError extends Error {
  readonly status: 401 | 403 | 409 | 413 | 422 | 503;
  readonly code: string;

  constructor(status: 401 | 403 | 409 | 413 | 422 | 503, code: string) {
    super(code);
    this.name = 'ClosedBetaError';
    this.status = status;
    this.code = code;
  }
}

export type CohortDraft = Readonly<{
  id: string;
  restaurantId: string;
  name: string;
  purpose: string;
  environment: string;
  quota: number;
  opensAt: Date;
  closesAt: Date;
  featureFlags: Readonly<Record<string, boolean>>;
  eligibilityPolicyVersion: string;
  eligibilityPolicyDigest: string;
  createdByPlayerId: string;
  createdAt: Date;
  auditId: string;
  correlationId: string;
}>;

export type ConsentPolicyDraft = Readonly<{
  id: string;
  cohortId: string;
  purpose: string;
  version: string;
  policyDigest: string;
  scope: Readonly<Record<string, unknown>>;
  dataCategories: readonly string[];
  retentionDays: number;
  requiredForEntry: boolean;
  createdByPlayerId: string;
  createdAt: Date;
  auditId: string;
  correlationId: string;
}>;

export type InviteDraft = Readonly<{
  id: string;
  cohortId: string;
  invitedPlayerId: string;
  issuedByPlayerId: string;
  tokenDigest: string;
  expiresAt: Date;
  createdAt: Date;
  auditId: string;
  correlationId: string;
}>;

export type RewardEvidence = Readonly<{
  cohortId: string;
  playerId: string;
  milestoneEventId: string;
  evidenceSnapshot: Readonly<Record<string, unknown>>;
  evidenceHash: string;
  eligible: boolean;
  rewardKind: string;
  reason: string;
  decidedAt: Date;
  eligibilityId: string;
  auditId: string;
  correlationId: string;
}>;

export type OwnerRewardDecision = Readonly<{
  cohortId: string;
  supersedesEligibilityId: string;
  eligible: boolean;
  source: 'MANUAL_ADJUSTMENT' | 'REVOCATION';
  reason: string;
  actorPlayerId: string;
  decidedAt: Date;
  eligibilityId: string;
  auditId: string;
  correlationId: string;
}>;

export type EffectiveRewardEligibility = Readonly<{
  eligibilityId: string;
  rewardKind: string;
  eligible: boolean;
  source: 'SERVER_EVENT' | 'MANUAL_ADJUSTMENT' | 'REVOCATION';
  supersedesEligibilityId: string | null;
}>;

export interface ClosedBetaRepository {
  readonly durability: 'durable' | 'test';
  findPlayerByClerkSubject(subject: string): Promise<PlayerRecord | undefined>;
  createCohort(input: CohortDraft): Promise<void>;
  createConsentPolicy(input: ConsentPolicyDraft): Promise<void>;
  openCohort(
    input: Readonly<{
      cohortId: string;
      entryConsentPolicyId: string;
      actorPlayerId: string;
      openedAt: Date;
      auditId: string;
      correlationId: string;
    }>,
  ): Promise<void>;
  closeCohort(
    input: Readonly<{
      cohortId: string;
      action: 'close' | 'revoke';
      actorPlayerId: string;
      occurredAt: Date;
      auditId: string;
      correlationId: string;
    }>,
  ): Promise<void>;
  createInvite(input: InviteDraft): Promise<void>;
  activateInvite(
    input: Readonly<{
      cohortId: string;
      inviteId: string;
      actorPlayerId: string;
      activatedAt: Date;
      auditId: string;
      correlationId: string;
    }>,
  ): Promise<void>;
  revokeInvite(
    input: Readonly<{
      cohortId: string;
      inviteId: string;
      actorPlayerId: string;
      revokedAt: Date;
      auditId: string;
      correlationId: string;
    }>,
  ): Promise<void>;
  redeemInvite(
    input: Readonly<{
      tokenDigest: string;
      actorPlayerId: string;
      redeemedAt: Date;
      membershipId: string;
      auditId: string;
      correlationId: string;
    }>,
  ): Promise<'redeemed' | 'invalid'>;
  recordConsentDecision(
    input: Readonly<{
      policyId: string;
      actorPlayerId: string;
      decision: 'ACCEPTED' | 'WITHDRAWN';
      decidedAt: Date;
      decisionId: string;
      auditId: string;
      correlationId: string;
    }>,
  ): Promise<'accepted' | 'withdrawn' | 'invalid'>;
  revokeMembership(
    input: Readonly<{
      cohortId: string;
      playerId: string;
      actorPlayerId: string;
      reason: string;
      revokedAt: Date;
      auditId: string;
      correlationId: string;
    }>,
  ): Promise<void>;
  isEntranceEligible(playerId: string, tenantId: string, checkedAt: Date): Promise<boolean>;
  recordServerRewardEligibility(input: RewardEvidence): Promise<void>;
  recordOwnerRewardDecision(input: OwnerRewardDecision): Promise<void>;
  findEffectiveRewardEligibility(
    cohortId: string,
    playerId: string,
    milestoneEventId: string,
  ): Promise<EffectiveRewardEligibility | undefined>;
}

export type ClosedBetaServiceOptions = Readonly<{
  jwtVerifier: JwtVerifier;
  repository: ClosedBetaRepository;
  now?: () => Date;
  randomToken?: () => string;
  randomId?: () => string;
}>;

export class ClosedBetaService {
  private readonly now: () => Date;
  private readonly randomToken: () => string;
  private readonly randomId: () => string;

  constructor(private readonly options: ClosedBetaServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.randomId = options.randomId ?? randomUUID;
  }

  isDurable(): boolean {
    return this.options.repository.durability === 'durable';
  }

  async createCohort(
    bearerToken: string,
    restaurantId: string,
    input: Readonly<Record<string, unknown>>,
    correlationId = this.randomId(),
  ): Promise<Readonly<{ id: string; status: 'DRAFT' }>> {
    const actor = await this.authenticate(bearerToken);
    const now = this.now();
    const name = boundedString(input.name, 200);
    const purpose = boundedString(input.purpose, 500);
    const environment = boundedString(input.environment, 100);
    const quota = boundedInteger(input.quota, 1, 100_000);
    const opensAt = validDate(input.opensAt);
    const closesAt = validDate(input.closesAt);
    const featureFlags = validFeatureFlags(input.featureFlags);
    const eligibilityPolicyVersion = boundedString(input.eligibilityPolicyVersion, 200);
    const eligibilityPolicyDigest = validDigest(input.eligibilityPolicyDigest);
    validateIdentifier(restaurantId);
    if (opensAt >= closesAt || closesAt <= now) invalidRequest();
    const id = this.randomId();
    await this.options.repository.createCohort({
      id,
      restaurantId,
      name,
      purpose,
      environment,
      quota,
      opensAt,
      closesAt,
      featureFlags,
      eligibilityPolicyVersion,
      eligibilityPolicyDigest,
      createdByPlayerId: actor.id,
      createdAt: now,
      auditId: this.randomId(),
      correlationId: validCorrelationId(correlationId),
    });
    return Object.freeze({ id, status: 'DRAFT' });
  }

  async createConsentPolicy(
    bearerToken: string,
    cohortId: string,
    input: Readonly<Record<string, unknown>>,
    correlationId = this.randomId(),
  ): Promise<Readonly<{ id: string }>> {
    const actor = await this.authenticate(bearerToken);
    validateIdentifier(cohortId);
    const id = this.randomId();
    await this.options.repository.createConsentPolicy({
      id,
      cohortId,
      purpose: boundedString(input.purpose, 200),
      version: boundedString(input.version, 200),
      policyDigest: validDigest(input.policyDigest),
      scope: validJsonObject(input.scope),
      dataCategories: validStringList(input.dataCategories, 100, 200),
      retentionDays: boundedInteger(input.retentionDays, 1, 3_650),
      requiredForEntry: input.requiredForEntry === true,
      createdByPlayerId: actor.id,
      createdAt: this.now(),
      auditId: this.randomId(),
      correlationId: validCorrelationId(correlationId),
    });
    return Object.freeze({ id });
  }

  async openCohort(
    bearerToken: string,
    cohortId: string,
    entryConsentPolicyId: string,
    correlationId = this.randomId(),
  ): Promise<void> {
    const actor = await this.authenticate(bearerToken);
    validateIdentifier(cohortId);
    validateIdentifier(entryConsentPolicyId);
    await this.options.repository.openCohort({
      cohortId,
      entryConsentPolicyId,
      actorPlayerId: actor.id,
      openedAt: this.now(),
      auditId: this.randomId(),
      correlationId: validCorrelationId(correlationId),
    });
  }

  async closeCohort(
    bearerToken: string,
    cohortId: string,
    action: 'close' | 'revoke',
    correlationId = this.randomId(),
  ): Promise<void> {
    const actor = await this.authenticate(bearerToken);
    validateIdentifier(cohortId);
    await this.options.repository.closeCohort({
      cohortId,
      action,
      actorPlayerId: actor.id,
      occurredAt: this.now(),
      auditId: this.randomId(),
      correlationId: validCorrelationId(correlationId),
    });
  }

  async createInvite(
    bearerToken: string,
    cohortId: string,
    input: Readonly<Record<string, unknown>>,
    correlationId = this.randomId(),
  ): Promise<Readonly<{ id: string; token: string; expiresAt: Date; status: 'DRAFT' }>> {
    const actor = await this.authenticate(bearerToken);
    const now = this.now();
    const ttlSeconds = boundedInteger(input.ttlSeconds, 60, MAX_INVITE_TTL_MS / 1_000);
    const invitedPlayerId = boundedString(input.invitedPlayerId, 200);
    validateIdentifier(cohortId);
    const token = this.randomToken();
    if (!/^[A-Za-z0-9_-]{43,500}$/.test(token)) {
      throw new Error('Invite token generator must provide at least 256 bits of base64url entropy');
    }
    const id = this.randomId();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
    await this.options.repository.createInvite({
      id,
      cohortId,
      invitedPlayerId,
      issuedByPlayerId: actor.id,
      tokenDigest: digestToken(token),
      expiresAt,
      createdAt: now,
      auditId: this.randomId(),
      correlationId: validCorrelationId(correlationId),
    });
    return Object.freeze({ id, token, expiresAt, status: 'DRAFT' });
  }

  async activateInvite(
    bearerToken: string,
    cohortId: string,
    inviteId: string,
    correlationId = this.randomId(),
  ): Promise<void> {
    const actor = await this.authenticate(bearerToken);
    validateIdentifier(cohortId);
    validateIdentifier(inviteId);
    await this.options.repository.activateInvite({
      cohortId,
      inviteId,
      actorPlayerId: actor.id,
      activatedAt: this.now(),
      auditId: this.randomId(),
      correlationId: validCorrelationId(correlationId),
    });
  }

  async revokeInvite(
    bearerToken: string,
    cohortId: string,
    inviteId: string,
    correlationId = this.randomId(),
  ): Promise<void> {
    const actor = await this.authenticate(bearerToken);
    validateIdentifier(cohortId);
    validateIdentifier(inviteId);
    await this.options.repository.revokeInvite({
      cohortId,
      inviteId,
      actorPlayerId: actor.id,
      revokedAt: this.now(),
      auditId: this.randomId(),
      correlationId: validCorrelationId(correlationId),
    });
  }

  async redeemInvite(
    bearerToken: string,
    rawToken: string,
    correlationId = this.randomId(),
  ): Promise<void> {
    const actor = await this.authenticate(bearerToken);
    if (!/^[A-Za-z0-9_-]{43,500}$/.test(rawToken)) invalidInvite();
    const result = await this.options.repository.redeemInvite({
      tokenDigest: digestToken(rawToken),
      actorPlayerId: actor.id,
      redeemedAt: this.now(),
      membershipId: this.randomId(),
      auditId: this.randomId(),
      correlationId: validCorrelationId(correlationId),
    });
    if (result !== 'redeemed') invalidInvite();
  }

  async decideConsent(
    bearerToken: string,
    policyId: string,
    decision: 'ACCEPTED' | 'WITHDRAWN',
    correlationId = this.randomId(),
  ): Promise<void> {
    const actor = await this.authenticate(bearerToken);
    validateIdentifier(policyId);
    const result = await this.options.repository.recordConsentDecision({
      policyId,
      actorPlayerId: actor.id,
      decision,
      decidedAt: this.now(),
      decisionId: this.randomId(),
      auditId: this.randomId(),
      correlationId: validCorrelationId(correlationId),
    });
    if (result === 'invalid') throw new ClosedBetaError(422, 'CONSENT_DECISION_REJECTED');
  }

  async revokeMembership(
    bearerToken: string,
    cohortId: string,
    playerId: string,
    reason: string,
    correlationId = this.randomId(),
  ): Promise<void> {
    const actor = await this.authenticate(bearerToken);
    validateIdentifier(cohortId);
    validateIdentifier(playerId);
    await this.options.repository.revokeMembership({
      cohortId,
      playerId,
      actorPlayerId: actor.id,
      reason: boundedString(reason, 500),
      revokedAt: this.now(),
      auditId: this.randomId(),
      correlationId: validCorrelationId(correlationId),
    });
  }

  async isAuthenticatedPlayerEligible(bearerToken: string, tenantId: string): Promise<boolean> {
    const actor = await this.authenticate(bearerToken);
    validateIdentifier(tenantId);
    return this.options.repository.isEntranceEligible(actor.id, tenantId, this.now());
  }

  async assertEntranceEligible(playerId: string, tenantId: string): Promise<void> {
    if (!(await this.options.repository.isEntranceEligible(playerId, tenantId, this.now()))) {
      throw new ClosedBetaError(403, 'CLOSED_BETA_NOT_ELIGIBLE');
    }
  }

  async recordServerMilestoneEligibility(
    input: Readonly<{
      cohortId: string;
      playerId: string;
      milestoneEventId: string;
      evidenceSnapshot: Readonly<Record<string, unknown>>;
      eligible: boolean;
      rewardKind: string;
      reason: string;
      correlationId?: string;
    }>,
  ): Promise<void> {
    validateIdentifier(input.cohortId);
    validateIdentifier(input.playerId);
    validateIdentifier(input.milestoneEventId);
    if (!NON_COMPETITIVE_REWARDS.has(input.rewardKind)) invalidRequest();
    const evidenceSnapshot = validJsonObject(input.evidenceSnapshot);
    await this.options.repository.recordServerRewardEligibility({
      ...input,
      reason: boundedString(input.reason, 500),
      evidenceSnapshot,
      evidenceHash: createHash('sha256').update(canonicalJson(evidenceSnapshot)).digest('hex'),
      decidedAt: this.now(),
      eligibilityId: this.randomId(),
      auditId: this.randomId(),
      correlationId: validCorrelationId(input.correlationId ?? this.randomId()),
    });
  }

  async recordOwnerRewardDecision(
    bearerToken: string,
    cohortId: string,
    input: Readonly<Record<string, unknown>>,
    correlationId = this.randomId(),
  ): Promise<void> {
    const actor = await this.authenticate(bearerToken);
    validateIdentifier(cohortId);
    const supersedesEligibilityId = boundedString(input.supersedesEligibilityId, 200);
    const eligible = input.eligible;
    const source = input.source;
    if (
      typeof eligible !== 'boolean' ||
      (source !== 'MANUAL_ADJUSTMENT' && source !== 'REVOCATION') ||
      (source === 'REVOCATION' && eligible)
    ) {
      invalidRequest();
    }
    validateIdentifier(supersedesEligibilityId);
    await this.options.repository.recordOwnerRewardDecision({
      cohortId,
      supersedesEligibilityId,
      eligible,
      source,
      reason: boundedString(input.reason, 500),
      actorPlayerId: actor.id,
      decidedAt: this.now(),
      eligibilityId: this.randomId(),
      auditId: this.randomId(),
      correlationId: validCorrelationId(correlationId),
    });
  }

  async findEffectiveRewardEligibility(
    cohortId: string,
    playerId: string,
    milestoneEventId: string,
  ): Promise<EffectiveRewardEligibility | undefined> {
    validateIdentifier(cohortId);
    validateIdentifier(playerId);
    validateIdentifier(milestoneEventId);
    return this.options.repository.findEffectiveRewardEligibility(
      cohortId,
      playerId,
      milestoneEventId,
    );
  }

  private async authenticate(token: string): Promise<PlayerRecord> {
    if (!token || token.includes(' ') || token.length > 16_384) unauthenticated();
    try {
      const identity = await this.options.jwtVerifier.verify(token);
      const player = await this.options.repository.findPlayerByClerkSubject(identity.subject);
      if (!player) throw new ClosedBetaError(403, 'CLOSED_BETA_FORBIDDEN');
      return player;
    } catch (error) {
      if (error instanceof JwtVerificationError) unauthenticated();
      throw error;
    }
  }
}

export function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value || value.length > maximum) invalidRequest();
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalidRequest();
  }
  return value as number;
}

function validDate(value: unknown): Date {
  if (typeof value !== 'string' || value.length > 100) invalidRequest();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) invalidRequest();
  return parsed;
}

function validDigest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) invalidRequest();
  return value;
}

function validCorrelationId(value: string): string {
  if (
    !value ||
    value.length > 500 ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    invalidRequest();
  }
  return value;
}

function validFeatureFlags(value: unknown): Readonly<Record<string, boolean>> {
  const record = validJsonObject(value);
  const entries = Object.entries(record);
  if (
    entries.length > 100 ||
    entries.some(
      ([key, enabled]) => !/^[a-z][a-z0-9_.-]{0,99}$/i.test(key) || typeof enabled !== 'boolean',
    )
  ) {
    invalidRequest();
  }
  return Object.freeze({ ...(record as Record<string, boolean>) });
}

function validStringList(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maximumItems ||
    value.some((entry) => typeof entry !== 'string' || !entry || entry.length > maximumLength)
  ) {
    invalidRequest();
  }
  return Object.freeze([...new Set(value as string[])]);
}

function validJsonObject(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidRequest();
  try {
    const serialized = canonicalJson(value);
    if (Buffer.byteLength(serialized, 'utf8') > 32_768) invalidRequest();
    return JSON.parse(serialized) as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof JsonResourceLimitError) {
      throw new ClosedBetaError(413, 'CLOSED_BETA_RESOURCE_LIMIT_EXCEEDED');
    }
    throw error;
  }
}

function canonicalJson(value: unknown): string {
  assertJsonWithinResourceLimits(value);
  return canonicalJsonValidated(value);
}

function canonicalJsonValidated(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValidated).join(',')}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonValidated(entry)}`)
    .join(',')}}`;
}

function validateIdentifier(value: string): void {
  if (
    !value ||
    value.length > 200 ||
    [...value].some((character) => character.charCodeAt(0) <= 31)
  ) {
    invalidRequest();
  }
}

function invalidRequest(): never {
  throw new ClosedBetaError(422, 'CLOSED_BETA_REQUEST_INVALID');
}

function invalidInvite(): never {
  throw new ClosedBetaError(403, 'CLOSED_BETA_INVITE_INVALID');
}

function unauthenticated(): never {
  throw new ClosedBetaError(401, 'CLOSED_BETA_AUTHENTICATION_REQUIRED');
}
