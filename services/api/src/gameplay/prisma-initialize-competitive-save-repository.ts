import {
  executeInitializeCompetitiveSaveTransaction,
  InitializeCompetitiveSaveError,
  type BootstrapEpochRecord,
  type InitializeCompetitiveSaveRepository,
  type InitializeCompetitiveSaveResult,
  type InitializeCompetitiveSaveTransactionInput,
  type InitializeCompetitiveSaveUnitOfWork,
  type InventoryPool,
  type QualifyingBootstrapAuthority,
  type ServerDerivedBootstrapPlan,
  type TrustedBootstrapContext,
} from './initialize-competitive-save.js';

export interface BootstrapSqlTransaction {
  $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: readonly unknown[]): Promise<number>;
}

export interface BootstrapSerializableDatabase {
  $transaction<T>(
    operation: (transaction: BootstrapSqlTransaction) => Promise<T>,
    options: Readonly<{ isolationLevel: 'Serializable' }>,
  ): Promise<T>;
}

type EpochRow = BootstrapEpochRecord;

/**
 * PostgreSQL adapter only. It does not register a route or claim runtime trigger
 * verification; the migration remains the final database invariant boundary.
 */
export class PrismaInitializeCompetitiveSaveRepository
  implements InitializeCompetitiveSaveRepository
{
  constructor(private readonly database: BootstrapSerializableDatabase) {}

  async provision(
    input: InitializeCompetitiveSaveTransactionInput,
  ): Promise<InitializeCompetitiveSaveResult> {
    try {
      return await this.database.$transaction(
        async (transaction) =>
          provisionCompetitiveSaveInTransaction(transaction, input),
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (error instanceof InitializeCompetitiveSaveError) throw error;
      if (isRetryableConflict(error)) {
        throw new InitializeCompetitiveSaveError(409, 'INITIALIZE_COMPETITIVE_SAVE_CONFLICT');
      }
      throw new InitializeCompetitiveSaveError(503, 'INITIALIZE_COMPETITIVE_SAVE_UNAVAILABLE');
    }
  }
}

export function provisionCompetitiveSaveInTransaction(
  transaction: BootstrapSqlTransaction,
  input: InitializeCompetitiveSaveTransactionInput,
): Promise<InitializeCompetitiveSaveResult> {
  return executeInitializeCompetitiveSaveTransaction(
    new PrismaInitializeCompetitiveSaveUnitOfWork(transaction),
    input,
  );
}

class PrismaInitializeCompetitiveSaveUnitOfWork
  implements InitializeCompetitiveSaveUnitOfWork
{
  constructor(private readonly transaction: BootstrapSqlTransaction) {}

  async findCommandReplay(
    context: TrustedBootstrapContext,
  ): Promise<BootstrapEpochRecord | undefined> {
    const rows = await this.transaction.$queryRawUnsafe<readonly EpochRow[]>(
      `SELECT epoch."id", epoch."authorityId", epoch."playerId", epoch."epochNumber",
              epoch."playerCommandVersion",
              epoch."predecessorEpochId", epoch."status", epoch."provisionedRestaurantId",
              epoch."ownerMembershipId", epoch."saveId", epoch."ownerAuditLogId",
              epoch."commandId", epoch."requestFingerprint"
       FROM "BootstrapProvisioningEpoch" epoch
       WHERE epoch."commandId" = $1
         AND epoch."authorityId" = $2
         AND epoch."playerId" = $3
       FOR SHARE`,
      context.commandId,
      context.authorityId,
      context.actorPlayerId,
    );
    return rows[0];
  }

  async lockQualifyingAuthority(
    actorPlayerId: string,
    authorityId: string,
  ): Promise<QualifyingBootstrapAuthority | undefined> {
    const rows = await this.transaction.$queryRawUnsafe<readonly QualifyingBootstrapAuthority[]>(
      `SELECT authority."id", authority."playerId", authority."sourceEligibilityRestaurantId"
       FROM "BootstrapAuthority" authority
       JOIN "Player" player ON player."id" = authority."playerId"
       JOIN "TestCohortMembership" membership
         ON membership."id" = authority."cohortMembershipId"
        AND membership."cohortId" = authority."cohortId"
        AND membership."playerId" = authority."playerId"
       JOIN "TestCohortInvite" invitation
         ON invitation."id" = authority."inviteId"
        AND invitation."cohortId" = authority."cohortId"
        AND invitation."id" = membership."inviteId"
       JOIN "TestCohort" cohort
         ON cohort."id" = authority."cohortId"
        AND cohort."restaurantId" = authority."sourceEligibilityRestaurantId"
       JOIN "ConsentPolicy" policy
         ON policy."cohortId" = cohort."id"
        AND policy."id" = cohort."entryConsentPolicyId"
       JOIN "ConsentDecision" decision
         ON decision."id" = authority."consentDecisionId"
        AND decision."cohortId" = cohort."id"
        AND decision."playerId" = authority."playerId"
        AND decision."policyId" = policy."id"
       WHERE authority."id" = $1
         AND authority."playerId" = $2
         AND membership."status" = 'ACTIVE'
         AND membership."revokedAt" IS NULL
         AND invitation."status" = 'CONSUMED'
         AND invitation."invitedPlayerId" = $2
         AND invitation."consumedByPlayerId" = $2
         AND cohort."status" = 'OPEN'
         AND cohort."opensAt" <= CURRENT_TIMESTAMP
         AND cohort."closesAt" > CURRENT_TIMESTAMP
         AND policy."requiredForEntry" = TRUE
         AND policy."retiredAt" IS NULL
         AND decision."decision" = 'ACCEPTED'
         AND decision."acceptedAt" IS NOT NULL
         AND decision."retentionUntil" > CURRENT_TIMESTAMP
         AND decision."policyVersion" = authority."policyVersion"
         AND decision."policyDigest" = authority."policyDigest"
         AND NOT EXISTS (
           SELECT 1 FROM "ConsentDecision" later
           WHERE later."cohortId" = decision."cohortId"
             AND later."playerId" = decision."playerId"
             AND later."policyId" = decision."policyId"
             AND later."decisionSequence" > decision."decisionSequence"
         )
       FOR UPDATE OF authority, player, membership, invitation, cohort`,
      authorityId,
      actorPlayerId,
    );
    return rows[0];
  }

  async lockLatestEpoch(authorityId: string): Promise<BootstrapEpochRecord | undefined> {
    const rows = await this.transaction.$queryRawUnsafe<readonly EpochRow[]>(
      `SELECT epoch."id", epoch."authorityId", epoch."playerId", epoch."epochNumber",
              epoch."playerCommandVersion",
              epoch."predecessorEpochId", epoch."status", epoch."provisionedRestaurantId",
              epoch."ownerMembershipId", epoch."saveId", epoch."ownerAuditLogId",
              epoch."commandId", epoch."requestFingerprint"
       FROM "BootstrapProvisioningEpoch" epoch
       WHERE epoch."authorityId" = $1
       ORDER BY epoch."epochNumber" DESC
       LIMIT 1
       FOR UPDATE`,
      authorityId,
    );
    return rows[0];
  }

  async createRestaurant(input: Readonly<{ id: string; name: string; timezone: string }>) {
    await this.transaction.$executeRawUnsafe(
      `INSERT INTO "Restaurant" ("id", "name", "timezone", "createdAt")
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      input.id,
      input.name,
      input.timezone,
    );
  }

  async createOwnerMembership(
    input: Readonly<{ id: string; playerId: string; restaurantId: string }>,
  ) {
    await this.transaction.$executeRawUnsafe(
      `INSERT INTO "RestaurantMembership" (
         "id", "playerId", "restaurantId", "role", "branchScope", "createdAt", "revokedAt"
       ) VALUES ($1, $2, $3, 'OWNER', NULL, CURRENT_TIMESTAMP, NULL)`,
      input.id,
      input.playerId,
      input.restaurantId,
    );
  }

  async createCompetitiveSave(
    input: Readonly<{
      id: string;
      playerId: string;
      restaurantId: string;
      plan: ServerDerivedBootstrapPlan;
    }>,
  ) {
    await this.transaction.$executeRawUnsafe(
      `INSERT INTO "CompetitiveSave" (
         "id", "restaurantId", "ownerPlayerId", "mode", "version", "openingScenario",
         "operatingMode", "servicePeriodPlan", "difficultyGroup", "demandSeed",
         "simulationRuleVersion", "openingSnapshot", "openingSnapshotHash",
         "createdAt", "updatedAt"
       ) VALUES (
         $1, $2, $3, 'COMPETITIVE', 1, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )`,
      input.id,
      input.restaurantId,
      input.playerId,
      input.plan.openingScenario,
      input.plan.operatingMode,
      input.plan.servicePeriodPlan,
      input.plan.difficultyGroup,
      input.plan.demandSeed,
      input.plan.simulationRuleVersion,
      JSON.stringify(input.plan.openingSnapshot),
      input.plan.openingSnapshotHash,
    );
  }

  async createMarketSeedAuthority(
    input: Readonly<{
      restaurantId: string;
      saveId: string;
      seed: string;
      seedVersion: string;
      createdByCommandId: string;
    }>,
  ) {
    await this.transaction.$executeRawUnsafe(
      `INSERT INTO "MarketSeedAuthority" (
         "restaurantId", "saveId", "seed", "seedVersion", "createdByCommandId", "createdAt"
       ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      input.restaurantId,
      input.saveId,
      input.seed,
      input.seedVersion,
      input.createdByCommandId,
    );
  }

  async createInventoryPoolState(
    input: Readonly<{
      restaurantId: string;
      saveId: string;
      pool: InventoryPool;
      revision: number;
      capacityPoints: number;
      storageBundleVersion: string;
      storageBundleKind: string;
      updatedByCommandId: string;
    }>,
  ) {
    await this.transaction.$executeRawUnsafe(
      `INSERT INTO "InventoryPoolState" (
         "restaurantId", "saveId", "pool", "revision", "capacityPoints",
         "storageBundleVersion", "storageBundleKind", "updatedByCommandId",
         "createdAt", "updatedAt"
       ) VALUES ($1, $2, $3::"InventoryPool", $4, $5, $6, $7, $8,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      input.restaurantId,
      input.saveId,
      input.pool,
      input.revision,
      input.capacityPoints,
      input.storageBundleVersion,
      input.storageBundleKind,
      input.updatedByCommandId,
    );
  }

  async createOwnerAudit(
    input: Readonly<{
      id: string;
      playerId: string;
      restaurantId: string;
      membershipId: string;
      commandId: string;
    }>,
  ) {
    await this.transaction.$executeRawUnsafe(
      `INSERT INTO "AuditLog" (
         "id", "restaurantId", "actorPlayerId", "actorType", "action", "targetType",
         "targetId", "metadata", "correlationId", "createdAt"
       ) VALUES (
         $1, $2, $3, 'clerk_user', 'bootstrap_owner_membership_provisioned',
         'RestaurantMembership', $4, $5::jsonb, $6, CURRENT_TIMESTAMP
       )`,
      input.id,
      input.restaurantId,
      input.playerId,
      input.membershipId,
      JSON.stringify({ commandId: input.commandId }),
      input.commandId,
    );
  }

  async createEpoch(input: BootstrapEpochRecord) {
    await this.transaction.$executeRawUnsafe(
      `INSERT INTO "BootstrapProvisioningEpoch" (
         "id", "authorityId", "playerId", "epochNumber", "playerCommandVersion",
         "predecessorEpochId", "status",
         "provisionedRestaurantId", "ownerMembershipId", "saveId", "ownerAuditLogId",
         "commandId", "requestFingerprint", "createdAt"
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)`,
      input.id,
      input.authorityId,
      input.playerId,
      input.epochNumber,
      input.playerCommandVersion,
      input.predecessorEpochId,
      input.provisionedRestaurantId,
      input.ownerMembershipId,
      input.saveId,
      input.ownerAuditLogId,
      input.commandId,
      input.requestFingerprint,
    );
  }
}

function isRetryableConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as Readonly<{ code?: unknown }>).code;
  return code === '23505' || code === '40001' || code === '40P01' || code === 'P2002' || code === 'P2034';
}
