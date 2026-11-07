import { createHash, randomUUID } from 'node:crypto';

import {
  assertJsonWithinResourceLimits,
  canonicalizeBoundedJson,
  JsonResourceLimitError,
} from './json-resource-limits.js';
import {
  DAY_REPLAY_EVIDENCE_PROCESSOR_ID,
  DAY_REPLAY_EVIDENCE_RULE_KEY,
  DAY_REPLAY_EVIDENCE_RULE_VERSION,
  DAY_REPLAY_LOCATOR_VERSION,
  DAY_REPLAY_RESULT_VERSION,
  DAY_REPLAY_RULE_PAYLOAD,
  hashDayReplayEvents,
  hashDayReplaySnapshot,
  isSha256,
  PostgresDayReplayEvidenceSource,
  unavailableDayReplaySource,
  type DayReplayEvidenceSource,
  type DayReplayLocator,
} from './day-replay-evidence.js';

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | Readonly<{ [key: string]: CanonicalJson }>;

export type JsonObject = Readonly<{ [key: string]: CanonicalJson }>;

export type SimulationQueryable = Readonly<{
  $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T>;
}>;

export type SimulationDatabase = Readonly<{
  $transaction<T>(operation: (transaction: SimulationQueryable) => Promise<T>): Promise<T>;
  $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T>;
}>;

export type ArtifactSelector = Readonly<{
  kind: 'RULE' | 'CATALOG';
  key: string;
  version: string;
}>;

export type VersionArtifact = ArtifactSelector &
  Readonly<{
    processorId: string | null;
    payload: JsonObject;
    payloadHash: string;
  }>;

export type VersionedReplayJob = Readonly<{
  schemaVersion: 'd03-versioned-replay-job/v1';
  replayKind: string;
  businessDay: number | null;
  rule: ArtifactSelector;
  catalogs: readonly ArtifactSelector[];
  replayPayload: JsonObject;
}>;

export type ClaimedSimulationJob = Readonly<{
  id: string;
  restaurantId: string;
  saveId: string;
  sourceEventId: string;
  sourceTransactionId: string | null;
  jobKind: string;
  businessKey: string;
  inputPayload: unknown;
  inputHash: string;
  attemptCount: number;
  leaseToken: string;
  leaseExpiresAt: Date;
}>;

export type ReplayExecutionResult = Readonly<{
  replayKind: string;
  businessDay: number | null;
  rule: VersionArtifact;
  catalogs: readonly VersionArtifact[];
  replayPayload: JsonObject;
  replayInputHash: string;
  resultPayload: JsonObject;
  resultHash: string;
}>;

type ReplayProcessor = (
  input: Readonly<{
    restaurantId: string;
    saveId: string;
    businessDay: number | null;
    rule: VersionArtifact;
    catalogs: readonly VersionArtifact[];
    replayPayload: JsonObject;
    dayReplaySource: DayReplayEvidenceSource;
  }>,
) => JsonObject | Promise<JsonObject>;

type JobRow = Readonly<{
  id: string;
  inputHash: string;
  status: string;
}>;

type DeadLetterRow = Readonly<{
  errorCode: string;
}>;

type ArtifactRow = Readonly<{
  artifactKind: 'RULE' | 'CATALOG';
  artifactKey: string;
  version: string;
  processorId: string | null;
  payload: unknown;
  payloadHash: string;
}>;

export type SimulationOutboxEvent = Readonly<{
  eventId: string;
  restaurantId: string;
  saveId: string;
  transactionId: string | null;
  causationCommandId: string;
  eventType: string;
  eventVersion: number;
  payload: unknown;
}>;

export type SimulationEnqueueInput = Readonly<{
  jobId: string;
  restaurantId: string;
  saveId: string;
  sourceEventId: string;
  jobKind: string;
  businessKey: string;
  payload: VersionedReplayJob;
}>;

type BooleanRow = Readonly<{ value: boolean }>;
type StatusRow = Readonly<{ status: string }>;
type TickRow = Readonly<{
  outputHash: string;
  ruleVersion: string;
  catalogVersion: string;
}>;
type ReplayRow = Readonly<{ resultHash: string; replayInputHash: string }>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identityPattern = /^[A-Z][A-Z0-9_.:-]{0,99}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
export const VERSIONED_REPLAY_REQUEST_EVENT = 'simulation.versioned-replay.requested' as const;
const simulationDispatchConsumer = 'simulation.dispatch.v1';

export class SimulationJobError extends Error {
  constructor(
    readonly classification: 'TRANSIENT' | 'PERMANENT',
    readonly code: string,
    readonly details: JsonObject = Object.freeze({}),
  ) {
    super(code);
    this.name = 'SimulationJobError';
  }
}

export function canonicalize(value: unknown): string {
  try {
    return canonicalizeBoundedJson(value);
  } catch (error) {
    if (error instanceof JsonResourceLimitError) {
      throw permanent('JSON_RESOURCE_LIMIT_EXCEEDED', { limit: error.kind });
    }
    throw error;
  }
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

export class PostgresVersionRegistry {
  constructor(private readonly database: SimulationDatabase) {}

  async register(
    input: Readonly<ArtifactSelector & { processorId?: string; payload: JsonObject }>,
  ) {
    validateSelector(input);
    if (input.kind === 'RULE' && (!input.processorId || !identityPattern.test(input.processorId))) {
      throw permanent('VERSION_ARTIFACT_INVALID');
    }
    if (input.kind === 'CATALOG' && input.processorId !== undefined) {
      throw permanent('VERSION_ARTIFACT_INVALID');
    }
    const artifactId = `${input.kind}:${input.key}:${input.version}`;
    const payloadHash = canonicalHash(input.payload);
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRawUnsafe(
        `INSERT INTO "SimulationVersionArtifact" (
           "id", "artifactKind", "artifactKey", "version", "processorId", "payload", "payloadHash"
         ) VALUES ($1,$2::"SimulationArtifactKind",$3,$4,$5,$6::jsonb,$7)
         ON CONFLICT ("artifactKind", "artifactKey", "version") DO NOTHING`,
        artifactId,
        input.kind,
        input.key,
        input.version,
        input.processorId ?? null,
        JSON.stringify(input.payload),
        payloadHash,
      );
      const artifact = await resolveArtifact(transaction, input);
      if (
        artifact.payloadHash !== payloadHash ||
        artifact.processorId !== (input.processorId ?? null)
      ) {
        throw permanent('VERSION_ARTIFACT_IMMUTABLE_CONFLICT');
      }
      return artifact;
    });
  }

  resolveExact(selector: ArtifactSelector): Promise<VersionArtifact> {
    return resolveArtifact(this.database, selector);
  }
}

export class VersionedReplayEngine {
  private readonly processors: ReadonlyMap<string, ReplayProcessor>;

  constructor(
    private readonly registry: PostgresVersionRegistry,
    processors: Readonly<Record<string, ReplayProcessor>> = productionReplayProcessors,
    private readonly dayReplaySource: DayReplayEvidenceSource = unavailableDayReplaySource,
  ) {
    this.processors = new Map(Object.entries(processors));
  }

  async replay(
    saveId: string,
    rawJob: unknown,
    restaurantId = '',
  ): Promise<ReplayExecutionResult> {
    const job = parseReplayJob(rawJob);
    const [rule, ...catalogs] = await Promise.all([
      this.registry.resolveExact(job.rule),
      ...job.catalogs.map((selector) => this.registry.resolveExact(selector)),
    ]);
    if (!rule.processorId) throw permanent('REPLAY_PROCESSOR_MISSING');
    const processor = this.processors.get(rule.processorId);
    if (!processor) {
      throw permanent('REPLAY_PROCESSOR_MISSING', { processorId: rule.processorId });
    }
    const resultPayload = deepFreeze(
      await processor({
        restaurantId,
        saveId,
        businessDay: job.businessDay,
        rule,
        catalogs: Object.freeze(catalogs),
        replayPayload: job.replayPayload,
        dayReplaySource: this.dayReplaySource,
      }),
    );
    return Object.freeze({
      replayKind: job.replayKind,
      businessDay: job.businessDay,
      rule,
      catalogs: Object.freeze(catalogs),
      replayPayload: job.replayPayload,
      replayInputHash: canonicalHash(job),
      resultPayload,
      resultHash: canonicalHash(resultPayload),
    });
  }
}

export class PostgresSimulationPlatform {
  readonly registry: PostgresVersionRegistry;
  readonly replay: VersionedReplayEngine;

  constructor(
    private readonly database: SimulationDatabase,
    processors?: Readonly<Record<string, ReplayProcessor>>,
  ) {
    this.registry = new PostgresVersionRegistry(database);
    this.replay = new VersionedReplayEngine(
      this.registry,
      processors,
      new PostgresDayReplayEvidenceSource(database),
    );
  }

  async ingestNextOutbox(): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const events = await transaction.$queryRawUnsafe<readonly SimulationOutboxEvent[]>(
        `SELECT event."id" AS "eventId", event."restaurantId", event."saveId",
                event."transactionId", event."causationCommandId",
                event."eventType", event."eventVersion", event."payload"
         FROM "OutboxEvent" event
         WHERE event."eventType" LIKE 'simulation.%'
           AND NOT EXISTS (
             SELECT 1 FROM "OutboxConsumerReceipt" receipt
             WHERE receipt."eventId" = event."id" AND receipt."consumerName" = $1
           )
         ORDER BY event."occurredAt", event."id"
         FOR UPDATE OF event SKIP LOCKED
         LIMIT 1`,
        simulationDispatchConsumer,
      );
      const event = events[0];
      if (!event) return false;
      let input: SimulationEnqueueInput;
      try {
        input = mapOutboxEventToSimulationJob(event);
      } catch (error) {
        if (!(error instanceof SimulationJobError) || error.classification !== 'PERMANENT') {
          throw error;
        }
        await persistPoisonedOutbox(transaction, event, error);
        return true;
      }
      await persistDispatchedJob(transaction, event, input);
      return true;
    });
  }

  async claim(workerId: string, leaseSeconds: number): Promise<ClaimedSimulationJob | undefined> {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(workerId)) {
      throw permanent('WORKER_ID_INVALID');
    }
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 900) {
      throw permanent('LEASE_DURATION_INVALID');
    }
    const leaseToken = randomUUID();
    const rows = await this.database.$queryRawUnsafe<readonly ClaimedSimulationJob[]>(
      `SELECT * FROM d03_claim_simulation_job($1,$2,$3)`,
      workerId,
      leaseToken,
      leaseSeconds,
    );
    return rows[0] ? Object.freeze({ ...rows[0] }) : undefined;
  }

  async renew(jobId: string, leaseToken: string, leaseSeconds: number): Promise<boolean> {
    const rows = await this.database.$queryRawUnsafe<readonly BooleanRow[]>(
      `SELECT d03_renew_simulation_job_lease($1,$2,$3) AS "value"`,
      jobId,
      leaseToken,
      leaseSeconds,
    );
    return rows[0]?.value === true;
  }

  async runOnce(workerId: string, leaseSeconds: number): Promise<boolean> {
    const job = await this.claim(workerId, leaseSeconds);
    if (!job) return false;
    try {
      if (canonicalHash(job.inputPayload) !== job.inputHash) {
        throw permanent('JOB_INPUT_HASH_MISMATCH');
      }
      if (job.jobKind !== 'MARKET_TICK' && job.jobKind !== 'VERSIONED_REPLAY') {
        throw permanent('JOB_KIND_UNSUPPORTED', { jobKind: job.jobKind });
      }
      const result = await this.executeWithLeaseHeartbeat(job, leaseSeconds, () =>
        this.replay.replay(job.saveId, job.inputPayload, job.restaurantId),
      );
      await this.complete(job, result);
    } catch (error) {
      const classified = classifyFailure(error);
      if (classified.code === 'JOB_LEASE_LOST') return true;
      await this.recordFailure(job, classified);
    }
    return true;
  }

  async assertMarketTickMaterialized(
    input: Readonly<{
      restaurantId: string;
      saveId: string;
      businessDay: number;
      tickKind: string;
    }>,
  ): Promise<void> {
    await this.database.$queryRawUnsafe(
      `SELECT d03_assert_market_tick_materialized($1,$2,$3,$4)`,
      input.restaurantId,
      input.saveId,
      input.businessDay,
      input.tickKind,
    );
  }

  private async complete(job: ClaimedSimulationJob, result: ReplayExecutionResult): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const catalogSelections = result.catalogs.map((artifact) => ({
        kind: artifact.kind,
        key: artifact.key,
        version: artifact.version,
        payloadHash: artifact.payloadHash,
      }));
      await transaction.$queryRawUnsafe(
        `INSERT INTO "VersionedReplayExecution" (
           "id", "restaurantId", "saveId", "jobId", "replayKind", "businessDay",
           "ruleArtifactKey", "ruleVersion", "rulePayloadHash", "catalogSelections",
           "replayPayload", "replayInputHash", "resultPayload", "resultHash"
         ) VALUES ($1,$2,$3,$1,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13)
         ON CONFLICT ("jobId") DO NOTHING`,
        job.id,
        job.restaurantId,
        job.saveId,
        result.replayKind,
        result.businessDay,
        result.rule.key,
        result.rule.version,
        result.rule.payloadHash,
        JSON.stringify(catalogSelections),
        JSON.stringify(result.replayPayload),
        result.replayInputHash,
        JSON.stringify(result.resultPayload),
        result.resultHash,
      );
      const replayRows = await transaction.$queryRawUnsafe<readonly ReplayRow[]>(
        `SELECT "resultHash", "replayInputHash"
         FROM "VersionedReplayExecution" WHERE "jobId" = $1 FOR SHARE`,
        job.id,
      );
      const replay = replayRows[0];
      if (
        !replay ||
        replay.resultHash !== result.resultHash ||
        replay.replayInputHash !== result.replayInputHash
      ) {
        throw permanent('REPLAY_EXECUTION_CONFLICT');
      }

      if (result.replayKind === 'MARKET_TICK') {
        await materializeMarketTick(transaction, job, result);
      }

      const completionRows = await transaction.$queryRawUnsafe<readonly BooleanRow[]>(
        `SELECT d03_complete_simulation_job($1,$2,$3::jsonb) AS "value"`,
        job.id,
        job.leaseToken,
        JSON.stringify({
          replayExecutionId: job.id,
          replayKind: result.replayKind,
          resultHash: result.resultHash,
        }),
      );
      if (completionRows[0]?.value !== true) throw permanent('JOB_LEASE_LOST');
    });
  }

  private async executeWithLeaseHeartbeat<T>(
    job: ClaimedSimulationJob,
    leaseSeconds: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const heartbeatMilliseconds = Math.max(1000, Math.floor((leaseSeconds * 1000) / 2));
    let active = true;
    let heartbeatFailure: SimulationJobError | undefined;
    let renewalRunning = false;
    const timer = setInterval(() => {
      if (!active || renewalRunning || heartbeatFailure) return;
      renewalRunning = true;
      void this.renew(job.id, job.leaseToken, leaseSeconds)
        .then((renewed) => {
          if (active && !renewed) heartbeatFailure = permanent('JOB_LEASE_LOST');
        })
        .catch((error: unknown) => {
          if (active) heartbeatFailure = classifyFailure(error);
        })
        .finally(() => {
          renewalRunning = false;
        });
    }, heartbeatMilliseconds);
    timer.unref();
    try {
      const result = await operation();
      if (heartbeatFailure) throw heartbeatFailure;
      return result;
    } finally {
      active = false;
      clearInterval(timer);
    }
  }

  private async recordFailure(job: ClaimedSimulationJob, error: SimulationJobError) {
    const rows = await this.database.$queryRawUnsafe<readonly StatusRow[]>(
      `SELECT d03_record_simulation_job_failure(
         $1,$2,$3::"SimulationJobErrorClass",$4,$5::jsonb
       )::text AS "status"`,
      job.id,
      job.leaseToken,
      error.classification,
      error.code,
      JSON.stringify(error.details),
    );
    return rows[0]?.status;
  }
}

const productionReplayProcessors: Readonly<Record<string, ReplayProcessor>> = Object.freeze({
  D03_MARKET_TICK_SHA256_V1: createMarketTickReplay,
  [DAY_REPLAY_EVIDENCE_PROCESSOR_ID]: createDayReplayEvidenceVerification,
});

export function createMarketTickReplay(input: Parameters<ReplayProcessor>[0]): JsonObject {
  if (
    input.businessDay === null ||
    !Number.isSafeInteger(input.businessDay) ||
    input.businessDay < 1
  ) {
    throw permanent('MARKET_TICK_INPUT_INVALID');
  }
  if (input.catalogs.length !== 1) throw permanent('MARKET_TICK_CATALOG_INVALID');
  const catalog = input.catalogs[0]!;
  const rule = parseMarketRule(input.rule.payload);
  const ingredients = parseIngredientCatalog(catalog.payload);
  const payload = input.replayPayload;
  const saveId = requireString(payload, 'saveId');
  const marketSeed = requireString(payload, 'marketSeed');
  const tickKind = requireString(payload, 'tickKind');
  const prngCursor = requireSafeInteger(payload, 'prngCursor', 0);
  if (saveId !== input.saveId || tickKind !== 'SUPPLY_PRICE' || prngCursor !== 0) {
    throw permanent('MARKET_TICK_INPUT_INVALID');
  }
  const quotes = ingredients.map((ingredient) => {
    const priceModifierBps =
      rule.dayOneUsesReference && input.businessDay === 1
        ? 0
        : stableBucket(
            marketSeed,
            `${saveId}:${input.businessDay}:${ingredient.ingredientId}`,
            rule.maximumModifierBps - rule.minimumModifierBps + 1,
          ) + rule.minimumModifierBps;
    const reference = BigInt(ingredient.referenceUnitPriceMinor);
    const unitPriceMinor = roundHalfUp(reference * BigInt(10_000 + priceModifierBps), 10_000n);
    return Object.freeze({
      ingredientId: ingredient.ingredientId,
      currency: ingredient.currency,
      referenceUnitPriceMinor: ingredient.referenceUnitPriceMinor,
      priceModifierBps,
      unitPriceMinor: unitPriceMinor.toString(),
    });
  });
  return deepFreeze({
    saveId,
    businessDay: input.businessDay,
    tickKind,
    tickIdentity: `${saveId}:${input.businessDay}:${tickKind}`,
    marketSeed,
    prngCursor,
    catalogRevision: catalog.version,
    simulationRuleVersion: input.rule.version,
    quotes,
  });
}

export async function createDayReplayEvidenceVerification(
  input: Parameters<ReplayProcessor>[0],
): Promise<JsonObject> {
  if (
    !input.restaurantId ||
    input.businessDay === null ||
    input.rule.kind !== 'RULE' ||
    input.rule.key !== DAY_REPLAY_EVIDENCE_RULE_KEY ||
    input.rule.version !== DAY_REPLAY_EVIDENCE_RULE_VERSION ||
    input.rule.processorId !== DAY_REPLAY_EVIDENCE_PROCESSOR_ID ||
    input.catalogs.length !== 0 ||
    canonicalHash(input.rule.payload) !== canonicalHash(DAY_REPLAY_RULE_PAYLOAD)
  ) {
    throw permanent('DAY_REPLAY_ARTIFACT_INVALID');
  }
  const locator = parseDayReplayLocator(input.replayPayload, input.saveId, input.businessDay);
  if (!locator) throw permanent('DAY_REPLAY_INPUT_INVALID');

  const source = await input.dayReplaySource.load({
    restaurantId: input.restaurantId,
    saveId: input.saveId,
    businessDay: input.businessDay,
    dayEndSnapshotId: locator.dayEndSnapshotId,
  });
  if (!source) throw permanent('DAY_REPLAY_SOURCE_MISSING');
  const snapshot = source.snapshot;
  if (
    snapshot.id !== locator.dayEndSnapshotId ||
    snapshot.businessDay !== input.businessDay ||
    !isSha256(snapshot.eventHash) ||
    !isSha256(snapshot.snapshotHash) ||
    locator.eventHash !== snapshot.eventHash ||
    locator.snapshotHash !== snapshot.snapshotHash
  ) {
    throw permanent('DAY_REPLAY_LOCATOR_TAMPERED');
  }
  if (source.events.length === 0) throw permanent('DAY_REPLAY_SOURCE_MISSING');

  const events = source.events.map((event, index) => {
    if (
      !Number.isSafeInteger(event.sequence) ||
      event.sequence !== index ||
      typeof event.eventType !== 'string' ||
      event.eventType.trim().length === 0 ||
      typeof event.simulationRuleVersion !== 'string' ||
      event.simulationRuleVersion.trim().length === 0 ||
      !isSha256(event.eventHash)
    ) {
      throw permanent('DAY_REPLAY_SOURCE_CORRUPT');
    }
    return Object.freeze({
      sequence: event.sequence,
      simulationRuleVersion: event.simulationRuleVersion,
      type: event.eventType,
      payload: event.payload as CanonicalJson,
    });
  });

  let computedEventHash: string;
  let computedSnapshotHash: string;
  try {
    computedEventHash = hashDayReplayEvents(events);
    computedSnapshotHash = hashDayReplaySnapshot(
      snapshot.fixedFieldSnapshot,
      snapshot.finalResourceVersions,
    );
  } catch {
    throw permanent('DAY_REPLAY_SOURCE_CORRUPT');
  }
  const status =
    computedEventHash === snapshot.eventHash && computedSnapshotHash === snapshot.snapshotHash
      ? 'MATCH'
      : 'MISMATCH';
  return deepFreeze({
    schemaVersion: DAY_REPLAY_RESULT_VERSION,
    businessDay: input.businessDay,
    dayEndSnapshotId: snapshot.id,
    eventCount: events.length,
    expected: {
      eventHash: snapshot.eventHash,
      snapshotHash: snapshot.snapshotHash,
    },
    computed: {
      eventHash: computedEventHash,
      snapshotHash: computedSnapshotHash,
    },
    status,
  });
}

function parseDayReplayLocator(
  replayPayload: JsonObject,
  saveId: string,
  businessDay: number,
): DayReplayLocator | undefined {
  if (
    !hasExactKeys(replayPayload, ['locator', 'schemaVersion']) ||
    replayPayload.schemaVersion !== DAY_REPLAY_LOCATOR_VERSION ||
    !isPlainObject(replayPayload.locator) ||
    !hasExactKeys(replayPayload.locator, [
      'businessDay',
      'dayEndSnapshotId',
      'eventHash',
      'saveId',
      'snapshotHash',
    ])
  ) {
    return undefined;
  }
  const locator = replayPayload.locator;
  if (
    locator.businessDay !== businessDay ||
    locator.saveId !== saveId ||
    typeof locator.dayEndSnapshotId !== 'string' ||
    locator.dayEndSnapshotId.length === 0 ||
    locator.dayEndSnapshotId.length > 200 ||
    !isSha256(locator.eventHash) ||
    !isSha256(locator.snapshotHash)
  ) {
    return undefined;
  }
  return Object.freeze({
    businessDay,
    dayEndSnapshotId: locator.dayEndSnapshotId,
    eventHash: locator.eventHash,
    saveId,
    snapshotHash: locator.snapshotHash,
  });
}

async function materializeMarketTick(
  transaction: SimulationQueryable,
  job: ClaimedSimulationJob,
  result: ReplayExecutionResult,
): Promise<void> {
  const output = result.resultPayload;
  const catalog = result.catalogs[0];
  if (!catalog) throw permanent('MARKET_TICK_CATALOG_INVALID');
  const businessDay = requireSafeInteger(output, 'businessDay', 1);
  const tickKind = requireString(output, 'tickKind');
  const marketSeed = requireString(output, 'marketSeed');
  const prngCursor = requireSafeInteger(output, 'prngCursor', 0);
  const tickId = `${job.saveId}:${businessDay}:${tickKind}`;
  await transaction.$queryRawUnsafe(
    `INSERT INTO "MarketTick" (
       "id", "restaurantId", "saveId", "businessDay", "tickKind", "materializationSource",
       "materializedByJobId", "replayExecutionId", "marketSeed",
       "ruleArtifactKey", "simulationRuleVersion", "rulePayloadHash",
       "catalogArtifactKey", "catalogRevision", "catalogPayloadHash", "prngCursor",
       "inputPayload", "outputPayload", "outputHash"
     ) VALUES ($1,$2,$3,$4,$5,'JOB',$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17)
     ON CONFLICT ("saveId", "businessDay", "tickKind") DO NOTHING`,
    tickId,
    job.restaurantId,
    job.saveId,
    businessDay,
    tickKind,
    job.id,
    marketSeed,
    result.rule.key,
    result.rule.version,
    result.rule.payloadHash,
    catalog.key,
    catalog.version,
    catalog.payloadHash,
    prngCursor,
    JSON.stringify(result.replayPayload),
    JSON.stringify(result.resultPayload),
    result.resultHash,
  );
  const rows = await transaction.$queryRawUnsafe<readonly TickRow[]>(
    `SELECT "outputHash", "simulationRuleVersion" AS "ruleVersion",
            "catalogRevision" AS "catalogVersion"
     FROM "MarketTick"
     WHERE "saveId" = $1 AND "businessDay" = $2 AND "tickKind" = $3
       AND "restaurantId" = $4
     FOR SHARE`,
    job.saveId,
    businessDay,
    tickKind,
    job.restaurantId,
  );
  const tick = rows[0];
  if (
    !tick ||
    tick.outputHash !== result.resultHash ||
    tick.ruleVersion !== result.rule.version ||
    tick.catalogVersion !== catalog.version
  ) {
    throw permanent('MARKET_TICK_IDENTITY_CONFLICT');
  }
}

async function resolveArtifact(
  queryable: SimulationQueryable,
  selector: ArtifactSelector,
): Promise<VersionArtifact> {
  validateSelector(selector);
  const rows = await queryable.$queryRawUnsafe<readonly ArtifactRow[]>(
    `SELECT "artifactKind", "artifactKey", "version", "processorId", "payload", "payloadHash"
     FROM "SimulationVersionArtifact"
     WHERE "artifactKind" = $1::"SimulationArtifactKind"
       AND "artifactKey" = $2 AND "version" = $3`,
    selector.kind,
    selector.key,
    selector.version,
  );
  const row = rows[0];
  if (!row) {
    throw permanent('REPLAY_VERSION_MISSING', {
      kind: selector.kind,
      key: selector.key,
      version: selector.version,
    });
  }
  if (!isPlainObject(row.payload) || canonicalHash(row.payload) !== row.payloadHash) {
    throw permanent('VERSION_ARTIFACT_CORRUPT');
  }
  return deepFreeze({
    kind: row.artifactKind,
    key: row.artifactKey,
    version: row.version,
    processorId: row.processorId,
    payload: row.payload as JsonObject,
    payloadHash: row.payloadHash,
  });
}

export function mapOutboxEventToSimulationJob(
  event: SimulationOutboxEvent,
): SimulationEnqueueInput {
  if (
    !uuidPattern.test(event.eventId) ||
    !event.restaurantId ||
    !event.saveId ||
    !uuidPattern.test(event.causationCommandId) ||
    (event.transactionId !== null &&
      (!uuidPattern.test(event.transactionId) ||
        event.transactionId !== event.causationCommandId)) ||
    typeof event.eventType !== 'string' ||
    !event.eventType.startsWith('simulation.') ||
    !Number.isSafeInteger(event.eventVersion)
  ) {
    throw permanent('OUTBOX_REPLAY_REQUEST_INVALID');
  }
  if (event.eventType !== VERSIONED_REPLAY_REQUEST_EVENT || event.eventVersion !== 1) {
    throw permanent('OUTBOX_EVENT_UNSUPPORTED', {
      eventType: event.eventType,
      eventVersion: event.eventVersion,
    });
  }
  try {
    assertJsonWithinResourceLimits(event.payload);
  } catch (error) {
    if (error instanceof JsonResourceLimitError) {
      throw permanent('OUTBOX_EVENT_RESOURCE_LIMIT_EXCEEDED', { limit: error.kind });
    }
    throw error;
  }
  if (
    !isPlainObject(event.payload) ||
    !hasExactKeys(event.payload, ['businessKey', 'jobId', 'jobKind', 'replay', 'schemaVersion']) ||
    event.payload.schemaVersion !== 'd03-versioned-replay-request/v1'
  ) {
    throw permanent('OUTBOX_REPLAY_REQUEST_INVALID');
  }
  const payload = parseReplayJob(event.payload.replay);
  const input = deepFreeze({
    jobId: event.payload.jobId,
    restaurantId: event.restaurantId,
    saveId: event.saveId,
    sourceEventId: event.eventId,
    jobKind: event.payload.jobKind,
    businessKey: event.payload.businessKey,
    payload,
  }) as SimulationEnqueueInput;
  validateEnqueue(input);
  if (input.jobKind === 'MARKET_TICK') {
    const tickKind = input.payload.replayPayload.tickKind;
    const payloadSaveId = input.payload.replayPayload.saveId;
    if (
      input.payload.replayKind !== 'MARKET_TICK' ||
      input.payload.businessDay === null ||
      typeof tickKind !== 'string' ||
      typeof payloadSaveId !== 'string' ||
      payloadSaveId !== event.saveId ||
      input.businessKey !== `${event.saveId}:${input.payload.businessDay}:${tickKind}`
    ) {
      throw permanent('OUTBOX_REPLAY_REQUEST_INVALID');
    }
  } else {
    const businessDay = input.payload.businessDay;
    if (
      input.jobKind !== 'VERSIONED_REPLAY' ||
      input.payload.replayKind !== 'DAY_REPLAY' ||
      businessDay === null ||
      input.payload.rule.kind !== 'RULE' ||
      input.payload.rule.key !== DAY_REPLAY_EVIDENCE_RULE_KEY ||
      input.payload.rule.version !== DAY_REPLAY_EVIDENCE_RULE_VERSION ||
      input.payload.catalogs.length !== 0 ||
      !parseDayReplayLocator(input.payload.replayPayload, event.saveId, businessDay) ||
      input.businessKey !== `${event.saveId}:${businessDay}:DAY_REPLAY`
    ) {
      throw permanent('OUTBOX_REPLAY_REQUEST_INVALID');
    }
  }
  return input;
}

async function persistPoisonedOutbox(
  transaction: SimulationQueryable,
  event: SimulationOutboxEvent,
  error: SimulationJobError,
): Promise<void> {
  const details = canonicalize(error.details);
  const inserted = await transaction.$queryRawUnsafe<readonly DeadLetterRow[]>(
    `INSERT INTO "OutboxConsumerDeadLetter" (
       "id", "restaurantId", "eventId", "consumerName", "eventType", "eventVersion",
       "errorCode", "errorDetails"
     ) VALUES ($1 || ':' || $3,$2,$1,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT ("eventId", "consumerName") DO NOTHING
     RETURNING "errorCode"`,
    event.eventId,
    event.restaurantId,
    simulationDispatchConsumer,
    event.eventType,
    event.eventVersion,
    error.code,
    details,
  );
  const deadLetter =
    inserted[0] ??
    (
      await transaction.$queryRawUnsafe<readonly DeadLetterRow[]>(
        `SELECT "errorCode" FROM "OutboxConsumerDeadLetter"
         WHERE "eventId" = $1 AND "consumerName" = $2 FOR SHARE`,
        event.eventId,
        simulationDispatchConsumer,
      )
    )[0];
  if (!deadLetter || deadLetter.errorCode !== error.code) {
    throw permanent('OUTBOX_DEAD_LETTER_IDENTITY_CONFLICT');
  }
  await transaction.$queryRawUnsafe(
    `INSERT INTO "OutboxConsumerReceipt" (
       "id", "restaurantId", "eventId", "consumerName"
     ) VALUES ($1 || ':' || $3,$2,$1,$3)
     ON CONFLICT ("eventId", "consumerName") DO NOTHING`,
    event.eventId,
    event.restaurantId,
    simulationDispatchConsumer,
  );
}

async function persistDispatchedJob(
  transaction: SimulationQueryable,
  event: SimulationOutboxEvent,
  input: SimulationEnqueueInput,
): Promise<void> {
  const inputHash = canonicalHash(input.payload);
  const receipt = await transaction.$queryRawUnsafe<readonly { id: string }[]>(
    `INSERT INTO "OutboxConsumerReceipt" (
       "id", "restaurantId", "eventId", "consumerName"
     ) VALUES ($1 || ':' || $3,$2,$1,$3)
     ON CONFLICT ("eventId", "consumerName") DO NOTHING
     RETURNING "id"`,
    input.sourceEventId,
    input.restaurantId,
    simulationDispatchConsumer,
  );
  if (!receipt[0]) {
    const existing = await findJobByBusinessIdentity(transaction, input);
    if (!existing || existing.id !== input.jobId || existing.inputHash !== inputHash) {
      throw permanent('JOB_BUSINESS_IDENTITY_CONFLICT');
    }
    return;
  }

  const inserted = await transaction.$queryRawUnsafe<readonly JobRow[]>(
    `INSERT INTO "SimulationJob" (
       "id", "restaurantId", "saveId", "sourceEventId", "sourceTransactionId",
       "jobKind", "businessKey", "inputPayload", "inputHash"
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     ON CONFLICT ("sourceEventId", "jobKind", "businessKey") DO NOTHING
     RETURNING "id", "inputHash", "status"`,
    input.jobId,
    input.restaurantId,
    input.saveId,
    input.sourceEventId,
    event.transactionId,
    input.jobKind,
    input.businessKey,
    JSON.stringify(input.payload),
    inputHash,
  );
  const job = inserted[0];
  if (!job || job.id !== input.jobId || job.inputHash !== inputHash) {
    throw permanent('JOB_BUSINESS_IDENTITY_CONFLICT');
  }
  await transaction.$queryRawUnsafe(
    `INSERT INTO "SimulationJobAudit" (
       "id", "restaurantId", "jobId", "action", "attempt", "details"
     ) VALUES ($1 || ':enqueued',$2,$1,'ENQUEUED',0,$3::jsonb)`,
    input.jobId,
    input.restaurantId,
    JSON.stringify({
      sourceEventId: input.sourceEventId,
      sourceTransactionId: event.transactionId,
      inputHash,
    }),
  );
}

function parseReplayJob(value: unknown): VersionedReplayJob {
  if (!isPlainObject(value)) throw permanent('REPLAY_JOB_INVALID');
  const expected = [
    'businessDay',
    'catalogs',
    'replayKind',
    'replayPayload',
    'rule',
    'schemaVersion',
  ];
  if (!hasExactKeys(value, expected) || value.schemaVersion !== 'd03-versioned-replay-job/v1') {
    throw permanent('REPLAY_JOB_INVALID');
  }
  if (typeof value.replayKind !== 'string' || !identityPattern.test(value.replayKind)) {
    throw permanent('REPLAY_JOB_INVALID');
  }
  if (
    value.businessDay !== null &&
    (!Number.isSafeInteger(value.businessDay) || (value.businessDay as number) < 1)
  ) {
    throw permanent('REPLAY_JOB_INVALID');
  }
  if (
    !isSelector(value.rule) ||
    !Array.isArray(value.catalogs) ||
    !value.catalogs.every(isSelector)
  ) {
    throw permanent('REPLAY_JOB_INVALID');
  }
  if (value.rule.kind !== 'RULE' || value.catalogs.some((item) => item.kind !== 'CATALOG')) {
    throw permanent('REPLAY_JOB_INVALID');
  }
  const catalogs = value.catalogs as readonly ArtifactSelector[];
  const catalogIdentities = catalogs.map((item) => `${item.key}:${item.version}`);
  if (new Set(catalogIdentities).size !== catalogs.length || !isPlainObject(value.replayPayload)) {
    throw permanent('REPLAY_JOB_INVALID');
  }
  return deepFreeze({
    schemaVersion: value.schemaVersion,
    replayKind: value.replayKind,
    businessDay: value.businessDay as number | null,
    rule: value.rule as ArtifactSelector,
    catalogs,
    replayPayload: value.replayPayload as JsonObject,
  });
}

function validateEnqueue(
  input: Readonly<{
    jobId: string;
    restaurantId: string;
    saveId: string;
    sourceEventId: string;
    jobKind: string;
    businessKey: string;
    payload: VersionedReplayJob;
  }>,
): void {
  if (
    !uuidPattern.test(input.jobId) ||
    !input.restaurantId ||
    !input.saveId ||
    !uuidPattern.test(input.sourceEventId) ||
    (input.jobKind !== 'MARKET_TICK' && input.jobKind !== 'VERSIONED_REPLAY') ||
    !input.businessKey ||
    input.businessKey.length > 300
  ) {
    throw permanent('JOB_ENQUEUE_INVALID');
  }
  parseReplayJob(input.payload);
}

async function findJobByBusinessIdentity(
  transaction: SimulationQueryable,
  input: Readonly<{ sourceEventId: string; jobKind: string; businessKey: string }>,
): Promise<JobRow | undefined> {
  const rows = await transaction.$queryRawUnsafe<readonly JobRow[]>(
    `SELECT "id", "inputHash", "status" FROM "SimulationJob"
     WHERE "sourceEventId" = $1 AND "jobKind" = $2 AND "businessKey" = $3
     FOR SHARE`,
    input.sourceEventId,
    input.jobKind,
    input.businessKey,
  );
  return rows[0];
}

function parseMarketRule(payload: JsonObject): Readonly<{
  minimumModifierBps: number;
  maximumModifierBps: number;
  dayOneUsesReference: boolean;
}> {
  if (!hasExactKeys(payload, ['dayOneUsesReference', 'maximumModifierBps', 'minimumModifierBps'])) {
    throw permanent('MARKET_TICK_RULE_INVALID');
  }
  const minimumModifierBps = payload.minimumModifierBps;
  const maximumModifierBps = payload.maximumModifierBps;
  const dayOneUsesReference = payload.dayOneUsesReference;
  if (
    !Number.isSafeInteger(minimumModifierBps) ||
    !Number.isSafeInteger(maximumModifierBps) ||
    typeof dayOneUsesReference !== 'boolean' ||
    (minimumModifierBps as number) < -10_000 ||
    (maximumModifierBps as number) > 10_000 ||
    (minimumModifierBps as number) > (maximumModifierBps as number)
  ) {
    throw permanent('MARKET_TICK_RULE_INVALID');
  }
  return Object.freeze({
    minimumModifierBps: minimumModifierBps as number,
    maximumModifierBps: maximumModifierBps as number,
    dayOneUsesReference,
  });
}

function parseIngredientCatalog(payload: JsonObject): readonly Readonly<{
  ingredientId: string;
  currency: string;
  referenceUnitPriceMinor: string;
}>[] {
  if (!hasExactKeys(payload, ['ingredients']) || !Array.isArray(payload.ingredients)) {
    throw permanent('MARKET_TICK_CATALOG_INVALID');
  }
  const ingredients = payload.ingredients.map((value) => {
    if (
      !isPlainObject(value) ||
      !hasExactKeys(value, ['currency', 'ingredientId', 'referenceUnitPriceMinor'])
    ) {
      throw permanent('MARKET_TICK_CATALOG_INVALID');
    }
    const ingredientId = value.ingredientId;
    const currency = value.currency;
    const referenceUnitPriceMinor = value.referenceUnitPriceMinor;
    if (
      typeof ingredientId !== 'string' ||
      !ingredientId ||
      ingredientId.length > 100 ||
      typeof currency !== 'string' ||
      !/^[A-Z]{3}$/.test(currency) ||
      typeof referenceUnitPriceMinor !== 'string' ||
      !/^[1-9]\d*$/.test(referenceUnitPriceMinor) ||
      BigInt(referenceUnitPriceMinor) > 9_223_372_036_854_775_807n
    ) {
      throw permanent('MARKET_TICK_CATALOG_INVALID');
    }
    return Object.freeze({ ingredientId, currency, referenceUnitPriceMinor });
  });
  if (
    ingredients.length === 0 ||
    new Set(ingredients.map((item) => item.ingredientId)).size !== ingredients.length
  ) {
    throw permanent('MARKET_TICK_CATALOG_INVALID');
  }
  const currencies = new Set(ingredients.map((item) => item.currency));
  if (currencies.size !== 1) throw permanent('MARKET_TICK_CATALOG_INVALID');
  return Object.freeze(
    [...ingredients].sort((left, right) => compareText(left.ingredientId, right.ingredientId)),
  );
}

function requireString(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value || value.length > 300) {
    throw permanent('MARKET_TICK_INPUT_INVALID', { field: key });
  }
  return value;
}

function requireSafeInteger(payload: JsonObject, key: string, minimum: number): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw permanent('MARKET_TICK_INPUT_INVALID', { field: key });
  }
  return value as number;
}

function stableBucket(seed: string, identity: string, bucketCount: number): number {
  if (!Number.isSafeInteger(bucketCount) || bucketCount < 1 || bucketCount > 20_001) {
    throw permanent('MARKET_TICK_RULE_INVALID');
  }
  const digest = createHash('sha256').update(`${seed}\u0000${identity}`).digest();
  return digest.readUInt32BE(0) % bucketCount;
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw permanent('MARKET_TICK_RULE_INVALID');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function classifyFailure(error: unknown): SimulationJobError {
  if (error instanceof SimulationJobError) return error;
  if (isTransientSimulationInfrastructureError(error)) {
    return new SimulationJobError('TRANSIENT', 'TRANSIENT_DATABASE_ERROR');
  }
  return new SimulationJobError('PERMANENT', 'UNEXPECTED_HANDLER_ERROR');
}

const transientDatabaseCodes = new Set([
  '08000',
  '08001',
  '08003',
  '08006',
  '40001',
  '40P01',
  '53300',
  '57P01',
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2034',
]);

export function isTransientSimulationInfrastructureError(error: unknown): boolean {
  if (!isPlainObject(error) || typeof error.code !== 'string') return false;
  const code =
    error.code === 'P2010' && isPlainObject(error.meta) && typeof error.meta.code === 'string'
      ? error.meta.code
      : error.code;
  return transientDatabaseCodes.has(code);
}

function permanent(code: string, details: JsonObject = Object.freeze({})): SimulationJobError {
  return new SimulationJobError('PERMANENT', code, deepFreeze(details));
}

function validateSelector(value: ArtifactSelector): void {
  if (!isSelector(value)) throw permanent('VERSION_SELECTOR_INVALID');
}

function isSelector(value: unknown): value is ArtifactSelector {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ['key', 'kind', 'version']) &&
    (value.kind === 'RULE' || value.kind === 'CATALOG') &&
    typeof value.key === 'string' &&
    identityPattern.test(value.key) &&
    typeof value.version === 'string' &&
    versionPattern.test(value.version)
  );
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareText);
  const sortedExpected = [...expected].sort(compareText);
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
