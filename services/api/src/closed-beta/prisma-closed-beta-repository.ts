import {
  ClosedBetaError,
  type ClosedBetaRepository,
  type CohortDraft,
  type ConsentPolicyDraft,
  type EffectiveRewardEligibility,
  type InviteDraft,
  type OwnerRewardDecision,
  type RewardEvidence,
} from './closed-beta.js';
import type { PlayerRecord } from '../auth/trusted-command-context.js';

type Queryable = Readonly<{
  $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T>;
}>;

export type D05Database = Queryable &
  Readonly<{
    $transaction<T>(operation: (transaction: Queryable) => Promise<T>): Promise<T>;
  }>;

type IdRow = Readonly<{ id: string }>;
type CohortRow = Readonly<{
  id: string;
  restaurantId: string;
  status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'REVOKED';
  opensAt: Date;
  closesAt: Date;
  eligibilityPolicyVersion: string;
  eligibilityPolicyDigest: string;
}>;
type InviteRow = Readonly<{
  id: string;
  cohortId: string;
  status: 'DRAFT' | 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';
  expiresAt: Date;
}>;

export class PrismaClosedBetaRepository implements ClosedBetaRepository {
  readonly durability = 'durable' as const;

  constructor(private readonly database: D05Database) {}

  async findPlayerByClerkSubject(subject: string): Promise<PlayerRecord | undefined> {
    const rows = await this.database.$queryRawUnsafe<readonly PlayerRecord[]>(
      'SELECT "id", "clerkUserId" FROM "Player" WHERE "clerkUserId" = $1 LIMIT 1',
      subject,
    );
    return rows[0];
  }

  createCohort(input: CohortDraft): Promise<void> {
    return this.database.$transaction(async (transaction) => {
      await assertOwner(transaction, input.createdByPlayerId, input.restaurantId);
      await transaction.$queryRawUnsafe(
        `INSERT INTO "TestCohort" (
          "id", "restaurantId", "name", "purpose", "environment", "status", "quota",
          "opensAt", "closesAt", "featureFlags", "eligibilityPolicyVersion",
          "eligibilityPolicyDigest", "createdByPlayerId", "createdAt", "updatedAt"
        ) VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$13)`,
        input.id,
        input.restaurantId,
        input.name,
        input.purpose,
        input.environment,
        input.quota,
        input.opensAt,
        input.closesAt,
        JSON.stringify(input.featureFlags),
        input.eligibilityPolicyVersion,
        input.eligibilityPolicyDigest,
        input.createdByPlayerId,
        input.createdAt,
      );
      await writeAudit(transaction, {
        id: input.auditId,
        restaurantId: input.restaurantId,
        actorPlayerId: input.createdByPlayerId,
        action: 'closed_beta_cohort_created',
        targetType: 'TestCohort',
        targetId: input.id,
        metadata: { environment: input.environment, quota: input.quota },
        createdAt: input.createdAt,
        correlationId: input.correlationId,
      });
    });
  }

  createConsentPolicy(input: ConsentPolicyDraft): Promise<void> {
    return this.database.$transaction(async (transaction) => {
      const cohort = await lockedCohort(transaction, input.cohortId);
      await assertOwner(transaction, input.createdByPlayerId, cohort.restaurantId);
      if (cohort.status !== 'DRAFT') conflict();
      await transaction.$queryRawUnsafe(
        `INSERT INTO "ConsentPolicy" (
          "id", "cohortId", "purpose", "version", "policyDigest", "scope",
          "dataCategories", "retentionDays", "requiredForEntry", "createdByPlayerId", "createdAt"
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)`,
        input.id,
        input.cohortId,
        input.purpose,
        input.version,
        input.policyDigest,
        JSON.stringify(input.scope),
        JSON.stringify(input.dataCategories),
        input.retentionDays,
        input.requiredForEntry,
        input.createdByPlayerId,
        input.createdAt,
      );
      await writeAudit(transaction, {
        id: input.auditId,
        restaurantId: cohort.restaurantId,
        actorPlayerId: input.createdByPlayerId,
        action: 'closed_beta_consent_policy_created',
        targetType: 'ConsentPolicy',
        targetId: input.id,
        metadata: {
          cohortId: input.cohortId,
          purpose: input.purpose,
          policyVersion: input.version,
          policyDigest: input.policyDigest,
          requiredForEntry: input.requiredForEntry,
        },
        createdAt: input.createdAt,
        correlationId: input.correlationId,
      });
    });
  }

  openCohort(
    input: Readonly<{
      cohortId: string;
      entryConsentPolicyId: string;
      actorPlayerId: string;
      openedAt: Date;
      auditId: string;
      correlationId: string;
    }>,
  ): Promise<void> {
    return this.database.$transaction(async (transaction) => {
      const cohort = await lockedCohort(transaction, input.cohortId);
      await assertOwner(transaction, input.actorPlayerId, cohort.restaurantId);
      if (cohort.status !== 'DRAFT' || cohort.closesAt <= input.openedAt) conflict();
      const policies = await transaction.$queryRawUnsafe<readonly IdRow[]>(
        `SELECT "id" FROM "ConsentPolicy"
         WHERE "id" = $1 AND "cohortId" = $2 AND "requiredForEntry" = TRUE AND "retiredAt" IS NULL
         FOR SHARE`,
        input.entryConsentPolicyId,
        input.cohortId,
      );
      if (!policies[0]) conflict();
      await transaction.$queryRawUnsafe(
        `UPDATE "TestCohort"
         SET "status" = 'OPEN', "entryConsentPolicyId" = $2, "openedAt" = $3, "updatedAt" = $3
         WHERE "id" = $1`,
        input.cohortId,
        input.entryConsentPolicyId,
        input.openedAt,
      );
      await writeAudit(transaction, {
        id: input.auditId,
        restaurantId: cohort.restaurantId,
        actorPlayerId: input.actorPlayerId,
        action: 'closed_beta_cohort_opened',
        targetType: 'TestCohort',
        targetId: input.cohortId,
        metadata: { entryConsentPolicyId: input.entryConsentPolicyId },
        createdAt: input.openedAt,
        correlationId: input.correlationId,
      });
    });
  }

  closeCohort(
    input: Readonly<{
      cohortId: string;
      action: 'close' | 'revoke';
      actorPlayerId: string;
      occurredAt: Date;
      auditId: string;
      correlationId: string;
    }>,
  ): Promise<void> {
    return this.database.$transaction(async (transaction) => {
      const cohort = await lockedCohort(transaction, input.cohortId);
      await assertOwner(transaction, input.actorPlayerId, cohort.restaurantId);
      if ((input.action === 'close' && cohort.status !== 'OPEN') || cohort.status === 'REVOKED') {
        conflict();
      }
      const status = input.action === 'close' ? 'CLOSED' : 'REVOKED';
      await transaction.$queryRawUnsafe(
        `UPDATE "TestCohort"
         SET "status" = $2::"TestCohortStatus",
             "closedAt" = CASE WHEN $2 = 'CLOSED' THEN $3 ELSE "closedAt" END,
             "revokedAt" = CASE WHEN $2 = 'REVOKED' THEN $3 ELSE NULL END,
             "updatedAt" = $3
         WHERE "id" = $1`,
        input.cohortId,
        status,
        input.occurredAt,
      );
      await writeAudit(transaction, {
        id: input.auditId,
        restaurantId: cohort.restaurantId,
        actorPlayerId: input.actorPlayerId,
        action:
          input.action === 'close' ? 'closed_beta_cohort_closed' : 'closed_beta_cohort_revoked',
        targetType: 'TestCohort',
        targetId: input.cohortId,
        metadata: { status },
        createdAt: input.occurredAt,
        correlationId: input.correlationId,
      });
    });
  }

  createInvite(input: InviteDraft): Promise<void> {
    return this.database.$transaction(async (transaction) => {
      const cohort = await lockedCohort(transaction, input.cohortId);
      await assertOwner(transaction, input.issuedByPlayerId, cohort.restaurantId);
      if (!['DRAFT', 'OPEN'].includes(cohort.status) || input.expiresAt > cohort.closesAt)
        conflict();
      const target = await transaction.$queryRawUnsafe<readonly IdRow[]>(
        'SELECT "id" FROM "Player" WHERE "id" = $1 FOR SHARE',
        input.invitedPlayerId,
      );
      if (!target[0]) forbidden();
      await transaction.$queryRawUnsafe(
        `INSERT INTO "TestCohortInvite" (
          "id", "cohortId", "invitedPlayerId", "issuedByPlayerId", "tokenDigest",
          "status", "expiresAt", "createdAt"
        ) VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7)`,
        input.id,
        input.cohortId,
        input.invitedPlayerId,
        input.issuedByPlayerId,
        input.tokenDigest,
        input.expiresAt,
        input.createdAt,
      );
      await writeAudit(transaction, {
        id: input.auditId,
        restaurantId: cohort.restaurantId,
        actorPlayerId: input.issuedByPlayerId,
        action: 'closed_beta_invite_created',
        targetType: 'TestCohortInvite',
        targetId: input.id,
        metadata: {
          cohortId: input.cohortId,
          invitedPlayerId: input.invitedPlayerId,
          expiresAt: input.expiresAt.toISOString(),
        },
        createdAt: input.createdAt,
        correlationId: input.correlationId,
      });
    });
  }

  async activateInvite(
    input: Readonly<{
      cohortId: string;
      inviteId: string;
      actorPlayerId: string;
      activatedAt: Date;
      auditId: string;
      correlationId: string;
    }>,
  ): Promise<void> {
    try {
      await this.database.$transaction(async (transaction) => {
        const invitation = await lockedInvite(transaction, input.inviteId, input.cohortId);
        const cohort = await lockedCohort(transaction, invitation.cohortId);
        await assertOwner(transaction, input.actorPlayerId, cohort.restaurantId);
        if (
          invitation.status !== 'DRAFT' ||
          invitation.expiresAt <= input.activatedAt ||
          cohort.status !== 'OPEN' ||
          cohort.opensAt > input.activatedAt ||
          cohort.closesAt <= input.activatedAt
        )
          conflict();
        await transaction.$queryRawUnsafe(
          `UPDATE "TestCohortInvite"
           SET "status" = 'ACTIVE', "activatedAt" = $2
           WHERE "id" = $1`,
          invitation.id,
          input.activatedAt,
        );
        await writeAudit(transaction, {
          id: input.auditId,
          restaurantId: cohort.restaurantId,
          actorPlayerId: input.actorPlayerId,
          action: 'closed_beta_invite_activated',
          targetType: 'TestCohortInvite',
          targetId: invitation.id,
          metadata: { cohortId: invitation.cohortId },
          createdAt: input.activatedAt,
          correlationId: input.correlationId,
        });
      });
    } catch (error) {
      if (isRetryableDatabaseRace(error)) conflict();
      throw error;
    }
  }

  async revokeInvite(
    input: Readonly<{
      cohortId: string;
      inviteId: string;
      actorPlayerId: string;
      revokedAt: Date;
      auditId: string;
      correlationId: string;
    }>,
  ): Promise<void> {
    try {
      const rows = await this.database.$queryRawUnsafe<readonly Readonly<{ result: string }>[]>(
        'SELECT * FROM d05_revoke_invite($1,$2,$3,$4,$5,$6)',
        input.inviteId,
        input.cohortId,
        input.actorPlayerId,
        input.revokedAt,
        input.auditId,
        input.correlationId,
      );
      if (rows[0]?.result === 'revoked') return;
      forbidden();
    } catch (error) {
      if (isRetryableDatabaseRace(error)) conflict();
      throw error;
    }
  }

  async redeemInvite(
    input: Readonly<{
      tokenDigest: string;
      actorPlayerId: string;
      redeemedAt: Date;
      membershipId: string;
      auditId: string;
      correlationId: string;
    }>,
  ): Promise<'redeemed' | 'invalid'> {
    try {
      const rows = await this.database.$queryRawUnsafe<readonly Readonly<{ result: string }>[]>(
        'SELECT * FROM d05_redeem_invite($1,$2,$3,$4,$5,$6)',
        input.tokenDigest,
        input.actorPlayerId,
        input.redeemedAt,
        input.membershipId,
        input.auditId,
        input.correlationId,
      );
      return rows[0]?.result === 'redeemed' ? 'redeemed' : 'invalid';
    } catch (error) {
      if (isRetryableDatabaseRace(error)) return 'invalid';
      throw error;
    }
  }

  async recordConsentDecision(
    input: Readonly<{
      policyId: string;
      actorPlayerId: string;
      decision: 'ACCEPTED' | 'WITHDRAWN';
      decidedAt: Date;
      decisionId: string;
      auditId: string;
      correlationId: string;
    }>,
  ): Promise<'accepted' | 'withdrawn' | 'invalid'> {
    const rows = await this.database.$queryRawUnsafe<readonly Readonly<{ result: string }>[]>(
      'SELECT * FROM d05_record_consent_decision($1,$2,$3::"ConsentDecisionKind",$4,$5,$6,$7)',
      input.policyId,
      input.actorPlayerId,
      input.decision,
      input.decidedAt,
      input.decisionId,
      input.auditId,
      input.correlationId,
    );
    const result = rows[0]?.result;
    return result === 'accepted' || result === 'withdrawn' ? result : 'invalid';
  }

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
  ): Promise<void> {
    return this.database.$transaction(async (transaction) => {
      const cohort = await lockedCohort(transaction, input.cohortId);
      await assertOwner(transaction, input.actorPlayerId, cohort.restaurantId);
      const rows = await transaction.$queryRawUnsafe<readonly IdRow[]>(
        `UPDATE "TestCohortMembership"
         SET "status" = 'REVOKED', "revokedAt" = $4, "revokedByPlayerId" = $3, "revokeReason" = $5
         WHERE "cohortId" = $1 AND "playerId" = $2 AND "status" = 'ACTIVE'
         RETURNING "id"`,
        input.cohortId,
        input.playerId,
        input.actorPlayerId,
        input.revokedAt,
        input.reason,
      );
      if (!rows[0]) conflict();
      await writeAudit(transaction, {
        id: input.auditId,
        restaurantId: cohort.restaurantId,
        actorPlayerId: input.actorPlayerId,
        action: 'closed_beta_membership_revoked',
        targetType: 'TestCohortMembership',
        targetId: rows[0].id,
        metadata: { cohortId: input.cohortId, playerId: input.playerId, reason: input.reason },
        createdAt: input.revokedAt,
        correlationId: input.correlationId,
      });
    });
  }

  async isEntranceEligible(playerId: string, tenantId: string, checkedAt: Date): Promise<boolean> {
    const rows = await this.database.$queryRawUnsafe<readonly Readonly<{ eligible: boolean }>[]>(
      'SELECT d05_is_entrance_eligible($1,$2,$3) AS eligible',
      playerId,
      tenantId,
      checkedAt,
    );
    return rows[0]?.eligible === true;
  }

  recordServerRewardEligibility(input: RewardEvidence): Promise<void> {
    return this.database.$transaction(async (transaction) => {
      const cohort = await lockedCohort(transaction, input.cohortId);
      const members = await transaction.$queryRawUnsafe<readonly IdRow[]>(
        `SELECT "id" FROM "TestCohortMembership"
         WHERE "cohortId" = $1 AND "playerId" = $2 FOR SHARE`,
        input.cohortId,
        input.playerId,
      );
      if (!members[0]) forbidden();
      await transaction.$queryRawUnsafe(
        `INSERT INTO "RewardEligibility" (
          "id", "cohortId", "playerId", "policyVersion", "policyDigest", "milestoneEventId",
          "evidenceSnapshot", "evidenceHash", "eligible", "rewardKind", "source", "reason", "decidedAt"
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,'SERVER_EVENT',$11,$12)`,
        input.eligibilityId,
        input.cohortId,
        input.playerId,
        cohort.eligibilityPolicyVersion,
        cohort.eligibilityPolicyDigest,
        input.milestoneEventId,
        JSON.stringify(input.evidenceSnapshot),
        input.evidenceHash,
        input.eligible,
        input.rewardKind,
        input.reason,
        input.decidedAt,
      );
      await writeAudit(transaction, {
        id: input.auditId,
        restaurantId: cohort.restaurantId,
        actorPlayerId: null,
        action: 'closed_beta_reward_eligibility_recorded',
        targetType: 'RewardEligibility',
        targetId: input.eligibilityId,
        metadata: {
          cohortId: input.cohortId,
          playerId: input.playerId,
          milestoneEventId: input.milestoneEventId,
          evidenceHash: input.evidenceHash,
          eligible: input.eligible,
          rewardKind: input.rewardKind,
          policyVersion: cohort.eligibilityPolicyVersion,
          policyDigest: cohort.eligibilityPolicyDigest,
        },
        createdAt: input.decidedAt,
        correlationId: input.correlationId,
      });
    });
  }

  async recordOwnerRewardDecision(input: OwnerRewardDecision): Promise<void> {
    const rows = await this.database.$queryRawUnsafe<readonly Readonly<{ result: string }>[]>(
      `SELECT * FROM d05_record_reward_decision(
        $1,$2,$3,$4::"RewardEligibilitySource",$5,$6,$7,$8,$9,$10
      )`,
      input.cohortId,
      input.supersedesEligibilityId,
      input.actorPlayerId,
      input.source,
      input.eligible,
      input.reason,
      input.decidedAt,
      input.eligibilityId,
      input.auditId,
      input.correlationId,
    );
    if (rows[0]?.result === 'forbidden') forbidden();
    if (rows[0]?.result !== 'recorded') conflict();
  }

  async findEffectiveRewardEligibility(
    cohortId: string,
    playerId: string,
    milestoneEventId: string,
  ): Promise<EffectiveRewardEligibility | undefined> {
    const rows = await this.database.$queryRawUnsafe<readonly EffectiveRewardEligibility[]>(
      'SELECT * FROM d05_effective_reward_eligibility($1,$2,$3)',
      cohortId,
      playerId,
      milestoneEventId,
    );
    return rows[0];
  }
}

async function assertOwner(
  database: Queryable,
  playerId: string,
  restaurantId: string,
): Promise<void> {
  const rows = await database.$queryRawUnsafe<readonly IdRow[]>(
    `SELECT "id" FROM "RestaurantMembership"
     WHERE "playerId" = $1 AND "restaurantId" = $2 AND "role" = 'OWNER' AND "revokedAt" IS NULL
     FOR SHARE`,
    playerId,
    restaurantId,
  );
  if (!rows[0]) forbidden();
}

async function lockedCohort(database: Queryable, cohortId: string): Promise<CohortRow> {
  const rows = await database.$queryRawUnsafe<readonly CohortRow[]>(
    `SELECT "id", "restaurantId", "status", "opensAt", "closesAt",
            "eligibilityPolicyVersion", "eligibilityPolicyDigest"
     FROM "TestCohort" WHERE "id" = $1 FOR UPDATE`,
    cohortId,
  );
  if (!rows[0]) forbidden();
  return rows[0];
}

async function lockedInvite(
  database: Queryable,
  inviteId: string,
  cohortId: string,
): Promise<InviteRow> {
  const rows = await database.$queryRawUnsafe<readonly InviteRow[]>(
    `SELECT "id", "cohortId", "status", "expiresAt"
     FROM "TestCohortInvite"
     WHERE "id" = $1 AND "cohortId" = $2
     FOR UPDATE`,
    inviteId,
    cohortId,
  );
  if (!rows[0]) forbidden();
  return rows[0];
}

async function writeAudit(
  database: Queryable,
  input: Readonly<{
    id: string;
    restaurantId: string;
    actorPlayerId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    metadata: Readonly<Record<string, unknown>>;
    createdAt: Date;
    correlationId: string;
  }>,
): Promise<void> {
  await database.$queryRawUnsafe(
    `INSERT INTO "AuditLog" (
      "id", "restaurantId", "actorPlayerId", "actorType", "action", "targetType",
      "targetId", "metadata", "correlationId", "createdAt"
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    input.id,
    input.restaurantId,
    input.actorPlayerId,
    input.actorPlayerId ? 'clerk_user' : 'service',
    input.action,
    input.targetType,
    input.targetId,
    JSON.stringify(input.metadata),
    input.correlationId,
    input.createdAt,
  );
}

function forbidden(): never {
  throw new ClosedBetaError(403, 'CLOSED_BETA_FORBIDDEN');
}

function conflict(): never {
  throw new ClosedBetaError(409, 'CLOSED_BETA_STATE_CONFLICT');
}

function isRetryableDatabaseRace(error: unknown): boolean {
  const retryableCodes = new Set(['P2034', '40P01', '40001']);
  const visited = new Set<object>();

  function containsRetryableCode(value: unknown, depth: number): boolean {
    if (!value || typeof value !== 'object' || depth > 4 || visited.has(value)) return false;
    visited.add(value);
    const record = value as Readonly<Record<string, unknown>>;
    for (const key of ['code', 'sqlState', 'sqlstate', 'originalCode', 'database_error_code']) {
      if (typeof record[key] === 'string' && retryableCodes.has(record[key])) return true;
    }
    return ['meta', 'cause', 'driverAdapterError'].some((key) =>
      containsRetryableCode(record[key], depth + 1),
    );
  }

  return containsRetryableCode(error, 0);
}
