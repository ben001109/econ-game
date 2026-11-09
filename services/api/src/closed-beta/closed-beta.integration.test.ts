import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createApiComposition } from '../app-composition.js';
import {
  ClosedBetaError,
  ClosedBetaService,
  type ClosedBetaRepository,
  type CohortDraft,
  type ConsentPolicyDraft,
  type EffectiveRewardEligibility,
  type InviteDraft,
  type OwnerRewardDecision,
  type RewardEvidence,
} from './closed-beta.js';
import { PrismaClosedBetaRepository } from './prisma-closed-beta-repository.js';
import { RoleMatrixAuthorizationPolicy } from '../auth/authorization.js';
import type { JwtVerifier } from '../auth/jwt-verifier.js';
import type {
  ActiveGameScope,
  IdentityScopeRepository,
  TrustedContextSecurityOptions,
} from '../auth/trusted-command-context.js';
import { COMMAND_ENVELOPE_VERSION } from '../commands/command-contract.js';
import {
  CommandDispatcher,
  PersistenceRequiredCommandExecutionStore,
} from '../commands/command-dispatcher.js';

const BASE_TIME = new Date('2030-01-01T00:00:00.000Z');
const POLICY_DIGEST = 'a'.repeat(64);
const ELIGIBILITY_DIGEST = 'b'.repeat(64);

type FakeCohort = CohortDraft & {
  status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'REVOKED';
  entryConsentPolicyId?: string;
};
type FakeInvite = InviteDraft & {
  status: 'DRAFT' | 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';
};
type FakeMembership = {
  id: string;
  cohortId: string;
  playerId: string;
  inviteId: string;
  status: 'ACTIVE' | 'REVOKED';
};
type FakeReward = RewardEvidence & {
  source: 'SERVER_EVENT' | 'MANUAL_ADJUSTMENT' | 'REVOCATION';
  supersedesEligibilityId: string | null;
  actorPlayerId?: string;
};

class FakeClosedBetaRepository implements ClosedBetaRepository {
  readonly durability: 'durable' | 'test';
  readonly players = new Map([
    ['owner-subject', { id: 'owner-player', clerkUserId: 'owner-subject' }],
    ['other-owner-subject', { id: 'other-owner', clerkUserId: 'other-owner-subject' }],
    ['user-one-subject', { id: 'user-one', clerkUserId: 'user-one-subject' }],
    ['user-two-subject', { id: 'user-two', clerkUserId: 'user-two-subject' }],
  ]);
  readonly owners = new Map([
    ['tenant-one', new Set(['owner-player'])],
    ['tenant-two', new Set(['other-owner'])],
  ]);
  readonly cohorts = new Map<string, FakeCohort>();
  readonly policies = new Map<string, ConsentPolicyDraft>();
  readonly invites = new Map<string, FakeInvite>();
  readonly memberships = new Map<string, FakeMembership>();
  readonly decisions: Array<{
    policyId: string;
    playerId: string;
    decision: 'ACCEPTED' | 'WITHDRAWN';
    at: Date;
    retentionUntil: Date;
    decisionSequence: number;
  }> = [];
  readonly rewards: FakeReward[] = [];
  readonly audit: unknown[] = [];
  private serialization = Promise.resolve();

  constructor(durability: 'durable' | 'test' = 'test') {
    this.durability = durability;
  }

  async findPlayerByClerkSubject(subject: string) {
    return this.players.get(subject);
  }

  async createCohort(input: CohortDraft) {
    this.assertOwner(input.createdByPlayerId, input.restaurantId);
    this.cohorts.set(input.id, { ...input, status: 'DRAFT' });
    this.audit.push({
      action: 'cohort-created',
      cohortId: input.id,
      correlationId: input.correlationId,
    });
  }

  async createConsentPolicy(input: ConsentPolicyDraft) {
    const cohort = this.cohort(input.cohortId);
    this.assertOwner(input.createdByPlayerId, cohort.restaurantId);
    if (cohort.status !== 'DRAFT') conflict();
    this.policies.set(input.id, input);
    this.audit.push({
      action: 'policy-created',
      policyDigest: input.policyDigest,
      correlationId: input.correlationId,
    });
  }

  async openCohort(input: {
    cohortId: string;
    entryConsentPolicyId: string;
    actorPlayerId: string;
    openedAt: Date;
    auditId: string;
  }) {
    const cohort = this.cohort(input.cohortId);
    this.assertOwner(input.actorPlayerId, cohort.restaurantId);
    const policy = this.policies.get(input.entryConsentPolicyId);
    if (
      cohort.status !== 'DRAFT' ||
      !policy ||
      policy.cohortId !== cohort.id ||
      !policy.requiredForEntry
    ) {
      conflict();
    }
    cohort.status = 'OPEN';
    cohort.entryConsentPolicyId = policy.id;
  }

  async closeCohort(input: {
    cohortId: string;
    action: 'close' | 'revoke';
    actorPlayerId: string;
    occurredAt: Date;
    auditId: string;
  }) {
    const cohort = this.cohort(input.cohortId);
    this.assertOwner(input.actorPlayerId, cohort.restaurantId);
    cohort.status = input.action === 'close' ? 'CLOSED' : 'REVOKED';
  }

  async createInvite(input: InviteDraft) {
    const cohort = this.cohort(input.cohortId);
    this.assertOwner(input.issuedByPlayerId, cohort.restaurantId);
    if (![...this.players.values()].some((player) => player.id === input.invitedPlayerId))
      forbidden();
    this.invites.set(input.id, { ...input, status: 'DRAFT' });
    this.audit.push({
      action: 'invite-created',
      inviteId: input.id,
      correlationId: input.correlationId,
    });
  }

  async activateInvite(input: {
    cohortId: string;
    inviteId: string;
    actorPlayerId: string;
    activatedAt: Date;
    auditId: string;
    correlationId: string;
  }) {
    const cohort = this.cohort(input.cohortId);
    this.assertOwner(input.actorPlayerId, cohort.restaurantId);
    const invite = this.invites.get(input.inviteId);
    if (!invite || invite.cohortId !== cohort.id || invite.status !== 'DRAFT') conflict();
    invite.status = 'ACTIVE';
  }

  async revokeInvite(input: {
    cohortId: string;
    inviteId: string;
    actorPlayerId: string;
    revokedAt: Date;
    auditId: string;
    correlationId: string;
  }) {
    return this.atomic(async () => {
      const invite = this.invites.get(input.inviteId);
      if (!invite || invite.cohortId !== input.cohortId) conflict();
      const cohort = this.cohort(invite.cohortId);
      this.assertOwner(input.actorPlayerId, cohort.restaurantId);
      if (!['DRAFT', 'ACTIVE'].includes(invite.status)) conflict();
      invite.status = 'REVOKED';
      this.audit.push({
        action: 'invite-revoked',
        inviteId: invite.id,
        correlationId: input.correlationId,
      });
    });
  }

  redeemInvite(input: {
    tokenDigest: string;
    actorPlayerId: string;
    redeemedAt: Date;
    membershipId: string;
    auditId: string;
    correlationId: string;
  }): Promise<'redeemed' | 'invalid'> {
    return this.atomic(async () => {
      const invite = [...this.invites.values()].find(
        (candidate) => candidate.tokenDigest === input.tokenDigest,
      );
      if (
        !invite ||
        invite.status !== 'ACTIVE' ||
        invite.invitedPlayerId !== input.actorPlayerId ||
        invite.expiresAt <= input.redeemedAt
      ) {
        if (invite?.status === 'ACTIVE' && invite.expiresAt <= input.redeemedAt) {
          invite.status = 'EXPIRED';
          this.audit.push({
            action: 'invite-expired-on-redeem',
            inviteId: invite.id,
            correlationId: input.correlationId,
          });
        }
        return 'invalid';
      }
      const cohort = this.cohort(invite.cohortId);
      const occupied = [...this.memberships.values()].filter(
        (membership) => membership.cohortId === cohort.id && membership.status === 'ACTIVE',
      ).length;
      const alreadyJoined = [...this.memberships.values()].some(
        (membership) =>
          membership.cohortId === cohort.id && membership.playerId === input.actorPlayerId,
      );
      if (
        cohort.status !== 'OPEN' ||
        cohort.opensAt > input.redeemedAt ||
        cohort.closesAt <= input.redeemedAt ||
        !cohort.entryConsentPolicyId ||
        occupied >= cohort.quota ||
        alreadyJoined
      ) {
        return 'invalid';
      }
      invite.status = 'CONSUMED';
      this.memberships.set(input.membershipId, {
        id: input.membershipId,
        cohortId: cohort.id,
        playerId: input.actorPlayerId,
        inviteId: invite.id,
        status: 'ACTIVE',
      });
      this.audit.push({
        action: 'invite-redeemed',
        inviteId: invite.id,
        correlationId: input.correlationId,
      });
      return 'redeemed';
    });
  }

  recordConsentDecision(input: {
    policyId: string;
    actorPlayerId: string;
    decision: 'ACCEPTED' | 'WITHDRAWN';
    decidedAt: Date;
    decisionId: string;
    auditId: string;
    correlationId: string;
  }): Promise<'accepted' | 'withdrawn' | 'invalid'> {
    return this.atomic(async () => {
      const policy = this.policies.get(input.policyId);
      if (!policy) return 'invalid';
      const membership = [...this.memberships.values()].find(
        (candidate) =>
          candidate.cohortId === policy.cohortId && candidate.playerId === input.actorPlayerId,
      );
      const latest = this.decisions
        .filter(
          (decision) =>
            decision.policyId === policy.id && decision.playerId === input.actorPlayerId,
        )
        .at(-1);
      if (
        !membership ||
        (input.decision === 'ACCEPTED' &&
          (membership.status !== 'ACTIVE' || latest?.decision === 'ACCEPTED')) ||
        (input.decision === 'WITHDRAWN' && latest?.decision !== 'ACCEPTED')
      ) {
        return 'invalid';
      }
      this.decisions.push({
        policyId: policy.id,
        playerId: input.actorPlayerId,
        decision: input.decision,
        at: input.decidedAt,
        retentionUntil:
          latest?.retentionUntil ??
          new Date(input.decidedAt.getTime() + policy.retentionDays * 24 * 60 * 60_000),
        decisionSequence: this.decisions.length + 1,
      });
      this.audit.push({
        action: input.decision === 'ACCEPTED' ? 'consent-accepted' : 'consent-withdrawn',
        actorPlayerId: input.actorPlayerId,
        policyDigest: policy.policyDigest,
        correlationId: input.correlationId,
      });
      return input.decision === 'ACCEPTED' ? 'accepted' : 'withdrawn';
    });
  }

  async revokeMembership(input: {
    cohortId: string;
    playerId: string;
    actorPlayerId: string;
    reason: string;
    revokedAt: Date;
    auditId: string;
  }) {
    const cohort = this.cohort(input.cohortId);
    this.assertOwner(input.actorPlayerId, cohort.restaurantId);
    const membership = [...this.memberships.values()].find(
      (candidate) => candidate.cohortId === input.cohortId && candidate.playerId === input.playerId,
    );
    if (!membership || membership.status !== 'ACTIVE') conflict();
    membership.status = 'REVOKED';
  }

  async isEntranceEligible(playerId: string, tenantId: string, checkedAt: Date) {
    return [...this.memberships.values()].some((membership) => {
      const cohort = this.cohorts.get(membership.cohortId);
      if (
        !cohort ||
        membership.playerId !== playerId ||
        membership.status !== 'ACTIVE' ||
        cohort.restaurantId !== tenantId ||
        cohort.status !== 'OPEN' ||
        cohort.opensAt > checkedAt ||
        cohort.closesAt <= checkedAt ||
        !cohort.entryConsentPolicyId
      ) {
        return false;
      }
      const latest = this.decisions
        .filter(
          (decision) =>
            decision.playerId === playerId && decision.policyId === cohort.entryConsentPolicyId,
        )
        .at(-1);
      return latest?.decision === 'ACCEPTED' && latest.retentionUntil > checkedAt;
    });
  }

  async recordServerRewardEligibility(input: RewardEvidence) {
    const cohort = this.cohort(input.cohortId);
    if (
      ![...this.memberships.values()].some(
        (membership) => membership.cohortId === cohort.id && membership.playerId === input.playerId,
      )
    ) {
      forbidden();
    }
    if (
      this.rewards.some(
        (reward) =>
          reward.source === 'SERVER_EVENT' &&
          reward.cohortId === input.cohortId &&
          reward.playerId === input.playerId &&
          reward.milestoneEventId === input.milestoneEventId,
      )
    ) {
      conflict();
    }
    this.rewards.push({ ...input, source: 'SERVER_EVENT', supersedesEligibilityId: null });
    this.audit.push({
      action: 'reward-recorded',
      eligibilityId: input.eligibilityId,
      correlationId: input.correlationId,
    });
  }

  recordOwnerRewardDecision(input: OwnerRewardDecision): Promise<void> {
    return this.atomic(async () => {
      const cohort = this.cohort(input.cohortId);
      this.assertOwner(input.actorPlayerId, cohort.restaurantId);
      const target = this.rewards.find(
        (reward) =>
          reward.eligibilityId === input.supersedesEligibilityId &&
          reward.cohortId === input.cohortId,
      );
      const alreadySuperseded = this.rewards.some(
        (reward) => reward.supersedesEligibilityId === input.supersedesEligibilityId,
      );
      if (!target || target.source === 'REVOCATION' || alreadySuperseded) conflict();
      this.rewards.push({
        ...target,
        eligible: input.eligible,
        source: input.source,
        reason: input.reason,
        actorPlayerId: input.actorPlayerId,
        decidedAt: input.decidedAt,
        eligibilityId: input.eligibilityId,
        auditId: input.auditId,
        correlationId: input.correlationId,
        supersedesEligibilityId: target.eligibilityId,
      });
      this.audit.push({
        action: input.source === 'REVOCATION' ? 'reward-revoked' : 'reward-adjusted',
        reason: input.reason,
        actorPlayerId: input.actorPlayerId,
        targetEligibilityId: target.eligibilityId,
        milestoneEventId: target.milestoneEventId,
        correlationId: input.correlationId,
      });
    });
  }

  async findEffectiveRewardEligibility(
    cohortId: string,
    playerId: string,
    milestoneEventId: string,
  ): Promise<EffectiveRewardEligibility | undefined> {
    const current = this.rewards.find(
      (reward) =>
        reward.cohortId === cohortId &&
        reward.playerId === playerId &&
        reward.milestoneEventId === milestoneEventId &&
        !this.rewards.some(
          (successor) => successor.supersedesEligibilityId === reward.eligibilityId,
        ),
    );
    if (!current) return undefined;
    return {
      eligibilityId: current.eligibilityId,
      rewardKind: current.rewardKind,
      eligible: current.eligible,
      source: current.source,
      supersedesEligibilityId: current.supersedesEligibilityId,
    };
  }

  private cohort(id: string) {
    const cohort = this.cohorts.get(id);
    if (!cohort) forbidden();
    return cohort;
  }

  private assertOwner(playerId: string, tenantId: string) {
    if (!this.owners.get(tenantId)?.has(playerId)) forbidden();
  }

  private atomic<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serialization.then(operation, operation);
    this.serialization = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const jwtVerifier: JwtVerifier = {
  async verify(token) {
    const subjects: Record<string, string> = {
      'jwt-owner': 'owner-subject',
      'jwt-other-owner': 'other-owner-subject',
      'jwt-user-one': 'user-one-subject',
      'jwt-user-two': 'user-two-subject',
    };
    const subject = subjects[token];
    if (!subject) throw new Error('test token not provisioned');
    return {
      subject,
      issuer: 'local',
      audience: ['api'],
      authorizedParty: 'test',
      expiresAt: 2_000_000_000,
    };
  },
};

function serviceFixture(repository = new FakeClosedBetaRepository()) {
  let sequence = 0;
  let tokenSequence = 0;
  let now = new Date(BASE_TIME);
  const service = new ClosedBetaService({
    jwtVerifier,
    repository,
    now: () => new Date(now),
    randomToken: () => `A${'b'.repeat(40)}${String(++tokenSequence).padStart(2, '0')}`,
    randomId: () => `id-${++sequence}`,
  });
  return {
    service,
    repository,
    setNow(value: Date) {
      now = new Date(value);
    },
  };
}

function cohortPayload(quota = 2) {
  return {
    name: 'MVP invite cohort',
    purpose: 'Closed beta verification',
    environment: 'local-test',
    quota,
    opensAt: '2029-12-31T23:00:00.000Z',
    closesAt: '2030-01-08T00:00:00.000Z',
    featureFlags: { coreEconomy: true, ai: false },
    eligibilityPolicyVersion: 'milestone-v1',
    eligibilityPolicyDigest: ELIGIBILITY_DIGEST,
  };
}

function policyPayload() {
  return {
    purpose: 'closed_beta_participation',
    version: 'consent-v1',
    policyDigest: POLICY_DIGEST,
    scope: { tenant: 'tenant-one', collection: 'minimum-required' },
    dataCategories: ['identity_reference', 'security_audit'],
    retentionDays: 30,
    requiredForEntry: true,
  };
}

async function bootstrap(
  fixture: ReturnType<typeof serviceFixture>,
  quota = 2,
): Promise<{ cohortId: string; policyId: string }> {
  const cohort = await fixture.service.createCohort(
    'jwt-owner',
    'tenant-one',
    cohortPayload(quota),
  );
  const policy = await fixture.service.createConsentPolicy('jwt-owner', cohort.id, policyPayload());
  await fixture.service.openCohort('jwt-owner', cohort.id, policy.id);
  return { cohortId: cohort.id, policyId: policy.id };
}

async function issue(
  fixture: ReturnType<typeof serviceFixture>,
  cohortId: string,
  playerId: string,
) {
  const invitation = await fixture.service.createInvite('jwt-owner', cohortId, {
    invitedPlayerId: playerId,
    ttlSeconds: 3_600,
  });
  await fixture.service.activateInvite('jwt-owner', cohortId, invitation.id);
  return invitation;
}

test('default routes are leak-free 503 and test repositories cannot use the production option', async () => {
  const defaultApp = createApiComposition();
  const unavailable = await defaultApp.inject({
    method: 'POST',
    url: '/closed-beta/invites/redeem',
    headers: { authorization: 'Bearer attacker' },
    payload: { token: `A${'b'.repeat(42)}` },
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(errorCode(unavailable), 'CLOSED_BETA_NOT_CONFIGURED');
  assert.equal(unavailable.body.includes('attacker'), false);
  assert.equal(unavailable.body.includes('bbbb'), false);
  await defaultApp.close();

  const fixture = serviceFixture();
  const productionOptionApp = createApiComposition({ closedBetaService: fixture.service });
  const rejected = await productionOptionApp.inject({
    method: 'GET',
    url: '/closed-beta/tenants/tenant-one/eligibility',
    headers: { authorization: 'Bearer jwt-user-one' },
  });
  assert.equal(rejected.statusCode, 503);
  await productionOptionApp.close();
});

test('production composition executes a configured Prisma durable adapter route and passes only the invite digest', async () => {
  const rawToken = `Z${'x'.repeat(42)}`;
  const calls: Array<{ query: string; values: readonly unknown[] }> = [];
  const database = {
    async $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T> {
      calls.push({ query, values });
      if (query.includes('FROM "Player"')) {
        return [{ id: 'user-one', clerkUserId: 'user-one-subject' }] as T;
      }
      if (query.includes('d05_redeem_invite')) return [{ result: 'redeemed' }] as T;
      throw new Error('unexpected durable adapter query');
    },
    async $transaction<T>(
      operation: (transaction: {
        $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T>;
      }) => Promise<T>,
    ): Promise<T> {
      return operation(database);
    },
  };
  const durableService = new ClosedBetaService({
    jwtVerifier,
    repository: new PrismaClosedBetaRepository(database),
    now: () => new Date(BASE_TIME),
    randomId: (() => {
      let sequence = 0;
      return () => `durable-id-${++sequence}`;
    })(),
  });
  const app = createApiComposition({ closedBetaService: durableService });
  const response = await app.inject({
    method: 'POST',
    url: '/closed-beta/invites/redeem',
    headers: {
      authorization: 'Bearer jwt-user-one',
      'x-correlation-id': 'client-correlation-must-not-bind',
    },
    payload: { token: rawToken },
  });
  assert.equal(response.statusCode, 204);
  const serializedCalls = JSON.stringify(calls);
  assert.equal(serializedCalls.includes(rawToken), false);
  assert.equal(serializedCalls.includes(createHash('sha256').update(rawToken).digest('hex')), true);
  const redemptionCall = calls.find((call) => call.query.includes('d05_redeem_invite'));
  assert.match(String(redemptionCall?.values[5]), /^req-/);
  assert.notEqual(redemptionCall?.values[5], 'client-correlation-must-not-bind');
  await app.close();
});

test('durable revoke route makes missing, terminal, and cross-tenant invite probes leak-equivalent', async () => {
  const calls: Array<{ query: string; values: readonly unknown[] }> = [];
  const database = {
    async $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T> {
      calls.push({ query, values });
      if (query.includes('FROM "Player"')) {
        return [{ id: 'owner-player', clerkUserId: 'owner-subject' }] as T;
      }
      if (query.includes('d05_revoke_invite')) {
        return [{ result: values[0] === 'invite-valid-owner' ? 'revoked' : 'invalid' }] as T;
      }
      throw new Error('raw durable adapter detail must not escape');
    },
    async $transaction<T>(
      operation: (transaction: {
        $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T>;
      }) => Promise<T>,
    ): Promise<T> {
      return operation(database);
    },
  };
  const service = new ClosedBetaService({
    jwtVerifier,
    repository: new PrismaClosedBetaRepository(database),
    now: () => new Date(BASE_TIME),
    randomId: (() => {
      let sequence = 0;
      return () => `durable-revoke-id-${++sequence}`;
    })(),
  });
  const app = createApiComposition({ closedBetaService: service });
  const probes = [
    { cohortId: 'cohort-owned', inviteId: 'invite-missing' },
    { cohortId: 'cohort-owned', inviteId: 'invite-terminal' },
    { cohortId: 'cohort-other-tenant', inviteId: 'invite-cross-tenant-active' },
  ];
  const responses = await Promise.all(
    probes.map(({ cohortId, inviteId }) =>
      app.inject({
        method: 'POST',
        url: `/closed-beta/cohorts/${cohortId}/invites/${inviteId}/revoke`,
        headers: { authorization: 'Bearer jwt-owner', cookie: 'session=probe-secret' },
        payload: {},
      }),
    ),
  );
  const envelopes = responses.map((response) => ({
    statusCode: response.statusCode,
    body: response.body,
    contentType: response.headers['content-type'],
  }));
  assert.deepEqual(envelopes[1], envelopes[0]);
  assert.deepEqual(envelopes[2], envelopes[0]);
  assert.equal(envelopes[0].statusCode, 403);
  assert.equal(errorCode(responses[0]), 'CLOSED_BETA_FORBIDDEN');
  for (const { body } of envelopes) {
    assert.equal(body.includes('invite-missing'), false);
    assert.equal(body.includes('invite-terminal'), false);
    assert.equal(body.includes('invite-cross-tenant-active'), false);
    assert.equal(body.includes('cohort-other-tenant'), false);
    assert.equal(body.includes('probe-secret'), false);
    assert.equal(body.includes('raw durable adapter detail'), false);
  }

  const valid = await app.inject({
    method: 'POST',
    url: '/closed-beta/cohorts/cohort-owned/invites/invite-valid-owner/revoke',
    headers: { authorization: 'Bearer jwt-owner' },
    payload: {},
  });
  assert.equal(valid.statusCode, 204);
  const revokeCalls = calls.filter((call) => call.query.includes('d05_revoke_invite'));
  assert.equal(revokeCalls.length, 4);
  for (const call of revokeCalls) {
    assert.equal(call.values[2], 'owner-player');
    assert.match(String(call.values[5]), /^req-/);
  }
  await app.close();
});

test('durable invite races translate database deadlock and serialization errors without leaking internals', async () => {
  const rawFailure = 'raw database deadlock cookie=session-secret';
  const database = {
    async $queryRawUnsafe<T>(query: string): Promise<T> {
      if (query.includes('FROM "Player"')) {
        return [{ id: 'user-one', clerkUserId: 'user-one-subject' }] as T;
      }
      if (query.includes('d05_redeem_invite')) {
        throw Object.assign(new Error(rawFailure), {
          cause: { sqlState: '40001' },
        });
      }
      if (query.includes('d05_revoke_invite')) {
        throw Object.assign(new Error(rawFailure), {
          code: 'P2034',
          meta: { database_error_code: '40P01' },
        });
      }
      throw new Error('unexpected durable adapter query');
    },
    async $transaction<T>(
      operation: (transaction: {
        $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T>;
      }) => Promise<T>,
    ): Promise<T> {
      return operation(database);
    },
  };
  const repository = new PrismaClosedBetaRepository(database);
  await assert.rejects(
    repository.revokeInvite({
      cohortId: 'cohort-race',
      inviteId: 'invite-race',
      actorPlayerId: 'owner-player',
      revokedAt: BASE_TIME,
      auditId: 'audit-race',
      correlationId: 'server-race-correlation',
    }),
    (error: unknown) =>
      error instanceof ClosedBetaError &&
      error.status === 409 &&
      error.code === 'CLOSED_BETA_STATE_CONFLICT',
  );

  const durableService = new ClosedBetaService({
    jwtVerifier,
    repository,
    now: () => new Date(BASE_TIME),
    randomId: () => 'server-race-id',
  });
  const app = createApiComposition({ closedBetaService: durableService });
  const response = await app.inject({
    method: 'POST',
    url: '/closed-beta/invites/redeem',
    headers: { authorization: 'Bearer jwt-user-one', cookie: 'session=route-secret' },
    payload: { token: `R${'x'.repeat(42)}` },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(errorCode(response), 'CLOSED_BETA_INVITE_INVALID');
  assert.equal(response.body.includes(rawFailure), false);
  assert.equal(response.body.includes('session-secret'), false);
  assert.equal(response.body.includes('route-secret'), false);
  await app.close();
});

test('each retryable database code has isolated stable activate, revoke, and redeem mappings', async () => {
  const stableConflict = (error: unknown) =>
    error instanceof ClosedBetaError &&
    error.status === 409 &&
    error.code === 'CLOSED_BETA_STATE_CONFLICT' &&
    !error.message.includes('raw retry detail');

  for (const retryCode of ['P2034', '40P01', '40001'] as const) {
    const database = {
      async $queryRawUnsafe<T>(): Promise<T> {
        throw Object.assign(new Error(`raw retry detail ${retryCode}`), { code: retryCode });
      },
      async $transaction<T>(
        operation: (transaction: {
          $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T>;
        }) => Promise<T>,
      ): Promise<T> {
        return operation(database);
      },
    };
    const repository = new PrismaClosedBetaRepository(database);
    await assert.rejects(
      repository.activateInvite({
        cohortId: 'cohort-retry',
        inviteId: 'invite-retry',
        actorPlayerId: 'owner-player',
        activatedAt: BASE_TIME,
        auditId: 'audit-activate-retry',
        correlationId: 'activate-retry-correlation',
      }),
      stableConflict,
      `activate did not map isolated ${retryCode}`,
    );
    await assert.rejects(
      repository.revokeInvite({
        cohortId: 'cohort-retry',
        inviteId: 'invite-retry',
        actorPlayerId: 'owner-player',
        revokedAt: BASE_TIME,
        auditId: 'audit-revoke-retry',
        correlationId: 'revoke-retry-correlation',
      }),
      stableConflict,
      `revoke did not map isolated ${retryCode}`,
    );
    assert.equal(
      await repository.redeemInvite({
        tokenDigest: 'a'.repeat(64),
        actorPlayerId: 'user-one',
        redeemedAt: BASE_TIME,
        membershipId: 'membership-retry',
        auditId: 'audit-redeem-retry',
        correlationId: 'redeem-retry-correlation',
      }),
      'invalid',
      `redeem did not map isolated ${retryCode}`,
    );
  }
});

test('configured Fastify routes enforce OWNER scope, exact bodies, own redemption, consent-first eligibility, and revocation', async () => {
  const fixture = serviceFixture();
  const app = createApiComposition({ testOnlyClosedBetaService: fixture.service });

  const attacked = await app.inject({
    method: 'POST',
    url: '/closed-beta/tenants/tenant-one/cohorts',
    headers: { authorization: 'Bearer jwt-owner' },
    payload: { ...cohortPayload(), actorPlayerId: 'attacker' },
  });
  assert.equal(attacked.statusCode, 422);

  const crossTenant = await app.inject({
    method: 'POST',
    url: '/closed-beta/tenants/tenant-two/cohorts',
    headers: { authorization: 'Bearer jwt-owner' },
    payload: cohortPayload(),
  });
  assert.equal(crossTenant.statusCode, 403);

  const cohortResponse = await app.inject({
    method: 'POST',
    url: '/closed-beta/tenants/tenant-one/cohorts',
    headers: { authorization: 'Bearer jwt-owner', cookie: 'session=must-not-appear' },
    payload: cohortPayload(),
  });
  assert.equal(cohortResponse.statusCode, 201);
  const cohortId = (cohortResponse.json() as { id: string }).id;
  const policyResponse = await app.inject({
    method: 'POST',
    url: `/closed-beta/cohorts/${cohortId}/consent-policies`,
    headers: { authorization: 'Bearer jwt-owner' },
    payload: policyPayload(),
  });
  assert.equal(policyResponse.statusCode, 201);
  const policyId = (policyResponse.json() as { id: string }).id;
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/closed-beta/cohorts/${cohortId}/open`,
        headers: { authorization: 'Bearer jwt-owner' },
        payload: { entryConsentPolicyId: policyId },
      })
    ).statusCode,
    204,
  );
  const inviteResponse = await app.inject({
    method: 'POST',
    url: `/closed-beta/cohorts/${cohortId}/invites`,
    headers: { authorization: 'Bearer jwt-owner' },
    payload: { invitedPlayerId: 'user-one', ttlSeconds: 3_600 },
  });
  assert.equal(inviteResponse.statusCode, 201);
  const invitation = inviteResponse.json() as { id: string; token: string };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/closed-beta/cohorts/${cohortId}/invites/${invitation.id}/activate`,
        headers: { authorization: 'Bearer jwt-owner' },
        payload: {},
      })
    ).statusCode,
    204,
  );
  const wrongUser = await app.inject({
    method: 'POST',
    url: '/closed-beta/invites/redeem',
    headers: { authorization: 'Bearer jwt-user-two' },
    payload: { token: invitation.token },
  });
  assert.equal(wrongUser.statusCode, 403);
  assert.equal(errorCode(wrongUser), 'CLOSED_BETA_INVITE_INVALID');

  const [first, second] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/closed-beta/invites/redeem',
      headers: { authorization: 'Bearer jwt-user-one' },
      payload: { token: invitation.token },
    }),
    app.inject({
      method: 'POST',
      url: '/closed-beta/invites/redeem',
      headers: { authorization: 'Bearer jwt-user-one' },
      payload: { token: invitation.token },
    }),
  ]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [204, 403]);
  assert.equal(fixture.repository.memberships.size, 1);
  assert.equal(JSON.stringify(fixture.repository.audit).includes(invitation.token), false);
  assert.equal(
    [...fixture.repository.invites.values()][0].tokenDigest,
    createHash('sha256').update(invitation.token).digest('hex'),
  );

  const beforeConsent = await app.inject({
    method: 'GET',
    url: '/closed-beta/tenants/tenant-one/eligibility',
    headers: { authorization: 'Bearer jwt-user-one' },
  });
  assert.deepEqual(beforeConsent.json(), { eligible: false });
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/closed-beta/consent-policies/${policyId}/accept`,
        headers: { authorization: 'Bearer jwt-user-one' },
        payload: {},
      })
    ).statusCode,
    204,
  );
  assert.deepEqual(
    (
      await app.inject({
        method: 'GET',
        url: '/closed-beta/tenants/tenant-one/eligibility',
        headers: { authorization: 'Bearer jwt-user-one' },
      })
    ).json(),
    { eligible: true },
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/closed-beta/consent-policies/${policyId}/withdraw`,
        headers: { authorization: 'Bearer jwt-user-one' },
        payload: {},
      })
    ).statusCode,
    204,
  );
  assert.equal(
    await fixture.repository.isEntranceEligible('user-one', 'tenant-one', BASE_TIME),
    false,
  );
  await app.close();
});

test('routes use the server request id for audit correlation and reject client correlation fields', async () => {
  const fixture = serviceFixture();
  const app = createApiComposition({ testOnlyClosedBetaService: fixture.service });
  const spoofed = await app.inject({
    method: 'POST',
    url: '/closed-beta/tenants/tenant-one/cohorts',
    headers: {
      authorization: 'Bearer jwt-owner',
      'x-correlation-id': 'attacker-controlled-correlation',
      cookie: 'session=trace-secret',
    },
    payload: { ...cohortPayload(), correlationId: 'body-controlled-correlation' },
  });
  assert.equal(spoofed.statusCode, 422);

  const accepted = await app.inject({
    method: 'POST',
    url: '/closed-beta/tenants/tenant-one/cohorts',
    headers: {
      authorization: 'Bearer jwt-owner',
      'x-correlation-id': 'attacker-controlled-correlation',
      cookie: 'session=trace-secret',
    },
    payload: cohortPayload(),
  });
  assert.equal(accepted.statusCode, 201);
  const audit = fixture.repository.audit.at(-1) as { correlationId?: string };
  assert.match(audit.correlationId ?? '', /^req-/);
  assert.notEqual(audit.correlationId, 'attacker-controlled-correlation');
  assert.equal(JSON.stringify(fixture.repository.audit).includes('trace-secret'), false);
  await app.close();
});

test('expired redemption stays generic while atomically expiring and digest-free auditing the invite', async () => {
  const fixture = serviceFixture();
  const { cohortId } = await bootstrap(fixture);
  const invitation = await issue(fixture, cohortId, 'user-one');
  fixture.setNow(new Date('2030-01-01T02:00:00.000Z'));
  const app = createApiComposition({ testOnlyClosedBetaService: fixture.service });
  const response = await app.inject({
    method: 'POST',
    url: '/closed-beta/invites/redeem',
    headers: { authorization: 'Bearer jwt-user-one' },
    payload: { token: invitation.token },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(errorCode(response), 'CLOSED_BETA_INVITE_INVALID');
  assert.equal(response.body.includes(invitation.id), false);
  assert.equal(response.body.includes(invitation.token), false);
  assert.equal(fixture.repository.invites.get(invitation.id)?.status, 'EXPIRED');
  const audit = fixture.repository.audit.at(-1) as Record<string, unknown>;
  assert.equal(audit.action, 'invite-expired-on-redeem');
  assert.equal(audit.inviteId, invitation.id);
  assert.match(String(audit.correlationId), /^req-/);
  assert.equal(JSON.stringify(audit).includes(invitation.token), false);
  assert.equal(
    JSON.stringify(audit).includes(createHash('sha256').update(invitation.token).digest('hex')),
    false,
  );
  await app.close();
});

test('atomic cohort quota admits only one of two different users and tokens', async () => {
  const fixture = serviceFixture();
  const { cohortId } = await bootstrap(fixture, 1);
  const first = await issue(fixture, cohortId, 'user-one');
  const second = await issue(fixture, cohortId, 'user-two');
  const outcomes = await Promise.allSettled([
    fixture.service.redeemInvite('jwt-user-one', first.token),
    fixture.service.redeemInvite('jwt-user-two', second.token),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(
    [...fixture.repository.memberships.values()].filter(
      (membership) => membership.status === 'ACTIVE',
    ).length,
    1,
  );
});

test('concurrent invite revoke and redeem produce one terminal state, audit, and quota outcome', async () => {
  const fixture = serviceFixture();
  const { cohortId } = await bootstrap(fixture, 1);
  const invitation = await issue(fixture, cohortId, 'user-one');
  const outcomes = await Promise.allSettled([
    fixture.service.redeemInvite('jwt-user-one', invitation.token, 'redeem-race-correlation'),
    fixture.service.revokeInvite('jwt-owner', cohortId, invitation.id, 'revoke-race-correlation'),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);

  const status = fixture.repository.invites.get(invitation.id)?.status;
  assert.ok(status === 'CONSUMED' || status === 'REVOKED');
  const activeMemberships = [...fixture.repository.memberships.values()].filter(
    (membership) => membership.cohortId === cohortId && membership.status === 'ACTIVE',
  );
  assert.equal(activeMemberships.length, status === 'CONSUMED' ? 1 : 0);
  const terminalAudits = fixture.repository.audit.filter((entry) => {
    const audit = entry as { action?: string; inviteId?: string };
    return (
      audit.inviteId === invitation.id &&
      (audit.action === 'invite-redeemed' || audit.action === 'invite-revoked')
    );
  });
  assert.equal(terminalAudits.length, 1);
  assert.equal(
    (terminalAudits[0] as { action: string }).action,
    status === 'CONSUMED' ? 'invite-redeemed' : 'invite-revoked',
  );
});

test('same user concurrent consent acceptance records exactly one durable decision', async () => {
  const fixture = serviceFixture();
  const { cohortId, policyId } = await bootstrap(fixture);
  const invitation = await issue(fixture, cohortId, 'user-one');
  await fixture.service.redeemInvite('jwt-user-one', invitation.token);
  const outcomes = await Promise.allSettled([
    fixture.service.decideConsent('jwt-user-one', policyId, 'ACCEPTED'),
    fixture.service.decideConsent('jwt-user-one', policyId, 'ACCEPTED'),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(
    fixture.repository.decisions.filter(
      (decision) =>
        decision.playerId === 'user-one' &&
        decision.policyId === policyId &&
        decision.decision === 'ACCEPTED',
    ).length,
    1,
  );
});

test('consent expiry, membership revoke, and cohort revoke fail closed', async () => {
  const fixture = serviceFixture();
  const { cohortId, policyId } = await bootstrap(fixture);
  const invitation = await issue(fixture, cohortId, 'user-one');
  await fixture.service.redeemInvite('jwt-user-one', invitation.token);
  await fixture.service.decideConsent('jwt-user-one', policyId, 'ACCEPTED');
  assert.equal(
    await fixture.repository.isEntranceEligible('user-one', 'tenant-one', BASE_TIME),
    true,
  );

  fixture.setNow(new Date('2030-02-01T00:00:00.000Z'));
  assert.equal(
    await fixture.repository.isEntranceEligible(
      'user-one',
      'tenant-one',
      new Date('2030-02-01T00:00:00.000Z'),
    ),
    false,
  );
  fixture.setNow(BASE_TIME);
  await fixture.service.revokeMembership('jwt-owner', cohortId, 'user-one', 'security review');
  assert.equal(
    await fixture.repository.isEntranceEligible('user-one', 'tenant-one', BASE_TIME),
    false,
  );

  const secondFixture = serviceFixture();
  const second = await bootstrap(secondFixture);
  const secondInvite = await issue(secondFixture, second.cohortId, 'user-one');
  await secondFixture.service.redeemInvite('jwt-user-one', secondInvite.token);
  await secondFixture.service.decideConsent('jwt-user-one', second.policyId, 'ACCEPTED');
  await secondFixture.service.closeCohort('jwt-owner', second.cohortId, 'revoke');
  assert.equal(
    await secondFixture.repository.isEntranceEligible('user-one', 'tenant-one', BASE_TIME),
    false,
  );
});

test('reward eligibility uses server evidence, canonical hash, and only non-competitive rewards independent of optional consent', async () => {
  const fixture = serviceFixture();
  const { cohortId } = await bootstrap(fixture);
  const invitation = await issue(fixture, cohortId, 'user-one');
  await fixture.service.redeemInvite('jwt-user-one', invitation.token);
  await fixture.service.recordServerMilestoneEligibility({
    cohortId,
    playerId: 'user-one',
    milestoneEventId: 'milestone-event-1',
    evidenceSnapshot: { completed: true, businessDay: 3 },
    eligible: true,
    rewardKind: 'TITLE',
    reason: 'server milestone satisfied',
  });
  assert.equal(fixture.repository.rewards.length, 1);
  assert.match(fixture.repository.rewards[0].evidenceHash, /^[0-9a-f]{64}$/);
  await assert.rejects(
    fixture.service.recordServerMilestoneEligibility({
      cohortId,
      playerId: 'user-one',
      milestoneEventId: 'milestone-event-2',
      evidenceSnapshot: { completed: true },
      eligible: true,
      rewardKind: 'CASH',
      reason: 'not allowed',
    }),
    (error: unknown) => error instanceof ClosedBetaError && error.status === 422,
  );
});

test('manual reward adjustment and revocation require an exact current target and retain authoritative evidence', async () => {
  const fixture = serviceFixture();
  const { cohortId } = await bootstrap(fixture);
  const invitation = await issue(fixture, cohortId, 'user-one');
  await fixture.service.redeemInvite('jwt-user-one', invitation.token);
  await fixture.service.recordServerMilestoneEligibility({
    cohortId,
    playerId: 'user-one',
    milestoneEventId: 'server-event-1',
    evidenceSnapshot: { completed: true, businessDay: 3 },
    eligible: false,
    rewardKind: 'COSMETIC',
    reason: 'server event snapshot',
  });
  const serverEligibilityId = fixture.repository.rewards[0].eligibilityId;
  fixture.repository.rewards.push({
    ...fixture.repository.rewards[0],
    cohortId: 'other-tenant-cohort',
    eligibilityId: 'other-tenant-reward',
  });
  const app = createApiComposition({ testOnlyClosedBetaService: fixture.service });
  const decision = {
    supersedesEligibilityId: serverEligibilityId,
    eligible: true,
    source: 'MANUAL_ADJUSTMENT',
    reason: 'verified missing event',
  };
  const crossTenantOwner = await app.inject({
    method: 'POST',
    url: `/closed-beta/cohorts/${cohortId}/reward-eligibility/decisions`,
    headers: { authorization: 'Bearer jwt-other-owner' },
    payload: decision,
  });
  assert.equal(crossTenantOwner.statusCode, 403);
  const crossTenantTarget = await app.inject({
    method: 'POST',
    url: `/closed-beta/cohorts/${cohortId}/reward-eligibility/decisions`,
    headers: { authorization: 'Bearer jwt-owner' },
    payload: { ...decision, supersedesEligibilityId: 'other-tenant-reward' },
  });
  assert.equal(crossTenantTarget.statusCode, 409);
  const accepted = await app.inject({
    method: 'POST',
    url: `/closed-beta/cohorts/${cohortId}/reward-eligibility/decisions`,
    headers: { authorization: 'Bearer jwt-owner' },
    payload: decision,
  });
  assert.equal(accepted.statusCode, 204);
  const adjustment = fixture.repository.rewards.at(-1)!;
  assert.equal(adjustment.supersedesEligibilityId, serverEligibilityId);
  assert.equal(adjustment.milestoneEventId, 'server-event-1');
  assert.deepEqual(adjustment.evidenceSnapshot, { completed: true, businessDay: 3 });
  assert.deepEqual(
    await fixture.service.findEffectiveRewardEligibility(cohortId, 'user-one', 'server-event-1'),
    {
      eligibilityId: adjustment.eligibilityId,
      rewardKind: 'COSMETIC',
      eligible: true,
      source: 'MANUAL_ADJUSTMENT',
      supersedesEligibilityId: serverEligibilityId,
    },
  );

  const duplicateTarget = await app.inject({
    method: 'POST',
    url: `/closed-beta/cohorts/${cohortId}/reward-eligibility/decisions`,
    headers: { authorization: 'Bearer jwt-owner' },
    payload: decision,
  });
  assert.equal(duplicateTarget.statusCode, 409);

  const invalidRevocation = await app.inject({
    method: 'POST',
    url: `/closed-beta/cohorts/${cohortId}/reward-eligibility/decisions`,
    headers: { authorization: 'Bearer jwt-owner' },
    payload: {
      supersedesEligibilityId: adjustment.eligibilityId,
      source: 'REVOCATION',
      eligible: true,
      reason: 'invalid positive revoke',
    },
  });
  assert.equal(invalidRevocation.statusCode, 422);
  const revoked = await app.inject({
    method: 'POST',
    url: `/closed-beta/cohorts/${cohortId}/reward-eligibility/decisions`,
    headers: { authorization: 'Bearer jwt-owner' },
    payload: {
      supersedesEligibilityId: adjustment.eligibilityId,
      source: 'REVOCATION',
      eligible: false,
      reason: 'security review revoke',
    },
  });
  assert.equal(revoked.statusCode, 204);
  const effective = await fixture.service.findEffectiveRewardEligibility(
    cohortId,
    'user-one',
    'server-event-1',
  );
  assert.equal(effective?.source, 'REVOCATION');
  assert.equal(effective?.eligible, false);
  assert.equal(JSON.stringify(fixture.repository.audit).includes('verified missing event'), true);
  assert.equal(JSON.stringify(fixture.repository.audit).includes(serverEligibilityId), true);
  await app.close();
});

test('concurrent reward decisions serialize a chain target so exactly one succeeds', async () => {
  const fixture = serviceFixture();
  const { cohortId } = await bootstrap(fixture);
  const invitation = await issue(fixture, cohortId, 'user-one');
  await fixture.service.redeemInvite('jwt-user-one', invitation.token);
  await fixture.service.recordServerMilestoneEligibility({
    cohortId,
    playerId: 'user-one',
    milestoneEventId: 'race-event',
    evidenceSnapshot: { verified: true },
    eligible: true,
    rewardKind: 'TITLE',
    reason: 'server event',
  });
  const target = fixture.repository.rewards[0].eligibilityId;
  const outcomes = await Promise.allSettled([
    fixture.service.recordOwnerRewardDecision(
      'jwt-owner',
      cohortId,
      {
        supersedesEligibilityId: target,
        eligible: false,
        source: 'MANUAL_ADJUSTMENT',
        reason: 'first review',
      },
      'server-correlation-a',
    ),
    fixture.service.recordOwnerRewardDecision(
      'jwt-owner',
      cohortId,
      {
        supersedesEligibilityId: target,
        eligible: false,
        source: 'REVOCATION',
        reason: 'second review',
      },
      'server-correlation-b',
    ),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  assert.equal(
    fixture.repository.rewards.filter((reward) => reward.supersedesEligibilityId === target).length,
    1,
  );
});

class D04Repository implements IdentityScopeRepository {
  async findPlayerByClerkSubject() {
    return { id: 'user-one', clerkUserId: 'user-one-subject' };
  }

  async findPlayerByDiscordId() {
    return undefined;
  }

  async findActiveGameScope(): Promise<ActiveGameScope> {
    return {
      playerId: 'user-one',
      membershipId: 'restaurant-membership',
      tenantId: 'tenant-one',
      saveId: 'save-one',
      role: 'OWNER',
      branchScope: { kind: 'all' },
    };
  }
}

function d04Security(): TrustedContextSecurityOptions {
  return {
    jwtVerifier,
    repository: new D04Repository(),
    authorization: new RoleMatrixAuthorizationPolicy({ SAVE_TEST_ADVANCE: ['OWNER'] }),
  };
}

function commandRequest() {
  return {
    method: 'POST' as const,
    url: '/saves/save-one/actions/SAVE_TEST_ADVANCE',
    headers: { authorization: 'Bearer jwt-user-one' },
    payload: {
      schemaVersion: COMMAND_ENVELOPE_VERSION,
      commandId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: 'd05-gate-1',
      commandType: 'SAVE_TEST_ADVANCE',
      aggregateId: 'save-one',
      expectedVersion: 1,
      payload: {},
    },
  };
}

test('command entry orders D04 then D05, reaches D03 503 only when eligible, and cannot run without D05', async () => {
  const fixture = serviceFixture();
  const { cohortId, policyId } = await bootstrap(fixture);
  const invitation = await issue(fixture, cohortId, 'user-one');
  await fixture.service.redeemInvite('jwt-user-one', invitation.token);
  await fixture.service.decideConsent('jwt-user-one', policyId, 'ACCEPTED');

  const dispatcher = new CommandDispatcher(
    [
      {
        commandType: 'SAVE_TEST_ADVANCE',
        async execute() {
          return { aggregateVersion: 2, result: { unreachable: true } };
        },
      },
    ],
    new PersistenceRequiredCommandExecutionStore(),
  );
  const configured = createApiComposition({
    commandDispatcher: dispatcher,
    identitySecurity: d04Security(),
    testOnlyClosedBetaService: fixture.service,
  });
  const passed = await configured.inject(commandRequest());
  assert.equal(passed.statusCode, 503);
  assert.equal(errorCode(passed), 'COMMAND_PERSISTENCE_REQUIRED');
  await fixture.service.decideConsent('jwt-user-one', policyId, 'WITHDRAWN');
  const withdrawn = await configured.inject(commandRequest());
  assert.equal(withdrawn.statusCode, 403);
  assert.equal(errorCode(withdrawn), 'CLOSED_BETA_NOT_ELIGIBLE');
  await configured.close();

  const missingD05 = createApiComposition({
    commandDispatcher: dispatcher,
    identitySecurity: d04Security(),
  });
  const unavailable = await missingD05.inject(commandRequest());
  assert.equal(unavailable.statusCode, 503);
  assert.equal(errorCode(unavailable), 'CLOSED_BETA_NOT_CONFIGURED');
  await missingD05.close();
});

function errorCode(response: Readonly<{ json(): unknown }>): string | undefined {
  return (response.json() as { error?: { code?: string } }).error?.code;
}

function forbidden(): never {
  throw new ClosedBetaError(403, 'CLOSED_BETA_FORBIDDEN');
}

function conflict(): never {
  throw new ClosedBetaError(409, 'CLOSED_BETA_STATE_CONFLICT');
}
