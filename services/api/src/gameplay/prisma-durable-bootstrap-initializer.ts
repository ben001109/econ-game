import { randomUUID } from 'node:crypto';

import { CommandError } from '../commands/command-contract.js';
import {
  InitializeCompetitiveSaveError,
  isBootstrapCommandId,
  type JsonValue,
  type QualifyingBootstrapAuthority,
  type ServerBootstrapPlanFactory,
  type TrustedBootstrapContext,
} from './initialize-competitive-save.js';
import {
  type BootstrapSerializableDatabase,
  type BootstrapSqlTransaction,
  provisionCompetitiveSaveInTransaction,
} from './prisma-initialize-competitive-save-repository.js';
import {
  bootstrapPlayerScope,
  type DurableBootstrapInitializer,
} from './initialize-competitive-save-routes.js';

type InitializeInput = Parameters<DurableBootstrapInitializer['initialize']>[0];
type InitializeExecution = Awaited<ReturnType<DurableBootstrapInitializer['initialize']>>;

type VersionRow = Readonly<{ version: number }>;
type IdRow = Readonly<{ id: string }>;
type IdempotencyRow = Readonly<{
  requestFingerprint: string;
  responseSnapshot: unknown;
  status: string;
}>;
type AuthorityRow = QualifyingBootstrapAuthority &
  Readonly<{
    cohortId: string;
    cohortMembershipId: string;
    inviteId: string;
    consentDecisionId: string;
    policyVersion: string;
    policyDigest: string;
  }>;

/**
 * Durable P0-PLAT coordinator. All ownership, authority derivation, isolated
 * provisioning, version advancement, and receipt persistence share one
 * Serializable PostgreSQL transaction.
 */
export class PrismaDurableBootstrapInitializer implements DurableBootstrapInitializer {
  readonly durability = 'durable' as const;

  constructor(
    private readonly database: BootstrapSerializableDatabase,
    private readonly createServerPlan: ServerBootstrapPlanFactory,
    private readonly assertIntentPreflight?: (intent: InitializeInput['intent']) => void,
  ) {}

  async initialize(input: InitializeInput): Promise<InitializeExecution> {
    validateInput(input);
    try {
      this.assertIntentPreflight?.(input.intent);
    } catch (error) {
      if (error instanceof InitializeCompetitiveSaveError) {
        throw new CommandError(error.status, error.code);
      }
      throw error;
    }
    try {
      return await this.database.$transaction(
        (transaction) => this.initializeInTransaction(transaction, input),
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (error instanceof CommandError) throw error;
      if (error instanceof InitializeCompetitiveSaveError) {
        throw new CommandError(error.status, error.code);
      }
      if (isRetryableConflict(error)) {
        throw new CommandError(409, 'INITIALIZE_COMPETITIVE_SAVE_CONFLICT');
      }
      throw new CommandError(503, 'INITIALIZE_COMPETITIVE_SAVE_UNAVAILABLE');
    }
  }

  private async initializeInTransaction(
    transaction: BootstrapSqlTransaction,
    input: InitializeInput,
  ): Promise<InitializeExecution> {
    const currentVersion = await lockPlayerCommandState(transaction, input.actorPlayerId);
    const receiptId = randomUUID();
    const acquired = await transaction.$queryRawUnsafe<readonly IdRow[]>(
      `/* p0-bootstrap:idempotency-acquire */
       INSERT INTO "IdempotencyRecord" (
         "id", "playerId", "actorScope", "idempotencyKey", "requestFingerprint",
         "status", "aggregateType", "aggregateId", "createdAt", "expiresAt"
       ) VALUES ($1,$2,$3,$4,$5,'PROCESSING','BootstrapPlayerCommandState',$2,
         CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + INTERVAL '30 days')
       ON CONFLICT DO NOTHING
       RETURNING "id"`,
      receiptId,
      input.actorPlayerId,
      input.aggregateScope,
      input.idempotencyKey,
      input.requestFingerprint,
    );
    if (!acquired[0]) return replayExisting(transaction, input);

    if (currentVersion !== input.expectedVersion) {
      throw new CommandError(409, 'EXPECTED_VERSION_CONFLICT', {
        actualVersion: currentVersion,
        expectedVersion: input.expectedVersion,
      });
    }

    const authority = await deriveOrReuseAuthority(transaction, input.actorPlayerId);
    const playerCommandVersion = currentVersion + 1;
    const context: TrustedBootstrapContext = Object.freeze({
      actorPlayerId: input.actorPlayerId,
      authorityId: authority.id,
      commandId: input.commandId,
      requestFingerprint: input.requestFingerprint,
      playerCommandVersion,
    });
    const derived = this.createServerPlan(context, input.intent);
    const provisioned = await provisionCompetitiveSaveInTransaction(transaction, {
      context,
      epochId: derived.epochId,
      plan: derived.plan,
    });

    const advanced = await transaction.$queryRawUnsafe<readonly VersionRow[]>(
      `/* p0-bootstrap:state-advance */
       UPDATE "BootstrapPlayerCommandState"
       SET "version" = $2, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "playerId" = $1 AND "version" = $3
       RETURNING "version"`,
      input.actorPlayerId,
      playerCommandVersion,
      currentVersion,
    );
    if (advanced[0]?.version !== playerCommandVersion) {
      throw new CommandError(409, 'EXPECTED_VERSION_CONFLICT');
    }

    const execution: InitializeExecution = Object.freeze({
      commandId: input.commandId,
      aggregateVersion: playerCommandVersion,
      result: bootstrapResultJson(provisioned),
    });
    const completed = await transaction.$executeRawUnsafe(
      `/* p0-bootstrap:idempotency-complete */
       UPDATE "IdempotencyRecord"
       SET "status" = 'COMPLETED', "responseSnapshot" = $2::jsonb,
           "terminalAt" = CURRENT_TIMESTAMP,
           "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '30 days'
       WHERE "id" = $1 AND "status" = 'PROCESSING'`,
      receiptId,
      JSON.stringify(execution),
    );
    if (completed !== 1) unavailable();
    return execution;
  }
}

async function lockPlayerCommandState(
  transaction: BootstrapSqlTransaction,
  actorPlayerId: string,
): Promise<number> {
  await transaction.$executeRawUnsafe(
    `/* p0-bootstrap:state-create */
     INSERT INTO "BootstrapPlayerCommandState" ("playerId", "version", "createdAt", "updatedAt")
     SELECT player."id", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     FROM "Player" player WHERE player."id" = $1
     ON CONFLICT ("playerId") DO NOTHING`,
    actorPlayerId,
  );
  const rows = await transaction.$queryRawUnsafe<readonly VersionRow[]>(
    `/* p0-bootstrap:state-lock */
     SELECT "version" FROM "BootstrapPlayerCommandState"
     WHERE "playerId" = $1 FOR UPDATE`,
    actorPlayerId,
  );
  const version = rows[0]?.version;
  if (version === undefined) forbidden();
  return version;
}

async function replayExisting(
  transaction: BootstrapSqlTransaction,
  input: InitializeInput,
): Promise<InitializeExecution> {
  const rows = await transaction.$queryRawUnsafe<readonly IdempotencyRow[]>(
    `/* p0-bootstrap:idempotency-lock */
     SELECT "requestFingerprint", "responseSnapshot", "status"
     FROM "IdempotencyRecord"
     WHERE "actorScope" = $1 AND "idempotencyKey" = $2
     FOR UPDATE`,
    input.aggregateScope,
    input.idempotencyKey,
  );
  const record = rows[0];
  if (!record) throw new CommandError(409, 'INITIALIZE_COMPETITIVE_SAVE_CONFLICT');
  if (record.requestFingerprint !== input.requestFingerprint) {
    throw new CommandError(409, 'IDEMPOTENCY_KEY_REUSED');
  }
  if (record.status !== 'COMPLETED') throw new CommandError(409, 'COMMAND_IN_PROGRESS');
  return storedExecution(record.responseSnapshot);
}

async function deriveOrReuseAuthority(
  transaction: BootstrapSqlTransaction,
  actorPlayerId: string,
): Promise<AuthorityRow> {
  const active = await transaction.$queryRawUnsafe<readonly AuthorityRow[]>(
    `/* p0-bootstrap:authority-active */
     SELECT authority."id", authority."playerId", authority."cohortId",
            authority."cohortMembershipId", authority."inviteId",
            authority."consentDecisionId", authority."sourceEligibilityRestaurantId",
            authority."policyVersion", authority."policyDigest"
     FROM "BootstrapAuthority" authority
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
       ON policy."id" = cohort."entryConsentPolicyId"
      AND policy."cohortId" = cohort."id"
     JOIN "ConsentDecision" decision
       ON decision."id" = authority."consentDecisionId"
      AND decision."cohortId" = cohort."id"
      AND decision."playerId" = authority."playerId"
      AND decision."policyId" = policy."id"
     WHERE authority."playerId" = $1
       AND membership."status" = 'ACTIVE' AND membership."revokedAt" IS NULL
       AND invitation."status" = 'CONSUMED'
       AND invitation."invitedPlayerId" = $1 AND invitation."consumedByPlayerId" = $1
       AND cohort."status" = 'OPEN'
       AND cohort."opensAt" <= CURRENT_TIMESTAMP AND cohort."closesAt" > CURRENT_TIMESTAMP
       AND policy."requiredForEntry" = TRUE AND policy."retiredAt" IS NULL
       AND decision."decision" = 'ACCEPTED' AND decision."acceptedAt" IS NOT NULL
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
     FOR SHARE OF authority, membership, invitation, cohort, policy, decision`,
    actorPlayerId,
  );
  if (active[0]) return active[0];

  const immutable = await transaction.$queryRawUnsafe<readonly IdRow[]>(
    `/* p0-bootstrap:authority-any */
     SELECT "id" FROM "BootstrapAuthority" WHERE "playerId" = $1 FOR SHARE`,
    actorPlayerId,
  );
  if (immutable[0]) forbidden();

  const candidates = await transaction.$queryRawUnsafe<readonly Omit<AuthorityRow, 'id'>[]>(
    `/* p0-bootstrap:d05-candidates */
     SELECT membership."playerId", cohort."id" AS "cohortId",
            membership."id" AS "cohortMembershipId", invitation."id" AS "inviteId",
            decision."id" AS "consentDecisionId",
            cohort."restaurantId" AS "sourceEligibilityRestaurantId",
            decision."policyVersion", decision."policyDigest"
     FROM "TestCohortMembership" membership
     JOIN "TestCohortInvite" invitation
       ON invitation."id" = membership."inviteId"
      AND invitation."cohortId" = membership."cohortId"
     JOIN "TestCohort" cohort ON cohort."id" = membership."cohortId"
     JOIN "ConsentPolicy" policy
       ON policy."id" = cohort."entryConsentPolicyId" AND policy."cohortId" = cohort."id"
     JOIN "ConsentDecision" decision
       ON decision."cohortId" = cohort."id"
      AND decision."playerId" = membership."playerId"
      AND decision."policyId" = policy."id"
     WHERE membership."playerId" = $1
       AND membership."status" = 'ACTIVE' AND membership."revokedAt" IS NULL
       AND invitation."status" = 'CONSUMED'
       AND invitation."invitedPlayerId" = $1 AND invitation."consumedByPlayerId" = $1
       AND cohort."status" = 'OPEN'
       AND cohort."opensAt" <= CURRENT_TIMESTAMP AND cohort."closesAt" > CURRENT_TIMESTAMP
       AND policy."requiredForEntry" = TRUE AND policy."retiredAt" IS NULL
       AND decision."decision" = 'ACCEPTED' AND decision."acceptedAt" IS NOT NULL
       AND decision."retentionUntil" > CURRENT_TIMESTAMP
       AND NOT EXISTS (
         SELECT 1 FROM "ConsentDecision" later
         WHERE later."cohortId" = decision."cohortId"
           AND later."playerId" = decision."playerId"
           AND later."policyId" = decision."policyId"
           AND later."decisionSequence" > decision."decisionSequence"
       )
     ORDER BY cohort."id", membership."id", decision."decisionSequence" DESC
     LIMIT 2
     FOR SHARE OF membership, invitation, cohort, policy, decision`,
    actorPlayerId,
  );
  if (candidates.length !== 1 || !candidates[0]) forbidden();
  const candidate = candidates[0];
  const created = await transaction.$queryRawUnsafe<readonly AuthorityRow[]>(
    `/* p0-bootstrap:authority-create */
     INSERT INTO "BootstrapAuthority" (
       "id", "playerId", "cohortId", "cohortMembershipId", "inviteId",
       "consentDecisionId", "sourceEligibilityRestaurantId", "policyVersion",
       "policyDigest", "createdAt"
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP)
     RETURNING "id", "playerId", "cohortId", "cohortMembershipId", "inviteId",
       "consentDecisionId", "sourceEligibilityRestaurantId", "policyVersion", "policyDigest"`,
    randomUUID(),
    candidate.playerId,
    candidate.cohortId,
    candidate.cohortMembershipId,
    candidate.inviteId,
    candidate.consentDecisionId,
    candidate.sourceEligibilityRestaurantId,
    candidate.policyVersion,
    candidate.policyDigest,
  );
  if (!created[0]) forbidden();
  return created[0];
}

function validateInput(input: InitializeInput): void {
  if (input.aggregateScope !== bootstrapPlayerScope(input.actorPlayerId)) forbidden();
  if (
    !isBootstrapCommandId(input.commandId) ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200 ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    !/^[0-9a-f]{64}$/.test(input.requestFingerprint)
  ) {
    throw new CommandError(422, 'COMMAND_ENVELOPE_INVALID');
  }
}

function storedExecution(value: unknown): InitializeExecution {
  if (!isRecord(value)) unavailable();
  const commandId = value.commandId;
  const aggregateVersion = value.aggregateVersion;
  const result = value.result;
  if (
    typeof commandId !== 'string' ||
    !Number.isSafeInteger(aggregateVersion) ||
    (aggregateVersion as number) < 1 ||
    !isJsonValue(result)
  ) {
    unavailable();
  }
  return Object.freeze({ commandId, aggregateVersion: aggregateVersion as number, result });
}

function bootstrapResultJson(
  value: Readonly<{
    authorityId: string;
    epochId: string;
    epochNumber: number;
    provisionedRestaurantId: string;
    ownerMembershipId: string;
    saveId: string;
    ownerAuditLogId: string;
    replayed: boolean;
  }>,
): JsonValue {
  return Object.freeze({ ...value });
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRetryableConflict(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return ['23505', '40001', '40P01', 'P2002', 'P2034'].includes(String(error.code));
}

function forbidden(): never {
  throw new CommandError(403, 'INITIALIZE_COMPETITIVE_SAVE_FORBIDDEN');
}

function unavailable(): never {
  throw new CommandError(503, 'INITIALIZE_COMPETITIVE_SAVE_UNAVAILABLE');
}
