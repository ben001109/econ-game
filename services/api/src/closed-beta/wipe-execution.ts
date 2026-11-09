import { randomBytes, randomUUID } from 'node:crypto';

import type { JwtVerifier } from '../auth/jwt-verifier.js';
import { JwtVerificationError } from '../auth/jwt-verifier.js';
import type { PlayerRecord } from '../auth/trusted-command-context.js';
import {
  CommandError,
  hashCommandRequest,
  parseCommandEnvelope,
} from '../commands/command-contract.js';
import { canonicalJson, sha256 } from './wipe-batch.js';
import type { D05Database } from './prisma-closed-beta-repository.js';

type Phase = 'CLEARED' | 'VERIFIED';
type CheckpointPhase = 'ISOLATED' | Phase;
type Queryable = Readonly<{
  $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T>;
}>;
type ExecutionDatabase = D05Database &
  Readonly<{
    $transaction<T>(
      operation: (transaction: Queryable) => Promise<T>,
      options?: Readonly<{ isolationLevel: 'Serializable'; timeout: number }>,
    ): Promise<T>;
  }>;
type MarkerRow = Readonly<{ environment: string; fixtureNonceHash: string }>;
type IdRow = Readonly<{ id: string }>;

export const D05_CLEAR_SEQUENCE = Object.freeze([
  'Payment',
  'TaxLine',
  'Tip',
  'OrderItem',
  'MenuSelection',
  'Order:TOMBSTONE',
  'InventoryStock:TOMBSTONE',
  'Employee:TOMBSTONE',
  'CompetitiveSave:TOMBSTONE',
] as const);

export type WipeExecutionLeaseView = Readonly<{
  leaseId: string;
  batchId: string;
  phase: Phase;
  attempt: number;
  leaseToken: string;
  expiresAt: string;
  authorityHash: string;
}>;

export class WipeExecutionLeaseService {
  constructor(
    private readonly jwtVerifier: JwtVerifier,
    private readonly repository: PrismaWipeExecutionRepository,
    private readonly expectedEnvironment: string,
    private readonly fixtureNonce: string,
  ) {}

  isDurable() {
    return true;
  }

  async request(
    token: string,
    restaurantId: string,
    batchId: string,
    phase: Phase,
    envelope: unknown,
  ) {
    const actor = await this.authenticate(token);
    const command = parseCommandEnvelope(envelope);
    if (command.commandType !== `WIPE_REQUEST_${phase}` || command.aggregateId !== batchId) {
      throw new CommandError(422, 'COMMAND_SCOPE_MISMATCH');
    }
    if (Object.keys(command.payload).length !== 0) {
      throw new CommandError(422, 'WIPE_REQUEST_INVALID');
    }
    const lease = await this.repository.requestLease({
      actorPlayerId: actor.id,
      restaurantId,
      batchId,
      phase,
      expectedVersion: command.expectedVersion,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      requestFingerprint: hashCommandRequest(command, {
        actorId: actor.id,
        tenantId: restaurantId,
        saveId: batchId,
      }),
      expectedEnvironment: bounded(this.expectedEnvironment),
      fixtureNonceHash: sha256(bounded(this.fixtureNonce)),
    });
    return Object.freeze({
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      commandType: command.commandType,
      aggregateId: command.aggregateId,
      aggregateVersion: command.expectedVersion + 1,
      result: lease,
    });
  }

  private async authenticate(token: string): Promise<PlayerRecord> {
    try {
      const identity = await this.jwtVerifier.verify(bounded(token, 16_384));
      const player = await this.repository.findPlayerByClerkSubject(identity.subject);
      if (!player) throw new CommandError(403, 'WIPE_SCOPE_FORBIDDEN');
      return player;
    } catch (error) {
      if (error instanceof JwtVerificationError) {
        throw new CommandError(401, 'WIPE_AUTHENTICATION_REQUIRED');
      }
      throw error;
    }
  }
}

type LeaseRequest = Readonly<{
  actorPlayerId: string;
  restaurantId: string;
  batchId: string;
  phase: Phase;
  expectedVersion: number;
  commandId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  expectedEnvironment: string;
  fixtureNonceHash: string;
}>;

export class PrismaWipeExecutionRepository {
  constructor(private readonly database: ExecutionDatabase) {}

  async findPlayerByClerkSubject(subject: string): Promise<PlayerRecord | undefined> {
    const rows = await this.database.$queryRawUnsafe<readonly PlayerRecord[]>(
      'SELECT "id", "clerkUserId" FROM "Player" WHERE "clerkUserId" = $1 LIMIT 1',
      subject,
    );
    return rows[0];
  }

  requestLease(input: LeaseRequest): Promise<WipeExecutionLeaseView> {
    return this.database.$transaction(
      async (transaction) => {
        const authority = await executionAuthority(
          transaction,
          input.batchId,
          input.restaurantId,
          input.expectedEnvironment,
          input.fixtureNonceHash,
        );
        await activeOwner(transaction, input.actorPlayerId, input.restaurantId);
        const version = await aggregateVersion(transaction, input.batchId, authority.approved);
        if (version !== input.expectedVersion) {
          throw new CommandError(409, 'EXPECTED_VERSION_CONFLICT', {
            actualVersion: version,
            expectedVersion: input.expectedVersion,
          });
        }
        const actorScope = `${input.restaurantId}:${input.actorPlayerId}:WipeExecutionLease`;
        const existing = await transaction.$queryRawUnsafe<
          readonly {
            requestFingerprint: string;
            responseSnapshot: unknown;
            status: string;
          }[]
        >(
          `SELECT "requestFingerprint", "responseSnapshot", "status" FROM "IdempotencyRecord"
         WHERE "actorScope" = $1 AND "idempotencyKey" = $2 FOR UPDATE`,
          actorScope,
          input.idempotencyKey,
        );
        if (existing[0]) {
          if (existing[0].requestFingerprint !== input.requestFingerprint) {
            throw new CommandError(409, 'IDEMPOTENCY_KEY_REUSED');
          }
          if (existing[0].status !== 'COMPLETED' || !existing[0].responseSnapshot) {
            throw new CommandError(409, 'COMMAND_IN_PROGRESS');
          }
          return existing[0].responseSnapshot as WipeExecutionLeaseView;
        }
        await expireClaimedLease(transaction, input.batchId, input.phase);
        const attempt = await expectedLeaseAttempt(transaction, input.batchId, input.phase);
        const leaseId = randomUUID();
        const leaseToken = randomBytes(32).toString('hex');
        const leaseTokenHash = sha256(leaseToken);
        const authorityHash = sha256(
          canonicalJson({
            batchId: input.batchId,
            restaurantId: input.restaurantId,
            phase: input.phase,
            attempt,
            scopeHash: authority.scopeHash,
            policyHash: authority.policyHash,
            manifestHash: authority.manifestHash,
            environment: input.expectedEnvironment,
            fixtureNonceHash: input.fixtureNonceHash,
          }),
        );
        const inserted = await transaction.$queryRawUnsafe<readonly { expiresAt: Date }[]>(
          `INSERT INTO "WipeExecutionLease" (
          "id", "wipeBatchId", "restaurantId", "phase", "attempt", "requestedByPlayerId",
          "executorEnvironment", "scopeEnvironment", "databaseFixtureNonceHash",
          "authorityHash", "leaseTokenHash", "claimedAt", "expiresAt"
        ) VALUES ($1,$2,$3,$4::"WipeLifecyclePhase",$5,$6,$7,$7,$8,$9,$10,
          CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + INTERVAL '10 minutes') RETURNING "expiresAt"`,
          leaseId,
          input.batchId,
          input.restaurantId,
          input.phase,
          attempt,
          input.actorPlayerId,
          input.expectedEnvironment,
          input.fixtureNonceHash,
          authorityHash,
          leaseTokenHash,
        );
        const result = Object.freeze({
          leaseId,
          batchId: input.batchId,
          phase: input.phase,
          attempt,
          leaseToken,
          expiresAt: inserted[0]!.expiresAt.toISOString(),
          authorityHash,
        });
        await transaction.$queryRawUnsafe(
          `INSERT INTO "IdempotencyRecord" (
          "id", "restaurantId", "playerId", "actorScope", "idempotencyKey", "requestFingerprint",
          "status", "aggregateType", "aggregateId", "responseSnapshot", "createdAt", "terminalAt", "expiresAt"
        ) VALUES ($1,$2,$3,$4,$5,$6,'COMPLETED','WipeExecutionLease',$7,$8::jsonb,
          CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + INTERVAL '30 days')`,
          input.commandId,
          input.restaurantId,
          input.actorPlayerId,
          actorScope,
          input.idempotencyKey,
          input.requestFingerprint,
          input.batchId,
          JSON.stringify(result),
        );
        return result;
      },
      { isolationLevel: 'Serializable', timeout: 60_000 },
    );
  }
}

type Authority = Readonly<{
  scopeHash: string;
  policyHash: string;
  manifestHash: string;
  approved: boolean;
}>;

type WipeCheckpointRow = Readonly<{
  phase: CheckpointPhase;
  attempt: number;
  outcome: 'SUCCEEDED' | 'FAILED';
}>;

async function executionAuthority(
  database: Queryable,
  batchId: string,
  restaurantId: string,
  environment: string,
  fixtureNonceHash: string,
): Promise<Authority> {
  const rows = await database.$queryRawUnsafe<
    readonly (Authority & { scopeEnvironment: string })[]
  >(
    `SELECT "scopeHash", "policyHash", "dryRunManifestHash" AS "manifestHash",
       "approvedByPlayerId" IS NOT NULL AS "approved", "scope"->>'environment' AS "scopeEnvironment"
     FROM "WipeBatch" WHERE "id" = $1 AND "restaurantId" = $2 FOR UPDATE`,
    batchId,
    restaurantId,
  );
  const markers = await database.$queryRawUnsafe<readonly MarkerRow[]>(
    `SELECT "environment", "fixtureNonceHash" FROM "WipeExecutionFixtureMarker"
     WHERE "singletonKey" = 'D05_DISPOSABLE_FIXTURE' FOR SHARE`,
  );
  const row = rows[0];
  const marker = markers[0];
  if (
    !row ||
    row.scopeEnvironment !== environment ||
    marker?.environment !== environment ||
    marker.fixtureNonceHash !== fixtureNonceHash
  ) {
    throw new CommandError(409, 'WIPE_EXECUTION_ENVIRONMENT_MISMATCH');
  }
  return row;
}

async function expectedLeaseAttempt(database: Queryable, batchId: string, phase: Phase) {
  const rows = await database.$queryRawUnsafe<readonly WipeCheckpointRow[]>(
    `SELECT "phase", "attempt", "outcome" FROM "WipeBatchCheckpoint"
     WHERE "wipeBatchId" = $1 ORDER BY "sequence" DESC LIMIT 1 FOR SHARE`,
    batchId,
  );
  const latest = rows[0];
  if (!latest) throw new CommandError(409, 'WIPE_STATE_CONFLICT');
  if (latest.phase !== 'ISOLATED' && latest.phase === phase && latest.outcome === 'FAILED')
    return latest.attempt + 1;
  if (
    (latest.phase === 'ISOLATED' && phase === 'CLEARED' && latest.outcome === 'SUCCEEDED') ||
    (phase === 'VERIFIED' && latest.phase === 'CLEARED' && latest.outcome === 'SUCCEEDED')
  )
    return 1;
  throw new CommandError(409, 'WIPE_NOT_RESUMABLE');
}

async function expireClaimedLease(database: Queryable, batchId: string, phase: Phase) {
  const rows = await database.$queryRawUnsafe<
    readonly {
      id: string;
      attempt: number;
      requestedByPlayerId: string;
      manifestHash: string;
      authorityHash: string;
    }[]
  >(
    `SELECT lease."id", lease."attempt", lease."requestedByPlayerId",
       batch."dryRunManifestHash" AS "manifestHash", lease."authorityHash"
     FROM "WipeExecutionLease" lease JOIN "WipeBatch" batch ON batch."id" = lease."wipeBatchId"
     WHERE lease."wipeBatchId" = $1 AND lease."phase" = $2::"WipeLifecyclePhase"
       AND lease."status" = 'CLAIMED' AND lease."expiresAt" <= CURRENT_TIMESTAMP
     FOR UPDATE OF lease, batch`,
    batchId,
    phase,
  );
  const expired = rows[0];
  if (!expired) return;
  const sequence = await nextCheckpointSequence(database, batchId);
  const evidence = { version: 'd05-lease-expiry/v1', authorityHash: expired.authorityHash };
  await database.$queryRawUnsafe(
    `INSERT INTO "WipeBatchCheckpoint" (
      "id", "wipeBatchId", "sequence", "phase", "attempt", "outcome", "actorPlayerId",
      "manifestHash", "evidence", "evidenceHash", "errorCode", "errorDetails", "occurredAt"
    ) VALUES ($1,$2,$3,$4::"WipeLifecyclePhase",$5,'FAILED',$6,$7,$8::jsonb,$9,
      'LEASE_EXPIRED_MANUAL_RESUME_REQUIRED',$10::jsonb,CURRENT_TIMESTAMP)`,
    randomUUID(),
    batchId,
    sequence,
    phase,
    expired.attempt,
    expired.requestedByPlayerId,
    expired.manifestHash,
    JSON.stringify(evidence),
    sha256(canonicalJson(evidence)),
    JSON.stringify({ manualResumeRequired: true }),
  );
  await database.$queryRawUnsafe(
    `UPDATE "WipeExecutionLease" SET "status" = 'EXPIRED', "completedAt" = CURRENT_TIMESTAMP,
       "errorCode" = 'LEASE_EXPIRED_MANUAL_RESUME_REQUIRED' WHERE "id" = $1`,
    expired.id,
  );
}

async function aggregateVersion(database: Queryable, batchId: string, approved: boolean) {
  const rows = await database.$queryRawUnsafe<readonly { sequence: bigint | number }[]>(
    `SELECT COALESCE(MAX("sequence"), 0) AS "sequence" FROM "WipeBatchCheckpoint"
     WHERE "wipeBatchId" = $1`,
    batchId,
  );
  return 1 + (approved ? 1 : 0) + Number(rows[0]?.sequence ?? 0);
}

async function activeOwner(database: Queryable, playerId: string, restaurantId: string) {
  const rows = await database.$queryRawUnsafe<readonly IdRow[]>(
    `SELECT "id" FROM "RestaurantMembership" WHERE "playerId" = $1 AND "restaurantId" = $2
       AND "role" = 'OWNER' AND "revokedAt" IS NULL FOR SHARE`,
    playerId,
    restaurantId,
  );
  if (!rows[0]) throw new CommandError(403, 'WIPE_SCOPE_FORBIDDEN');
}

function bounded(value: string, maximum = 100) {
  if (!value || value.length > maximum || value.includes('\0')) {
    throw new CommandError(422, 'WIPE_REQUEST_INVALID');
  }
  return value;
}

async function nextCheckpointSequence(database: Queryable, batchId: string) {
  const rows = await database.$queryRawUnsafe<readonly { sequence: bigint | number }[]>(
    `SELECT COALESCE(MAX("sequence"), 0) + 1 AS "sequence" FROM "WipeBatchCheckpoint"
     WHERE "wipeBatchId" = $1`,
    batchId,
  );
  return Number(rows[0]?.sequence ?? 1);
}
