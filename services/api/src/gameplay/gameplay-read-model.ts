import type { FastifyInstance } from 'fastify';

import { isMembershipRole, type MembershipRole } from '../auth/authorization.js';
import type {
  TrustedPlayerIdentity,
  TrustedPlayerIdentityResolver,
} from '../auth/trusted-command-context.js';
import { CommandError, isCommandError } from '../commands/command-contract.js';
import type { D03Database, D03Queryable } from '../domains/ledger/postgres-ledger-store.js';
import { INITIALIZE_COMPETITIVE_SAVE_ROUTE } from './initialize-competitive-save-routes.js';

export const ACTIVE_GAMEPLAY_SAVE_ROUTE = '/gameplay/active-save' as const;
export const GAMEPLAY_PROJECTION_ROUTE = '/saves/:saveId/gameplay' as const;
export const GAMEPLAY_LATEST_REPLAY_JOB_ROUTE =
  '/saves/:saveId/replay-jobs/latest' as const;
export const GAMEPLAY_REPLAY_JOB_ROUTE = '/saves/:saveId/replay-jobs/:jobId' as const;
export const GAMEPLAY_ACTIVE_SAVE_PROJECTION_VERSION =
  'gameplay.active-save-discovery/v1' as const;
export const GAMEPLAY_CURRENT_PROJECTION_VERSION = 'gameplay.current-projection/v1' as const;
export const GAMEPLAY_REPLAY_JOB_PROJECTION_VERSION = 'gameplay.replay-job/v1' as const;

export type GameplayPhase =
  | 'CONFIGURE_REQUIRED'
  | 'OPEN_REQUIRED'
  | 'ADVANCE_REQUIRED'
  | 'SETTLE_REQUIRED'
  | 'REPLAY_AVAILABLE';

type GameplayReadScope = Readonly<{
  membershipId: string;
  tenantId: string;
  saveId: string;
  role: MembershipRole;
}>;

export type SafeGameplayProjection = Readonly<{
  schemaVersion: typeof GAMEPLAY_CURRENT_PROJECTION_VERSION;
  save: Readonly<{
    id: string;
    aggregateVersion: number;
    openingScenario: string;
    operatingMode: string;
    servicePeriodPlan: 'TWO_PERIODS' | 'THREE_PERIODS';
    difficultyGroup: string;
    simulationRuleVersion: string;
  }>;
  phase: GameplayPhase;
  nextCommand:
    | 'CONFIGURE_PREOPEN_DAY'
    | 'OPEN_BUSINESS_DAY'
    | 'ADVANCE_SERVICE_PERIOD'
    | 'SETTLE_BUSINESS_DAY'
    | 'REQUEST_DAY_REPLAY';
  expectedVersion: number;
  preopenSnapshot?: Readonly<{
    id: string;
    hash: string;
  }>;
  businessDay: null | Readonly<{
    businessDay: 1;
    status: 'PREOPEN' | 'OPEN' | 'SERVICE_COMPLETE' | 'SETTLED';
    simulationRuleVersion: string;
    completedServicePeriods: number;
    totalServicePeriods: 2 | 3;
    nextPeriodKey: 'LUNCH' | 'OFF_PEAK' | 'DINNER' | null;
  }>;
  dayEnd: null | Readonly<{
    businessDay: 1;
    dayEndSnapshotId: string;
    eventHash: string;
    snapshotHash: string;
  }>;
}>;

export type ScopedGameplayProjection = Readonly<{
  scope: GameplayReadScope;
  projection: SafeGameplayProjection;
}>;

export type ActiveSaveDiscovery = Readonly<{
  bootstrapVersion: number;
  active: ScopedGameplayProjection | undefined;
}>;

export type SafeReplayJobProjection = Readonly<{
  scope: GameplayReadScope;
  httpStatus: 200 | 202;
  projection: Readonly<{
    schemaVersion: typeof GAMEPLAY_REPLAY_JOB_PROJECTION_VERSION;
    jobId: string;
    saveId: string;
    businessDay: number;
    status:
      | 'QUEUED'
      | 'RUNNING'
      | 'RETRYING'
      | 'MATCH'
      | 'MISMATCH'
      | 'PERMANENT_FAILURE'
      | 'RETRY_EXHAUSTED';
    terminal: boolean;
    verification?: Readonly<{
      eventCount: number;
      eventHash: Readonly<{ expected: string; computed: string; match: boolean }>;
      snapshotHash: Readonly<{ expected: string; computed: string; match: boolean }>;
    }>;
    failure?: Readonly<{
      retryable: false;
      category: 'PERMANENT' | 'RETRY_EXHAUSTED';
    }>;
  }>;
}>;

export interface GameplayReadModelRepository {
  discoverActiveSave(playerId: string): Promise<ActiveSaveDiscovery>;
  loadCurrentProjection(playerId: string, saveId: string): Promise<ScopedGameplayProjection | undefined>;
  loadReplayJob(
    playerId: string,
    saveId: string,
    jobId: string,
  ): Promise<SafeReplayJobProjection | undefined>;
  loadLatestReplayJob(
    playerId: string,
    saveId: string,
    businessDay: 1,
  ): Promise<SafeReplayJobProjection | undefined>;
}

type SaveRow = Readonly<{
  id: string;
  restaurantId: string;
  membershipId: string;
  role: string;
  version: number;
  openingScenario: string;
  operatingMode: string;
  servicePeriodPlan: string;
  difficultyGroup: string;
  simulationRuleVersion: string;
}>;

type BusinessDayRow = Readonly<{
  businessDay: number;
  status: string;
  simulationRuleVersion: string;
}>;

type ExecutionCountRow = Readonly<{ completedCount: number | bigint | string }>;
type BootstrapVersionRow = Readonly<{ version: number }>;
type DayEndRow = Readonly<{
  id: string;
  businessDay: number;
  eventHash: string;
  snapshotHash: string;
}>;
type PreopenSnapshotPinRow = Readonly<{
  id: string;
  snapshotHash: string;
}>;

type ReplayJobRow = Readonly<{
  id: string;
  status: string;
  errorClass: string | null;
  businessDay: number | null;
  resultPayload: unknown;
}>;

type LatestReplayJobRow = ReplayJobRow & Readonly<{
  businessKey: string;
  inputPayload: unknown;
  sourceEventType: string;
  sourceEventVersion: number;
  sourcePayload: unknown;
  replayExecutionId: string | null;
  replayKind: string | null;
  replayBusinessDay: number | null;
}>;

type DayReplayLocatorIdentity = Readonly<{
  dayEndSnapshotId: string;
  eventHash: string;
  snapshotHash: string;
}>;

const saveIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const statuses = new Set(['PREOPEN', 'OPEN', 'SERVICE_COMPLETE', 'SETTLED']);
const periods = Object.freeze({
  TWO_PERIODS: Object.freeze(['LUNCH', 'DINNER'] as const),
  THREE_PERIODS: Object.freeze(['LUNCH', 'OFF_PEAK', 'DINNER'] as const),
});

/** Durable, read-only projection over the same rows used by the command path. */
export class PrismaGameplayReadModelRepository implements GameplayReadModelRepository {
  constructor(private readonly database: D03Database) {}

  async discoverActiveSave(playerId: string): Promise<ActiveSaveDiscovery> {
    return this.database.$transaction(async (transaction) => {
      const bootstrapRows = await transaction.$queryRawUnsafe<readonly BootstrapVersionRow[]>(
        `/* gameplay-read:bootstrap-version */
         SELECT state."version"
         FROM "BootstrapPlayerCommandState" state
         WHERE state."playerId" = $1`,
        playerId,
      );
      if (bootstrapRows.length > 1) throw projectionUnavailable();
      const bootstrapVersion = bootstrapRows[0]?.version ?? 0;
      if (!isNonNegativeSafeInteger(bootstrapVersion)) throw projectionUnavailable();

      const saves = await loadScopedSaveRows(transaction, playerId);
      if (saves.length > 1) throw new CommandError(409, 'ACTIVE_SAVE_SELECTION_REQUIRED');
      const save = saves[0];
      return Object.freeze({
        bootstrapVersion,
        active: save ? await buildScopedProjection(transaction, save) : undefined,
      });
    });
  }

  async loadCurrentProjection(
    playerId: string,
    saveId: string,
  ): Promise<ScopedGameplayProjection | undefined> {
    return this.database.$transaction(async (transaction) => {
      const saves = await loadScopedSaveRows(transaction, playerId, saveId);
      if (saves.length !== 1 || !saves[0]) return undefined;
      return buildScopedProjection(transaction, saves[0]);
    });
  }

  async loadReplayJob(
    playerId: string,
    saveId: string,
    jobId: string,
  ): Promise<SafeReplayJobProjection | undefined> {
    return this.database.$transaction(async (transaction) => {
      const saves = await loadScopedSaveRows(transaction, playerId, saveId);
      const save = saves[0];
      if (saves.length !== 1 || !save) return undefined;
      const rows = await transaction.$queryRawUnsafe<readonly ReplayJobRow[]>(
        `/* gameplay-read:replay-job */
         SELECT job."id", job."status", job."errorClass",
                COALESCE(
                  replay."businessDay",
                  CASE
                    WHEN jsonb_typeof(job."inputPayload"->'businessDay') = 'number'
                    THEN (job."inputPayload"->>'businessDay')::integer
                    ELSE NULL
                  END
                ) AS "businessDay",
                replay."resultPayload"
         FROM "SimulationJob" job
         LEFT JOIN "VersionedReplayExecution" replay
           ON replay."restaurantId" = job."restaurantId"
          AND replay."jobId" = job."id"
          AND replay."saveId" = job."saveId"
          AND replay."replayKind" = 'DAY_REPLAY'
         WHERE job."restaurantId" = $1
           AND job."saveId" = $2
           AND job."id" = $3
           AND job."jobKind" = 'VERSIONED_REPLAY'`,
        save.restaurantId,
        save.id,
        jobId,
      );
      if (rows.length !== 1 || !rows[0]) return undefined;
      return projectReplayJob(scopeFromSave(save), save.id, rows[0]);
    });
  }

  async loadLatestReplayJob(
    playerId: string,
    saveId: string,
    businessDay: 1,
  ): Promise<SafeReplayJobProjection | undefined> {
    return this.database.$transaction(async (transaction) => {
      const saves = await loadScopedSaveRows(transaction, playerId, saveId);
      const save = saves[0];
      if (saves.length !== 1 || !save) return undefined;
      const businessKey = `${save.id}:${businessDay}:DAY_REPLAY`;
      const rows = await transaction.$queryRawUnsafe<readonly LatestReplayJobRow[]>(
        `/* gameplay-read:latest-replay-job */
         SELECT job."id", job."status", job."errorClass", job."businessKey",
                job."inputPayload",
                CASE
                  WHEN jsonb_typeof(job."inputPayload"->'businessDay') = 'number'
                  THEN (job."inputPayload"->>'businessDay')::integer
                  ELSE NULL
                END AS "businessDay",
                source."eventType" AS "sourceEventType",
                source."eventVersion" AS "sourceEventVersion",
                source."payload" AS "sourcePayload",
                replay."id" AS "replayExecutionId",
                replay."replayKind",
                replay."businessDay" AS "replayBusinessDay",
                replay."resultPayload"
         FROM "SimulationJob" job
         JOIN "OutboxEvent" source
           ON source."restaurantId" = job."restaurantId"
          AND source."saveId" = job."saveId"
          AND source."id" = job."sourceEventId"
         LEFT JOIN "VersionedReplayExecution" replay
           ON replay."restaurantId" = job."restaurantId"
          AND replay."jobId" = job."id"
          AND replay."saveId" = job."saveId"
         WHERE job."restaurantId" = $1
           AND job."saveId" = $2
           AND job."jobKind" = 'VERSIONED_REPLAY'
           AND job."businessKey" = $3
         ORDER BY job."createdAt" DESC, job."id" ASC
         LIMIT 2`,
        save.restaurantId,
        save.id,
        businessKey,
      );
      if (rows.length > 1) {
        throw new CommandError(409, 'DAY_REPLAY_JOB_SELECTION_REQUIRED');
      }
      const row = rows[0];
      if (!row) return undefined;
      validateLatestReplayJobAuthority(row, save.id, businessDay, businessKey);
      return projectReplayJob(scopeFromSave(save), save.id, row);
    });
  }
}

export function registerGameplayReadModelRoutes(
  app: FastifyInstance,
  options: Readonly<{
    resolveIdentity: TrustedPlayerIdentityResolver;
    repository?: GameplayReadModelRepository;
    assertScopeAllowed?: (playerId: string, tenantId: string) => Promise<void>;
  }>,
): void {
  app.get(ACTIVE_GAMEPLAY_SAVE_ROUTE, async (request, reply) => {
    try {
      const identity = await options.resolveIdentity(request);
      const repository = requiredRepository(options.repository);
      const discovery = await repository.discoverActiveSave(identity.playerId);
      if (!discovery.active) {
        if (identity.principal.type === 'discord_bot') {
          throw new CommandError(403, 'GAMEPLAY_SCOPE_FORBIDDEN');
        }
        return reply.status(200).send({
          schemaVersion: GAMEPLAY_ACTIVE_SAVE_PROJECTION_VERSION,
          state: 'INITIALIZE_REQUIRED',
          bootstrap: {
            route: INITIALIZE_COMPETITIVE_SAVE_ROUTE,
            aggregateId: `bootstrap-player:${identity.playerId}`,
            expectedVersion: discovery.bootstrapVersion,
          },
          activeSave: null,
        });
      }
      await options.assertScopeAllowed?.(identity.playerId, discovery.active.scope.tenantId);
      await auditRead(identity, discovery.active.scope, 'READ_ACTIVE_GAMEPLAY_SAVE');
      return reply.status(200).send({
        schemaVersion: GAMEPLAY_ACTIVE_SAVE_PROJECTION_VERSION,
        state: 'ACTIVE_SAVE',
        bootstrap: null,
        activeSave: discovery.active.projection,
      });
    } catch (error) {
      return sendReadError(error, reply);
    }
  });

  app.get<{ Params: { saveId: string } }>(GAMEPLAY_PROJECTION_ROUTE, async (request, reply) => {
    try {
      const identity = await options.resolveIdentity(request);
      const saveId = parseSaveId(request.params.saveId);
      const projection = await requiredRepository(options.repository).loadCurrentProjection(
        identity.playerId,
        saveId,
      );
      if (!projection) throw resourceNotFound();
      await options.assertScopeAllowed?.(identity.playerId, projection.scope.tenantId);
      await auditRead(identity, projection.scope, 'READ_GAMEPLAY_PROJECTION');
      return reply.status(200).send(projection.projection);
    } catch (error) {
      return sendReadError(error, reply);
    }
  });

  app.get<{ Params: { saveId: string }; Querystring: { businessDay?: unknown } }>(
    GAMEPLAY_LATEST_REPLAY_JOB_ROUTE,
    async (request, reply) => {
      try {
        const identity = await options.resolveIdentity(request);
        const saveId = parseSaveId(request.params.saveId);
        const businessDay = parseLatestReplayQuery(request.query);
        const result = await requiredRepository(options.repository).loadLatestReplayJob(
          identity.playerId,
          saveId,
          businessDay,
        );
        if (!result) throw resourceNotFound();
        await options.assertScopeAllowed?.(identity.playerId, result.scope.tenantId);
        await auditRead(identity, result.scope, 'READ_LATEST_DAY_REPLAY_JOB');
        return reply.status(result.httpStatus).send(result.projection);
      } catch (error) {
        return sendReadError(error, reply);
      }
    },
  );

  app.get<{ Params: { saveId: string; jobId: string } }>(
    GAMEPLAY_REPLAY_JOB_ROUTE,
    async (request, reply) => {
      try {
        const identity = await options.resolveIdentity(request);
        const saveId = parseSaveId(request.params.saveId);
        const jobId = parseJobId(request.params.jobId);
        const result = await requiredRepository(options.repository).loadReplayJob(
          identity.playerId,
          saveId,
          jobId,
        );
        if (!result) throw resourceNotFound();
        await options.assertScopeAllowed?.(identity.playerId, result.scope.tenantId);
        await auditRead(identity, result.scope, 'READ_DAY_REPLAY_JOB');
        return reply.status(result.httpStatus).send(result.projection);
      } catch (error) {
        return sendReadError(error, reply);
      }
    },
  );
}

async function loadScopedSaveRows(
  transaction: D03Queryable,
  playerId: string,
  saveId?: string,
): Promise<readonly SaveRow[]> {
  return transaction.$queryRawUnsafe<readonly SaveRow[]>(
    `/* gameplay-read:scoped-save */
     SELECT save."id", save."restaurantId", membership."id" AS "membershipId",
            membership."role"::text AS "role", save."version",
            save."openingScenario", save."operatingMode", save."servicePeriodPlan",
            save."difficultyGroup", save."simulationRuleVersion"
     FROM "CompetitiveSave" save
     JOIN "RestaurantMembership" membership
       ON membership."restaurantId" = save."restaurantId"
      AND membership."playerId" = $1
      AND membership."revokedAt" IS NULL
     WHERE save."retiredAt" IS NULL
       AND ($2::text IS NULL OR save."id" = $2)
     ORDER BY save."updatedAt" DESC, save."id" ASC
     LIMIT 2`,
    playerId,
    saveId ?? null,
  );
}

async function buildScopedProjection(
  transaction: D03Queryable,
  save: SaveRow,
): Promise<ScopedGameplayProjection> {
  validateSaveRow(save);
  const dayRows = await transaction.$queryRawUnsafe<readonly BusinessDayRow[]>(
    `/* gameplay-read:business-day */
     SELECT day."businessDay", day."status"::text AS "status", day."simulationRuleVersion"
     FROM "BusinessDay" day
     WHERE day."restaurantId" = $1
       AND day."saveId" = $2
       AND day."businessDay" = 1`,
    save.restaurantId,
    save.id,
  );
  if (dayRows.length > 1) throw projectionUnavailable();
  const day = dayRows[0];
  const periodKeys = periods[save.servicePeriodPlan as keyof typeof periods];
  if (!periodKeys) throw projectionUnavailable();

  let completedServicePeriods = 0;
  let dayEnd: SafeGameplayProjection['dayEnd'] = null;
  if (day) {
    const countRows = await transaction.$queryRawUnsafe<readonly ExecutionCountRow[]>(
      `/* gameplay-read:service-period-count */
       SELECT COUNT(*) AS "completedCount"
       FROM "ServicePeriodExecution" execution
       WHERE execution."restaurantId" = $1
         AND execution."saveId" = $2
         AND execution."businessDay" = 1`,
      save.restaurantId,
      save.id,
    );
    completedServicePeriods = parseCount(countRows[0]?.completedCount);
    if (completedServicePeriods > periodKeys.length) throw projectionUnavailable();
    if (day.status === 'SETTLED') {
      const snapshotRows = await transaction.$queryRawUnsafe<readonly DayEndRow[]>(
        `/* gameplay-read:day-end */
         SELECT snapshot."id", snapshot."businessDay", snapshot."eventHash", snapshot."snapshotHash"
         FROM "DayEndSnapshot" snapshot
         WHERE snapshot."restaurantId" = $1
           AND snapshot."saveId" = $2
           AND snapshot."businessDay" = 1`,
        save.restaurantId,
        save.id,
      );
      const snapshot = snapshotRows[0];
      if (
        snapshotRows.length !== 1 ||
        !snapshot ||
        snapshot.businessDay !== 1 ||
        !isBoundedString(snapshot.id, 200) ||
        !sha256Pattern.test(snapshot.eventHash) ||
        !sha256Pattern.test(snapshot.snapshotHash)
      ) {
        throw projectionUnavailable();
      }
      dayEnd = Object.freeze({
        businessDay: 1,
        dayEndSnapshotId: snapshot.id,
        eventHash: snapshot.eventHash,
        snapshotHash: snapshot.snapshotHash,
      });
    }
  }

  if (day && day.simulationRuleVersion !== save.simulationRuleVersion) {
    throw projectionUnavailable();
  }
  const phase = derivePhase(day, completedServicePeriods, periodKeys.length);
  const nextCommand = commandForPhase(phase);
  let preopenSnapshot: SafeGameplayProjection['preopenSnapshot'];
  if (phase === 'OPEN_REQUIRED') {
    const snapshotRows = await transaction.$queryRawUnsafe<readonly PreopenSnapshotPinRow[]>(
      `/* gameplay-read:preopen-snapshot-pin */
       SELECT snapshot."id", snapshot."snapshotHash"
       FROM "PreopenDaySnapshot" snapshot
       WHERE snapshot."restaurantId" = $1
         AND snapshot."saveId" = $2
         AND snapshot."businessDay" = 1
         AND snapshot."revision" = 1`,
      save.restaurantId,
      save.id,
    );
    const snapshot = snapshotRows[0];
    if (
      snapshotRows.length !== 1 ||
      !snapshot ||
      !isBoundedString(snapshot.id, 200) ||
      !sha256Pattern.test(snapshot.snapshotHash)
    ) {
      throw projectionUnavailable();
    }
    preopenSnapshot = Object.freeze({ id: snapshot.id, hash: snapshot.snapshotHash });
  }
  const nextPeriodKey =
    day?.status === 'OPEN' ? (periodKeys[completedServicePeriods] ?? null) : null;
  const projection: SafeGameplayProjection = Object.freeze({
    schemaVersion: GAMEPLAY_CURRENT_PROJECTION_VERSION,
    save: Object.freeze({
      id: save.id,
      aggregateVersion: save.version,
      openingScenario: save.openingScenario,
      operatingMode: save.operatingMode,
      servicePeriodPlan: save.servicePeriodPlan as 'TWO_PERIODS' | 'THREE_PERIODS',
      difficultyGroup: save.difficultyGroup,
      simulationRuleVersion: save.simulationRuleVersion,
    }),
    phase,
    nextCommand,
    expectedVersion: save.version,
    ...(preopenSnapshot === undefined ? {} : { preopenSnapshot }),
    businessDay: day
      ? Object.freeze({
          businessDay: 1,
          status: day.status as 'PREOPEN' | 'OPEN' | 'SERVICE_COMPLETE' | 'SETTLED',
          simulationRuleVersion: day.simulationRuleVersion,
          completedServicePeriods,
          totalServicePeriods: periodKeys.length as 2 | 3,
          nextPeriodKey,
        })
      : null,
    dayEnd,
  });
  return Object.freeze({ scope: scopeFromSave(save), projection });
}

function projectReplayJob(
  scope: GameplayReadScope,
  saveId: string,
  row: ReplayJobRow,
): SafeReplayJobProjection {
  if (!uuidPattern.test(row.id)) throw projectionUnavailable();
  if (row.status === 'PENDING') {
    if (row.errorClass === null) return pendingReplay(scope, saveId, row, 'QUEUED');
    if (row.errorClass === 'TRANSIENT') return pendingReplay(scope, saveId, row, 'RETRYING');
    throw projectionUnavailable();
  }
  if (row.status === 'RUNNING') {
    if (row.errorClass !== null && row.errorClass !== 'TRANSIENT') {
      throw projectionUnavailable();
    }
    return pendingReplay(scope, saveId, row, 'RUNNING');
  }
  if (row.status === 'FAILED' && row.errorClass === 'PERMANENT') {
    return failedReplay(scope, saveId, row, 'PERMANENT');
  }
  if (row.status === 'DEAD_LETTER' && row.errorClass === 'TRANSIENT') {
    return failedReplay(scope, saveId, row, 'RETRY_EXHAUSTED');
  }
  if (row.status !== 'SUCCEEDED' || row.errorClass !== null) throw projectionUnavailable();
  const verification = parseVerification(row.resultPayload, validBusinessDay(row.businessDay));
  return Object.freeze({
    scope,
    httpStatus: 200,
    projection: Object.freeze({
      schemaVersion: GAMEPLAY_REPLAY_JOB_PROJECTION_VERSION,
      jobId: row.id,
      saveId,
      businessDay: validBusinessDay(row.businessDay),
      status: verification.status,
      terminal: true,
      verification: verification.summary,
    }),
  });
}

function failedReplay(
  scope: GameplayReadScope,
  saveId: string,
  row: ReplayJobRow,
  category: 'PERMANENT' | 'RETRY_EXHAUSTED',
): SafeReplayJobProjection {
  if (row.resultPayload !== null) throw projectionUnavailable();
  return Object.freeze({
    scope,
    httpStatus: 200,
    projection: Object.freeze({
      schemaVersion: GAMEPLAY_REPLAY_JOB_PROJECTION_VERSION,
      jobId: row.id,
      saveId,
      businessDay: validBusinessDay(row.businessDay),
      status: category === 'PERMANENT' ? 'PERMANENT_FAILURE' : 'RETRY_EXHAUSTED',
      terminal: true,
      failure: Object.freeze({ retryable: false, category }),
    }),
  });
}

function pendingReplay(
  scope: GameplayReadScope,
  saveId: string,
  row: ReplayJobRow,
  status: 'QUEUED' | 'RUNNING' | 'RETRYING',
): SafeReplayJobProjection {
  if (row.resultPayload !== null) throw projectionUnavailable();
  return Object.freeze({
    scope,
    httpStatus: 202,
    projection: Object.freeze({
      schemaVersion: GAMEPLAY_REPLAY_JOB_PROJECTION_VERSION,
      jobId: row.id,
      saveId,
      businessDay: validBusinessDay(row.businessDay),
      status,
      terminal: false,
    }),
  });
}

function parseVerification(
  value: unknown,
  businessDay: number,
): Readonly<{
  status: 'MATCH' | 'MISMATCH';
  summary: NonNullable<SafeReplayJobProjection['projection']['verification']>;
}> {
  const record = asRecord(value);
  const expected = asRecord(record?.expected);
  const computed = asRecord(record?.computed);
  if (
    record?.schemaVersion !== 'e05-day-replay-verification/v1' ||
    record.businessDay !== businessDay ||
    (record.status !== 'MATCH' && record.status !== 'MISMATCH') ||
    !isNonNegativeSafeInteger(record.eventCount) ||
    !sha256Pattern.test(String(expected?.eventHash ?? '')) ||
    !sha256Pattern.test(String(expected?.snapshotHash ?? '')) ||
    !sha256Pattern.test(String(computed?.eventHash ?? '')) ||
    !sha256Pattern.test(String(computed?.snapshotHash ?? ''))
  ) {
    throw projectionUnavailable();
  }
  const eventExpected = String(expected!.eventHash);
  const eventComputed = String(computed!.eventHash);
  const snapshotExpected = String(expected!.snapshotHash);
  const snapshotComputed = String(computed!.snapshotHash);
  const derivedStatus =
    eventExpected === eventComputed && snapshotExpected === snapshotComputed ? 'MATCH' : 'MISMATCH';
  if (record.status !== derivedStatus) throw projectionUnavailable();
  return Object.freeze({
    status: derivedStatus,
    summary: Object.freeze({
      eventCount: record.eventCount,
      eventHash: Object.freeze({
        expected: eventExpected,
        computed: eventComputed,
        match: eventExpected === eventComputed,
      }),
      snapshotHash: Object.freeze({
        expected: snapshotExpected,
        computed: snapshotComputed,
        match: snapshotExpected === snapshotComputed,
      }),
    }),
  });
}

function derivePhase(
  day: BusinessDayRow | undefined,
  completed: number,
  total: number,
): GameplayPhase {
  if (!day) {
    if (completed !== 0) throw projectionUnavailable();
    return 'CONFIGURE_REQUIRED';
  }
  if (
    day.businessDay !== 1 ||
    !statuses.has(day.status) ||
    !isBoundedString(day.simulationRuleVersion, 128)
  ) {
    throw projectionUnavailable();
  }
  if (day.status === 'PREOPEN' && completed === 0) return 'OPEN_REQUIRED';
  if (day.status === 'OPEN' && completed < total) return 'ADVANCE_REQUIRED';
  if (day.status === 'SERVICE_COMPLETE' && completed === total) return 'SETTLE_REQUIRED';
  if (day.status === 'SETTLED' && completed === total) return 'REPLAY_AVAILABLE';
  throw projectionUnavailable();
}

function commandForPhase(phase: GameplayPhase): SafeGameplayProjection['nextCommand'] {
  if (phase === 'CONFIGURE_REQUIRED') return 'CONFIGURE_PREOPEN_DAY';
  if (phase === 'OPEN_REQUIRED') return 'OPEN_BUSINESS_DAY';
  if (phase === 'ADVANCE_REQUIRED') return 'ADVANCE_SERVICE_PERIOD';
  if (phase === 'SETTLE_REQUIRED') return 'SETTLE_BUSINESS_DAY';
  return 'REQUEST_DAY_REPLAY';
}

function validateSaveRow(save: SaveRow): void {
  if (
    !isBoundedString(save.id, 200) ||
    !isBoundedString(save.restaurantId, 200) ||
    !isBoundedString(save.membershipId, 200) ||
    !isMembershipRole(save.role) ||
    !isNonNegativeSafeInteger(save.version) ||
    !isBoundedString(save.openingScenario, 100) ||
    !isBoundedString(save.operatingMode, 100) ||
    !Object.hasOwn(periods, save.servicePeriodPlan) ||
    !isBoundedString(save.difficultyGroup, 100) ||
    !isBoundedString(save.simulationRuleVersion, 128)
  ) {
    throw projectionUnavailable();
  }
}

function scopeFromSave(save: SaveRow): GameplayReadScope {
  if (!isMembershipRole(save.role)) throw projectionUnavailable();
  return Object.freeze({
    membershipId: save.membershipId,
    tenantId: save.restaurantId,
    saveId: save.id,
    role: save.role,
  });
}

async function auditRead(
  identity: TrustedPlayerIdentity,
  scope: GameplayReadScope,
  operation: string,
): Promise<void> {
  await identity.recordScopeResolution({ operation, ...scope });
}

function requiredRepository(
  repository: GameplayReadModelRepository | undefined,
): GameplayReadModelRepository {
  if (!repository) throw new CommandError(503, 'GAMEPLAY_READ_MODEL_NOT_CONFIGURED');
  return repository;
}

function parseSaveId(value: string): string {
  if (!saveIdPattern.test(value)) throw resourceNotFound();
  return value;
}

function parseJobId(value: string): string {
  if (!uuidPattern.test(value)) throw resourceNotFound();
  return value;
}

function parseLatestReplayQuery(value: Readonly<{ businessDay?: unknown }>): 1 {
  if (Object.keys(value).length !== 1 || value.businessDay !== '1') {
    throw resourceNotFound();
  }
  return 1;
}

function validateLatestReplayJobAuthority(
  row: LatestReplayJobRow,
  saveId: string,
  businessDay: 1,
  businessKey: string,
): void {
  const jobLocator = parseDayReplayInput(row.inputPayload, saveId, businessDay);
  const sourceLocator = parseDayReplaySource(
    row.sourcePayload,
    row.id,
    businessKey,
    saveId,
    businessDay,
  );
  if (
    row.businessKey !== businessKey ||
    row.businessDay !== businessDay ||
    row.sourceEventType !== 'simulation.versioned-replay.requested' ||
    row.sourceEventVersion !== 1 ||
    !jobLocator ||
    !sourceLocator ||
    !sameDayReplayLocator(jobLocator, sourceLocator)
  ) {
    throw projectionUnavailable();
  }

  if (row.status === 'SUCCEEDED') {
    if (
      row.replayExecutionId !== row.id ||
      row.replayKind !== 'DAY_REPLAY' ||
      row.replayBusinessDay !== businessDay
    ) {
      throw projectionUnavailable();
    }
    return;
  }
  if (
    row.replayExecutionId !== null ||
    row.replayKind !== null ||
    row.replayBusinessDay !== null ||
    row.resultPayload !== null
  ) {
    throw projectionUnavailable();
  }
}

function parseDayReplaySource(
  value: unknown,
  jobId: string,
  businessKey: string,
  saveId: string,
  businessDay: 1,
): DayReplayLocatorIdentity | undefined {
  const source = asRecord(value);
  if (
    !hasExactKeys(source, ['businessKey', 'jobId', 'jobKind', 'replay', 'schemaVersion']) ||
    source?.schemaVersion !== 'd03-versioned-replay-request/v1' ||
    source.jobId !== jobId ||
    source.jobKind !== 'VERSIONED_REPLAY' ||
    source.businessKey !== businessKey
  ) {
    return undefined;
  }
  return parseDayReplayInput(source.replay, saveId, businessDay);
}

function parseDayReplayInput(
  value: unknown,
  saveId: string,
  businessDay: 1,
): DayReplayLocatorIdentity | undefined {
  const replay = asRecord(value);
  const rule = asRecord(replay?.rule);
  const replayPayload = asRecord(replay?.replayPayload);
  const locator = asRecord(replayPayload?.locator);
  if (
    !hasExactKeys(replay, [
      'businessDay',
      'catalogs',
      'replayKind',
      'replayPayload',
      'rule',
      'schemaVersion',
    ]) ||
    replay?.schemaVersion !== 'd03-versioned-replay-job/v1' ||
    replay.replayKind !== 'DAY_REPLAY' ||
    replay.businessDay !== businessDay ||
    !Array.isArray(replay.catalogs) ||
    replay.catalogs.length !== 0 ||
    !hasExactKeys(rule, ['key', 'kind', 'version']) ||
    rule?.kind !== 'RULE' ||
    rule.key !== 'DAY_REPLAY_EVIDENCE' ||
    rule.version !== 'mvp-release-evidence-v1' ||
    !hasExactKeys(replayPayload, ['locator', 'schemaVersion']) ||
    replayPayload?.schemaVersion !== 'p0-day-replay-locator/v1' ||
    !hasExactKeys(locator, [
      'businessDay',
      'dayEndSnapshotId',
      'eventHash',
      'saveId',
      'snapshotHash',
    ]) ||
    locator?.businessDay !== businessDay ||
    locator.saveId !== saveId ||
    !isBoundedString(locator.dayEndSnapshotId, 200) ||
    !sha256Pattern.test(String(locator.eventHash ?? '')) ||
    !sha256Pattern.test(String(locator.snapshotHash ?? ''))
  ) {
    return undefined;
  }
  return Object.freeze({
    dayEndSnapshotId: locator.dayEndSnapshotId,
    eventHash: String(locator.eventHash),
    snapshotHash: String(locator.snapshotHash),
  });
}

function sameDayReplayLocator(
  left: DayReplayLocatorIdentity,
  right: DayReplayLocatorIdentity,
): boolean {
  return (
    left.dayEndSnapshotId === right.dayEndSnapshotId &&
    left.eventHash === right.eventHash &&
    left.snapshotHash === right.snapshotHash
  );
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>> | undefined,
  expected: readonly string[],
): boolean {
  if (!value) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function validBusinessDay(value: number | null): number {
  if (!isNonNegativeSafeInteger(value) || value < 1) throw projectionUnavailable();
  return value;
}

function parseCount(value: number | bigint | string | undefined): number {
  const parsed = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value;
  if (!isNonNegativeSafeInteger(parsed)) throw projectionUnavailable();
  return parsed;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function resourceNotFound(): CommandError {
  return new CommandError(404, 'GAMEPLAY_RESOURCE_NOT_FOUND');
}

function projectionUnavailable(): CommandError {
  return new CommandError(503, 'GAMEPLAY_PROJECTION_UNAVAILABLE');
}

function sendReadError(
  error: unknown,
  reply: Readonly<{ status(code: number): { send(body: unknown): unknown } }>,
): unknown {
  if (isCommandError(error)) return reply.status(error.status).send(error.toBody());
  throw error;
}
