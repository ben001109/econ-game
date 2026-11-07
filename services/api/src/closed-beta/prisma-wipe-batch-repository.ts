import { CommandError, encodeCommandScope } from '../commands/command-contract.js';
import type { PlayerRecord } from '../auth/trusted-command-context.js';
import {
  buildWipePreview,
  canonicalJson,
  sha256,
  wipePreviewResult,
  type WipeBatchRepository,
  type WipeBatchStatusView,
  type WipeCommandExecution,
  type WipeCommandInput,
  type WipePreview,
  type WipeSaveCandidate,
} from './wipe-batch.js';
import type { D05Database } from './prisma-closed-beta-repository.js';

type Queryable = Readonly<{
  $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T>;
}>;

type IdRow = Readonly<{ id: string }>;
type IdempotencyRow = Readonly<{
  commandId: string;
  requestFingerprint: string;
  status: string;
  responseSnapshot: unknown;
}>;
type BatchRow = Readonly<{
  id: string;
  restaurantId: string;
  lifecyclePhase: 'FROZEN' | 'ISOLATED' | 'CLEARED' | 'VERIFIED' | null;
  scope: unknown;
  scopeHash: string;
  policyVersion: string;
  policyHash: string;
  requestedByPlayerId: string;
  approvedByPlayerId: string | null;
  approvedAt: Date | null;
  dryRunManifest: unknown;
  dryRunManifestHash: string;
  verificationSnapshot: unknown;
  verificationHash: string | null;
  frozenAt: Date | null;
  isolatedAt: Date | null;
  clearEligibleAt: Date | null;
}>;
type SequenceRow = Readonly<{ sequence: bigint | number | string }>;
type CheckpointRow = Readonly<{
  sequence: bigint | number | string;
  phase: 'FROZEN' | 'ISOLATED' | 'CLEARED' | 'VERIFIED';
  attempt: number;
  outcome: 'SUCCEEDED' | 'FAILED';
}>;
type ScopeRow = Readonly<{
  restaurantId: string;
  saveId: string;
  ordinal: number;
  scopeItemHash: string;
}>;
type IsolationRow = Readonly<{ isolatedAt: Date; clearEligibleAt: Date }>;

export class PrismaWipeBatchRepository implements WipeBatchRepository {
  readonly durability = 'durable' as const;

  constructor(private readonly database: D05Database) {}

  async findPlayerByClerkSubject(subject: string): Promise<PlayerRecord | undefined> {
    const rows = await this.database.$queryRawUnsafe<readonly PlayerRecord[]>(
      'SELECT "id", "clerkUserId" FROM "Player" WHERE "clerkUserId" = $1 LIMIT 1',
      subject,
    );
    return rows[0];
  }

  preview(actorPlayerId: string, restaurantId: string): Promise<WipePreview> {
    return this.database.$transaction(async (transaction) => {
      await assertOwner(transaction, actorPlayerId, restaurantId);
      return buildWipePreview(
        restaurantId,
        await activeSaveCandidates(transaction, restaurantId),
        await wipeEnvironment(transaction, restaurantId),
      );
    });
  }

  request(input: WipeCommandInput): Promise<WipeCommandExecution> {
    return this.executeIdempotently(input, async (transaction) => {
      if (input.command.expectedVersion !== 0) versionConflict(0, input.command.expectedVersion);
      await assertOwner(transaction, input.actorPlayerId, input.restaurantId);
      const preview = buildWipePreview(
        input.restaurantId,
        await activeSaveCandidates(transaction, input.restaurantId, true),
        await wipeEnvironment(transaction, input.restaurantId),
      );
      if (preview.saves.length === 0) throw new CommandError(422, 'WIPE_SCOPE_EMPTY');
      if (input.command.payload.dryRunManifestHash !== preview.manifestHash) {
        throw new CommandError(409, 'WIPE_DRY_RUN_STALE');
      }
      const reason = input.command.payload.reason;
      if (typeof reason !== 'string') invalid();
      await transaction.$queryRawUnsafe(
        `INSERT INTO "WipeBatch" (
          "id", "restaurantId", "status", "scope", "scopeVersion", "scopeHash",
          "policyVersion", "policyHash", "reason", "requestedByPlayerId",
          "dryRunManifest", "dryRunManifestHash", "createdAt"
        ) VALUES ($1,$2,'DRAFT',$3::jsonb,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,CURRENT_TIMESTAMP)`,
        input.generatedBatchId,
        input.restaurantId,
        JSON.stringify({
          version: preview.scopeVersion,
          restaurantId: preview.restaurantId,
          environment: preview.environment,
          saves: preview.saves.map(({ id, version }) => ({ id, version })),
        }),
        preview.scopeVersion,
        preview.scopeHash,
        preview.policyVersion,
        preview.policyHash,
        reason,
        input.actorPlayerId,
        JSON.stringify(preview.manifest),
        preview.manifestHash,
      );
      await audit(transaction, input, input.generatedBatchId, 'wipe_batch_requested', {
        scopeHash: preview.scopeHash,
        policyVersion: preview.policyVersion,
        policyHash: preview.policyHash,
        manifestHash: preview.manifestHash,
        saveCount: preview.saves.length,
      });
      return {
        commandId: input.command.commandId,
        aggregateVersion: 1,
        result: { batchId: input.generatedBatchId, ...wipePreviewResult(preview) },
      };
    });
  }

  approve(input: WipeCommandInput): Promise<WipeCommandExecution> {
    return this.executeIdempotently(input, async (transaction) => {
      const batch = await lockedBatch(transaction, input.restaurantId, input.command.aggregateId);
      const version = await aggregateVersion(transaction, batch);
      assertVersion(input, version);
      if (batch.lifecyclePhase !== null || batch.approvedByPlayerId !== null) conflict();
      if (batch.requestedByPlayerId === input.actorPlayerId) {
        throw new CommandError(409, 'WIPE_DISTINCT_APPROVER_REQUIRED');
      }
      await assertOwner(transaction, batch.requestedByPlayerId, input.restaurantId);
      await assertOwner(transaction, input.actorPlayerId, input.restaurantId);
      const expected = scopeCandidates(batch.scope);
      const current = await activeSaveCandidates(transaction, input.restaurantId, true);
      if (
        canonicalJson(expected.map(({ id, version }) => ({ id, version }))) !==
        canonicalJson(current.map(({ id, version }) => ({ id, version })))
      ) {
        throw new CommandError(409, 'WIPE_SCOPE_STALE');
      }
      await transaction.$queryRawUnsafe(
        `UPDATE "WipeBatch" SET "approvedByPlayerId" = $3, "approvedAt" = CURRENT_TIMESTAMP,
          "status" = 'APPROVED' WHERE "id" = $1 AND "restaurantId" = $2`,
        batch.id,
        input.restaurantId,
        input.actorPlayerId,
      );
      for (const [ordinal, save] of current.entries()) {
        await transaction.$queryRawUnsafe(
          `INSERT INTO "WipeBatchSaveScope" (
            "wipeBatchId", "restaurantId", "saveId", "ordinal", "scopeItemHash"
          ) VALUES ($1,$2,$3,$4,$5)`,
          batch.id,
          input.restaurantId,
          save.id,
          ordinal,
          sha256(canonicalJson({ id: save.id, version: save.version })),
        );
      }
      await audit(transaction, input, batch.id, 'wipe_batch_approved', {
        requesterPlayerId: batch.requestedByPlayerId,
        approverPlayerId: input.actorPlayerId,
        scopeHash: batch.scopeHash,
      });
      return execution(input, version + 1, batch.id, 'APPROVED');
    });
  }

  freeze(input: WipeCommandInput): Promise<WipeCommandExecution> {
    return this.runCheckpointCommand(input, 'FROZEN');
  }

  isolate(input: WipeCommandInput): Promise<WipeCommandExecution> {
    return this.runCheckpointCommand(input, 'ISOLATED');
  }

  async resume(input: WipeCommandInput): Promise<WipeCommandExecution> {
    let interruptedPhase: 'FROZEN' | 'ISOLATED' | undefined;
    try {
      return await this.executeIdempotently(input, async (transaction) => {
        const batch = await lockedBatch(transaction, input.restaurantId, input.command.aggregateId);
        await assertBatchOwners(transaction, batch, input.actorPlayerId);
        const version = await aggregateVersion(transaction, batch);
        assertVersion(input, version);
        const latest = await latestCheckpoint(transaction, batch.id);
        if (
          !latest ||
          latest.outcome !== 'FAILED' ||
          (latest.phase !== 'FROZEN' && latest.phase !== 'ISOLATED')
        ) {
          throw new CommandError(409, 'WIPE_NOT_RESUMABLE');
        }
        interruptedPhase = latest.phase;
        return this.executeCheckpoint(
          transaction,
          input,
          batch,
          latest.phase,
          latest.attempt + 1,
          version,
        );
      });
    } catch (error) {
      if (error instanceof CommandError || !interruptedPhase) throw error;
      await this.recordInterruptedCheckpoint(input, interruptedPhase);
      throw new CommandError(409, 'WIPE_OPERATION_INTERRUPTED');
    }
  }

  async status(
    actorPlayerId: string,
    restaurantId: string,
    batchId: string,
  ): Promise<WipeBatchStatusView> {
    return this.database.$transaction(async (transaction) => {
      const batch = await lockedBatch(transaction, restaurantId, batchId);
      await assertOwner(transaction, actorPlayerId, restaurantId);
      return Object.freeze({
        id: batch.id,
        restaurantId,
        aggregateVersion: await aggregateVersion(transaction, batch),
        lifecyclePhase: batch.lifecyclePhase,
        requestedByPlayerId: batch.requestedByPlayerId,
        approvedByPlayerId: batch.approvedByPlayerId,
        scopeHash: batch.scopeHash,
        policyVersion: batch.policyVersion,
        policyHash: batch.policyHash,
        dryRunManifestHash: batch.dryRunManifestHash,
        frozenAt: batch.frozenAt,
        isolatedAt: batch.isolatedAt,
        clearEligibleAt: batch.clearEligibleAt,
      });
    });
  }

  assertSaveMutationAllowed(
    actorPlayerId: string,
    restaurantId: string,
    saveId: string,
  ): Promise<void> {
    return this.database.$transaction(async (transaction) => {
      const access = await transaction.$queryRawUnsafe<readonly IdRow[]>(
        `SELECT save."id" FROM "CompetitiveSave" save
         JOIN "RestaurantMembership" membership
           ON membership."playerId" = $1 AND membership."restaurantId" = save."restaurantId"
          AND membership."revokedAt" IS NULL
         WHERE save."id" = $2 AND save."restaurantId" = $3 AND save."retiredAt" IS NULL
         FOR SHARE OF save, membership`,
        actorPlayerId,
        saveId,
        restaurantId,
      );
      if (!access[0]) throw new CommandError(403, 'WIPE_SCOPE_FORBIDDEN');
      const frozen = await transaction.$queryRawUnsafe<readonly IdRow[]>(
        `SELECT scope."saveId" AS "id" FROM "WipeBatchSaveScope" scope
         JOIN "WipeBatch" batch ON batch."id" = scope."wipeBatchId"
           AND batch."restaurantId" = scope."restaurantId"
         WHERE scope."restaurantId" = $1 AND scope."saveId" = $2
           AND batch."lifecyclePhase" IN ('FROZEN', 'ISOLATED', 'CLEARED')
         LIMIT 1 FOR SHARE OF batch`,
        restaurantId,
        saveId,
      );
      if (frozen[0]) throw new CommandError(409, 'WIPE_SCOPE_FROZEN');
    });
  }

  private async runCheckpointCommand(
    input: WipeCommandInput,
    phase: 'FROZEN' | 'ISOLATED',
  ): Promise<WipeCommandExecution> {
    try {
      return await this.executeIdempotently(input, async (transaction) => {
        const batch = await lockedBatch(transaction, input.restaurantId, input.command.aggregateId);
        await assertBatchOwners(transaction, batch, input.actorPlayerId);
        const version = await aggregateVersion(transaction, batch);
        assertVersion(input, version);
        const latest = await latestCheckpoint(transaction, batch.id);
        if (latest?.outcome === 'FAILED') {
          throw new CommandError(409, 'WIPE_RESUME_REQUIRED');
        }
        return this.executeCheckpoint(transaction, input, batch, phase, 1, version);
      });
    } catch (error) {
      if (error instanceof CommandError) throw error;
      await this.recordInterruptedCheckpoint(input, phase);
      throw new CommandError(409, 'WIPE_OPERATION_INTERRUPTED');
    }
  }

  private recordInterruptedCheckpoint(
    input: WipeCommandInput,
    phase: 'FROZEN' | 'ISOLATED',
  ): Promise<void> {
    return this.database.$transaction(async (transaction) => {
      const batch = await lockedBatch(transaction, input.restaurantId, input.command.aggregateId);
      await assertBatchOwners(transaction, batch, input.actorPlayerId);
      const version = await aggregateVersion(transaction, batch);
      assertVersion(input, version);
      const latest = await latestCheckpoint(transaction, batch.id);
      const sequence = latest ? numeric(latest.sequence) + 1 : 1;
      const attempt =
        latest?.outcome === 'FAILED' && latest.phase === phase ? latest.attempt + 1 : 1;
      const evidence = {
        version: 'd05-wipe-checkpoint-evidence/v1',
        phase,
        scopeHash: batch.scopeHash,
        policyHash: batch.policyHash,
        interruption: 'MANUAL_RESUME_REQUIRED',
      };
      await transaction.$queryRawUnsafe(
        `INSERT INTO "WipeBatchCheckpoint" (
          "id", "wipeBatchId", "sequence", "phase", "attempt", "outcome",
          "actorPlayerId", "manifestHash", "evidence", "evidenceHash",
          "errorCode", "errorDetails", "occurredAt"
        ) VALUES ($1,$2,$3,$4::"WipeLifecyclePhase",$5,'FAILED',$6,$7,$8::jsonb,$9,
          'WIPE_OPERATION_INTERRUPTED',$10::jsonb,CURRENT_TIMESTAMP)`,
        input.generatedCheckpointId,
        batch.id,
        sequence,
        phase,
        attempt,
        input.actorPlayerId,
        batch.dryRunManifestHash,
        JSON.stringify(evidence),
        sha256(canonicalJson(evidence)),
        JSON.stringify({ resumable: true }),
      );
      await audit(transaction, input, batch.id, 'wipe_batch_interrupted', {
        phase,
        sequence,
        attempt,
        errorCode: 'WIPE_OPERATION_INTERRUPTED',
      });
    });
  }

  private async executeCheckpoint(
    transaction: Queryable,
    input: WipeCommandInput,
    batch: BatchRow,
    phase: 'FROZEN' | 'ISOLATED',
    attempt: number,
    version: number,
  ): Promise<WipeCommandExecution> {
    const scopes = await scopeRows(transaction, batch.id);
    if (scopes.length === 0) conflict();
    const latest = await latestCheckpoint(transaction, batch.id);
    const sequence = latest ? numeric(latest.sequence) + 1 : 1;
    if (phase === 'FROZEN') {
      if (batch.lifecyclePhase !== null || (latest && latest.phase !== 'FROZEN')) conflict();
    } else if (batch.lifecyclePhase !== 'FROZEN') conflict();

    const countSnapshot = {
      phase,
      scopedSaveCount: scopes.length,
      retiredSaveCount: phase === 'ISOLATED' ? scopes.length : 0,
    };
    const evidence = {
      version: 'd05-wipe-checkpoint-evidence/v1',
      phase,
      scopeHash: batch.scopeHash,
      policyHash: batch.policyHash,
      manifestHash: batch.dryRunManifestHash,
    };
    await transaction.$queryRawUnsafe(
      `INSERT INTO "WipeBatchCheckpoint" (
        "id", "wipeBatchId", "sequence", "phase", "attempt", "outcome",
        "actorPlayerId", "manifestHash", "countSnapshot", "countHash",
        "evidence", "evidenceHash", "occurredAt"
      ) VALUES ($1,$2,$3,$4::"WipeLifecyclePhase",$5,'SUCCEEDED',$6,$7,$8::jsonb,$9,$10::jsonb,$11,CURRENT_TIMESTAMP)`,
      input.generatedCheckpointId,
      batch.id,
      sequence,
      phase,
      attempt,
      input.actorPlayerId,
      batch.dryRunManifestHash,
      JSON.stringify(countSnapshot),
      sha256(canonicalJson(countSnapshot)),
      JSON.stringify(evidence),
      sha256(canonicalJson(evidence)),
    );

    let isolation: IsolationRow | undefined;
    if (phase === 'ISOLATED') {
      const locked = await transaction.$queryRawUnsafe<readonly IdRow[]>(
        `SELECT save."id" FROM "CompetitiveSave" save
         JOIN "WipeBatchSaveScope" scope ON scope."restaurantId" = save."restaurantId"
           AND scope."saveId" = save."id" AND scope."wipeBatchId" = $1
         WHERE save."restaurantId" = $2 AND save."retiredAt" IS NULL
         ORDER BY save."id" FOR UPDATE OF save`,
        batch.id,
        input.restaurantId,
      );
      if (locked.length !== scopes.length) throw new CommandError(409, 'WIPE_SCOPE_STALE');
      await transaction.$queryRawUnsafe(
        `UPDATE "CompetitiveSave" save SET "retiredAt" = CURRENT_TIMESTAMP,
           "retiredByWipeBatchId" = $1, "updatedAt" = CURRENT_TIMESTAMP
         FROM "WipeBatchSaveScope" scope
         WHERE scope."wipeBatchId" = $1 AND scope."restaurantId" = $2
           AND scope."saveId" = save."id" AND save."restaurantId" = scope."restaurantId"
           AND save."retiredAt" IS NULL`,
        batch.id,
        input.restaurantId,
      );
      const rows = await transaction.$queryRawUnsafe<readonly IsolationRow[]>(
        `UPDATE "WipeBatch" SET "lifecyclePhase" = 'ISOLATED',
           "isolatedAt" = CURRENT_TIMESTAMP, "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP)
         WHERE "id" = $1 AND "restaurantId" = $2
         RETURNING "isolatedAt", "clearEligibleAt"`,
        batch.id,
        input.restaurantId,
      );
      isolation = rows[0];
      if (!isolation) conflict();
    } else {
      await transaction.$queryRawUnsafe(
        `UPDATE "WipeBatch" SET "lifecyclePhase" = 'FROZEN', "frozenAt" = CURRENT_TIMESTAMP,
           "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP), "status" = 'RUNNING'
         WHERE "id" = $1 AND "restaurantId" = $2`,
        batch.id,
        input.restaurantId,
      );
    }
    await audit(transaction, input, batch.id, `wipe_batch_${phase.toLowerCase()}`, {
      phase,
      sequence,
      attempt,
      manifestHash: batch.dryRunManifestHash,
      countHash: sha256(canonicalJson(countSnapshot)),
    });
    return {
      commandId: input.command.commandId,
      aggregateVersion: version + 1,
      result: {
        batchId: batch.id,
        phase,
        ...(isolation
          ? {
              isolatedAt: isolation.isolatedAt.toISOString(),
              clearEligibleAt: isolation.clearEligibleAt.toISOString(),
            }
          : {}),
      },
    };
  }

  private executeIdempotently(
    input: WipeCommandInput,
    operation: (transaction: Queryable) => Promise<WipeCommandExecution>,
  ): Promise<WipeCommandExecution> {
    return this.database.$transaction(async (transaction) => {
      const actorScope = encodeCommandScope([input.restaurantId, input.actorPlayerId, 'WipeBatch']);
      const acquired = await transaction.$queryRawUnsafe<readonly IdRow[]>(
        `INSERT INTO "IdempotencyRecord" (
          "id", "restaurantId", "playerId", "actorScope", "idempotencyKey",
          "requestFingerprint", "status", "aggregateType", "aggregateId", "createdAt", "expiresAt"
        ) VALUES ($1,$2,$3,$4,$5,$6,'PROCESSING','WipeBatch',$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + INTERVAL '30 days')
        ON CONFLICT DO NOTHING RETURNING "id"`,
        input.command.commandId,
        input.restaurantId,
        input.actorPlayerId,
        actorScope,
        input.command.idempotencyKey,
        input.requestFingerprint,
        input.command.aggregateId,
      );
      if (!acquired[0]) return replay(transaction, actorScope, input);
      const result = await operation(transaction);
      await transaction.$queryRawUnsafe(
        `UPDATE "IdempotencyRecord" SET "status" = 'COMPLETED', "responseSnapshot" = $2::jsonb,
          "terminalAt" = CURRENT_TIMESTAMP, "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '30 days'
         WHERE "id" = $1`,
        input.command.commandId,
        JSON.stringify(result),
      );
      return result;
    });
  }
}

async function activeSaveCandidates(
  database: Queryable,
  restaurantId: string,
  lock = false,
): Promise<readonly WipeSaveCandidate[]> {
  return database.$queryRawUnsafe<readonly WipeSaveCandidate[]>(
    `SELECT "id", "version", "openingSnapshotHash" FROM "CompetitiveSave"
     WHERE "restaurantId" = $1 AND "retiredAt" IS NULL ORDER BY "id"${lock ? ' FOR SHARE' : ''}`,
    restaurantId,
  );
}

async function wipeEnvironment(database: Queryable, restaurantId: string) {
  const rows = await database.$queryRawUnsafe<readonly { environment: string }[]>(
    `SELECT DISTINCT "environment" FROM "TestCohort"
     WHERE "restaurantId" = $1 AND "status" IN ('OPEN', 'CLOSED') ORDER BY "environment"`,
    restaurantId,
  );
  if (rows.length !== 1 || !rows[0]?.environment) {
    throw new CommandError(409, 'WIPE_SCOPE_ENVIRONMENT_AMBIGUOUS');
  }
  return rows[0].environment;
}

async function assertOwner(database: Queryable, playerId: string, restaurantId: string) {
  const rows = await database.$queryRawUnsafe<readonly IdRow[]>(
    `SELECT "id" FROM "RestaurantMembership" WHERE "playerId" = $1 AND "restaurantId" = $2
       AND "role" = 'OWNER' AND "revokedAt" IS NULL FOR SHARE`,
    playerId,
    restaurantId,
  );
  if (!rows[0]) throw new CommandError(403, 'WIPE_SCOPE_FORBIDDEN');
}

async function assertBatchOwners(database: Queryable, batch: BatchRow, actorPlayerId: string) {
  if (!batch.approvedByPlayerId || actorPlayerId !== batch.approvedByPlayerId) {
    throw new CommandError(403, 'WIPE_SCOPE_FORBIDDEN');
  }
  await assertOwner(database, batch.requestedByPlayerId, batch.restaurantId);
  await assertOwner(database, batch.approvedByPlayerId, batch.restaurantId);
}

async function lockedBatch(database: Queryable, restaurantId: string, batchId: string) {
  const rows = await database.$queryRawUnsafe<readonly BatchRow[]>(
    `SELECT "id", "restaurantId", "lifecyclePhase", "scope", "scopeHash", "policyVersion",
       "policyHash", "requestedByPlayerId", "approvedByPlayerId", "approvedAt",
       "dryRunManifest", "dryRunManifestHash", "verificationSnapshot", "verificationHash",
       "frozenAt", "isolatedAt", "clearEligibleAt"
     FROM "WipeBatch" WHERE "id" = $1 AND "restaurantId" = $2 FOR UPDATE`,
    batchId,
    restaurantId,
  );
  if (!rows[0]) throw new CommandError(403, 'WIPE_SCOPE_FORBIDDEN');
  return rows[0];
}

async function aggregateVersion(database: Queryable, batch: BatchRow) {
  const rows = await database.$queryRawUnsafe<readonly SequenceRow[]>(
    'SELECT COALESCE(MAX("sequence"), 0) AS "sequence" FROM "WipeBatchCheckpoint" WHERE "wipeBatchId" = $1',
    batch.id,
  );
  return 1 + (batch.approvedByPlayerId ? 1 : 0) + numeric(rows[0]?.sequence ?? 0);
}

async function latestCheckpoint(database: Queryable, batchId: string) {
  const rows = await database.$queryRawUnsafe<readonly CheckpointRow[]>(
    `SELECT "sequence", "phase", "attempt", "outcome" FROM "WipeBatchCheckpoint"
     WHERE "wipeBatchId" = $1 ORDER BY "sequence" DESC LIMIT 1 FOR SHARE`,
    batchId,
  );
  return rows[0];
}

function scopeRows(database: Queryable, batchId: string) {
  return database.$queryRawUnsafe<readonly ScopeRow[]>(
    `SELECT "restaurantId", "saveId", "ordinal", "scopeItemHash" FROM "WipeBatchSaveScope"
     WHERE "wipeBatchId" = $1 ORDER BY "ordinal" FOR SHARE`,
    batchId,
  );
}

function scopeCandidates(value: unknown): readonly Readonly<{ id: string; version: number }>[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const saves = (value as { saves?: unknown }).saves;
  if (!Array.isArray(saves)) invalid();
  return saves.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid();
    const { id, version } = entry as { id?: unknown; version?: unknown };
    if (typeof id !== 'string' || typeof version !== 'number' || !Number.isSafeInteger(version)) {
      invalid();
    }
    return { id, version: version as number };
  });
}

async function replay(database: Queryable, actorScope: string, input: WipeCommandInput) {
  const rows = await database.$queryRawUnsafe<readonly IdempotencyRow[]>(
    `SELECT "id" AS "commandId", "requestFingerprint", "status", "responseSnapshot"
     FROM "IdempotencyRecord" WHERE "actorScope" = $1 AND "idempotencyKey" = $2 FOR SHARE`,
    actorScope,
    input.command.idempotencyKey,
  );
  const row = rows[0];
  if (!row) conflict();
  if (row.requestFingerprint !== input.requestFingerprint) {
    throw new CommandError(409, 'IDEMPOTENCY_KEY_REUSED');
  }
  if (row.status !== 'COMPLETED') throw new CommandError(409, 'COMMAND_IN_PROGRESS');
  if (!row.responseSnapshot || typeof row.responseSnapshot !== 'object') conflict();
  return row.responseSnapshot as WipeCommandExecution;
}

async function audit(
  database: Queryable,
  input: WipeCommandInput,
  batchId: string,
  action: string,
  metadata: Readonly<Record<string, unknown>>,
) {
  await database.$queryRawUnsafe(
    `INSERT INTO "AuditLog" (
      "id", "restaurantId", "actorPlayerId", "actorType", "action", "targetType",
      "targetId", "metadata", "correlationId", "createdAt"
    ) VALUES ($1,$2,$3,'clerk_user',$4,'WipeBatch',$5,$6::jsonb,$7,CURRENT_TIMESTAMP)`,
    input.generatedAuditId,
    input.restaurantId,
    input.actorPlayerId,
    action,
    batchId,
    JSON.stringify(metadata),
    input.correlationId,
  );
}

function execution(
  input: WipeCommandInput,
  aggregateVersion: number,
  batchId: string,
  phase: string,
): WipeCommandExecution {
  return {
    commandId: input.command.commandId,
    aggregateVersion,
    result: { batchId, phase },
  };
}

function assertVersion(input: WipeCommandInput, actualVersion: number) {
  if (input.command.expectedVersion !== actualVersion) {
    versionConflict(actualVersion, input.command.expectedVersion);
  }
}

function numeric(value: bigint | number | string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) conflict();
  return parsed;
}

function versionConflict(actualVersion: number, expectedVersion: number): never {
  throw new CommandError(409, 'EXPECTED_VERSION_CONFLICT', { actualVersion, expectedVersion });
}

function invalid(): never {
  throw new CommandError(422, 'WIPE_REQUEST_INVALID');
}

function conflict(): never {
  throw new CommandError(409, 'WIPE_STATE_CONFLICT');
}
