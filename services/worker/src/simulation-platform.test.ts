import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalHash,
  createDayReplayEvidenceVerification,
  createMarketTickReplay,
  isTransientSimulationInfrastructureError,
  mapOutboxEventToSimulationJob,
  PostgresSimulationPlatform,
  PostgresVersionRegistry,
  SimulationJobError,
  VERSIONED_REPLAY_REQUEST_EVENT,
  VersionedReplayEngine,
  type ArtifactSelector,
  type JsonObject,
  type SimulationDatabase,
  type SimulationOutboxEvent,
  type SimulationQueryable,
  type VersionArtifact,
  type VersionedReplayJob,
} from './simulation-platform.js';
import {
  DAY_REPLAY_EVIDENCE_PROCESSOR_ID,
  DAY_REPLAY_RULE_PAYLOAD,
  hashDayReplayEvents,
  hashDayReplaySnapshot,
  type DayReplayEvidenceSource,
} from './day-replay-evidence.js';

const catalogPayload = Object.freeze({
  ingredients: Object.freeze([
    Object.freeze({
      ingredientId: 'rice',
      currency: 'TWD',
      referenceUnitPriceMinor: '30',
    }),
    Object.freeze({
      ingredientId: 'egg',
      currency: 'TWD',
      referenceUnitPriceMinor: '20',
    }),
  ]),
}) satisfies JsonObject;

function artifact(
  kind: 'RULE' | 'CATALOG',
  key: string,
  version: string,
  payload: JsonObject,
  processorId: string | null,
): VersionArtifact {
  return Object.freeze({
    kind,
    key,
    version,
    payload,
    processorId,
    payloadHash: canonicalHash(payload),
  });
}

const ruleV1 = artifact(
  'RULE',
  'MARKET_PRICE',
  'market-rule/v1',
  Object.freeze({
    minimumModifierBps: -1000,
    maximumModifierBps: 1000,
    dayOneUsesReference: true,
  }),
  'D03_MARKET_TICK_SHA256_V1',
);
const ruleV2 = artifact(
  'RULE',
  'MARKET_PRICE',
  'market-rule/v2',
  Object.freeze({
    minimumModifierBps: 0,
    maximumModifierBps: 0,
    dayOneUsesReference: true,
  }),
  'D03_MARKET_TICK_SHA256_V1',
);
const catalogV1 = artifact(
  'CATALOG',
  'INGREDIENT_PRICE',
  'ingredient-catalog/v1',
  catalogPayload,
  null,
);

const goldenEventHash = 'f83ad03e07924d5c127692901b597b7e9c3ef06849196aafef0e44c38f51215d';
const goldenSnapshotHash = '17575e05b3c630cda1fca3d308a479b5ceaa650e863651b050e75f9818ca5042';
const goldenEvents = Object.freeze([
  Object.freeze({
    sequence: 0,
    simulationRuleVersion: 'simulation-rule/v1',
    type: 'OPEN_DAY',
    payload: Object.freeze({ gameId: 'game-1', dayIndex: 1 }),
  }),
  Object.freeze({
    sequence: 1,
    simulationRuleVersion: 'simulation-rule/v1',
    type: 'DAY_END_SETTLED',
    payload: Object.freeze({ cashAfterMinor: '13400' }),
  }),
]);
const money = (minorUnits: string) => Object.freeze({ currency: 'USD', minorUnits });
const goldenFixedFieldSnapshot = Object.freeze({
  dayIndex: 1,
  grossRevenue: money('10000'),
  cogs: money('3000'),
  wasteLoss: money('100'),
  payroll: money('2000'),
  opex: money('1000'),
  tax: money('500'),
  debtDue: money('0'),
  riskPenalty: money('0'),
  riskPenaltyCalculation: Object.freeze({
    version: 'e05-risk-penalty-v1',
    base: money('0'),
    rate: 300,
    denominator: 10_000,
    rounding: 'HALF_UP',
    minimum: money('1'),
    amount: money('0'),
    accruedTotal: money('0'),
    currency: 'USD',
    idempotencyKey: Object.freeze({ gameId: 'game-1', dayIndex: 1, version: 'e05-risk-penalty-v1' }),
  }),
  dailyNet: money('3400'),
  resolutionComparisonShortfall: money('0'),
  shortfall: money('0'),
  cashAfter: money('13400'),
  reputation: Object.freeze({ price: 50, speed: 51, quality: 52, fairness: 53, vibe: 54 }),
  riskTags: Object.freeze([]),
  riskState: Object.freeze({
    state: 'NORMAL',
    consecutiveDelinquentDays: 0,
    consecutiveResolutionDays: 0,
    delinquencyBaselineShortfall: null,
  }),
  highRiskRevenueEnabled: true,
  leaderboardEligible: true,
});
const goldenFinalResourceVersions = Object.freeze({
  game: 7,
  inventoryCatalog: 'inventory-rule/v1',
  simulationRule: 'simulation-rule/v1',
});
const dayReplayRule = artifact(
  'RULE',
  'DAY_REPLAY_EVIDENCE',
  'mvp-release-evidence-v1',
  DAY_REPLAY_RULE_PAYLOAD,
  DAY_REPLAY_EVIDENCE_PROCESSOR_ID,
);

function dayReplayJob(): VersionedReplayJob {
  return Object.freeze({
    schemaVersion: 'd03-versioned-replay-job/v1',
    replayKind: 'DAY_REPLAY',
    businessDay: 1,
    rule: Object.freeze({
      kind: 'RULE',
      key: 'DAY_REPLAY_EVIDENCE',
      version: 'mvp-release-evidence-v1',
    }),
    catalogs: Object.freeze([]),
    replayPayload: Object.freeze({
      schemaVersion: 'p0-day-replay-locator/v1',
      locator: Object.freeze({
        businessDay: 1,
        dayEndSnapshotId: 'day-end-1',
        eventHash: goldenEventHash,
        saveId: 'save-a',
        snapshotHash: goldenSnapshotHash,
      }),
    }),
  });
}

function dayReplaySource(
  fixedFieldSnapshot: unknown = goldenFixedFieldSnapshot,
): DayReplayEvidenceSource {
  return Object.freeze({
    async load() {
      return Object.freeze({
        snapshot: Object.freeze({
          id: 'day-end-1',
          businessDay: 1,
          eventHash: goldenEventHash,
          snapshotHash: goldenSnapshotHash,
          fixedFieldSnapshot,
          finalResourceVersions: goldenFinalResourceVersions,
        }),
        events: Object.freeze(
          goldenEvents.map((event) =>
            Object.freeze({
              sequence: event.sequence,
              eventType: event.type,
              simulationRuleVersion: event.simulationRuleVersion,
              payload: event.payload,
              eventHash: goldenEventHash,
            }),
          ),
        ),
      });
    },
  });
}

function replayJob(ruleVersion: string): VersionedReplayJob {
  return Object.freeze({
    schemaVersion: 'd03-versioned-replay-job/v1',
    replayKind: 'MARKET_TICK',
    businessDay: 2,
    rule: Object.freeze({ kind: 'RULE', key: 'MARKET_PRICE', version: ruleVersion }),
    catalogs: Object.freeze([
      Object.freeze({
        kind: 'CATALOG',
        key: 'INGREDIENT_PRICE',
        version: 'ingredient-catalog/v1',
      }),
    ]),
    replayPayload: Object.freeze({
      saveId: 'save-a',
      marketSeed: 'seed-a',
      tickKind: 'SUPPLY_PRICE',
      prngCursor: 0,
    }),
  });
}

function replayRequestEvent(): SimulationOutboxEvent {
  return Object.freeze({
    eventId: '10000000-0000-4000-8000-000000000001',
    restaurantId: 'restaurant-a',
    saveId: 'save-a',
    transactionId: '10000000-0000-4000-8000-000000000001',
    causationCommandId: '10000000-0000-4000-8000-000000000001',
    eventType: VERSIONED_REPLAY_REQUEST_EVENT,
    eventVersion: 1,
    payload: Object.freeze({
      schemaVersion: 'd03-versioned-replay-request/v1',
      jobId: '20000000-0000-4000-8000-000000000001',
      jobKind: 'MARKET_TICK',
      businessKey: 'save-a:2:SUPPLY_PRICE',
      replay: replayJob('market-rule/v1'),
    }),
  });
}

function dayReplayRequestEvent(): SimulationOutboxEvent {
  return Object.freeze({
    eventId: '30000000-0000-4000-8000-000000000001',
    restaurantId: 'restaurant-a',
    saveId: 'save-a',
    transactionId: null,
    causationCommandId: '30000000-0000-4000-8000-000000000001',
    eventType: VERSIONED_REPLAY_REQUEST_EVENT,
    eventVersion: 1,
    payload: Object.freeze({
      schemaVersion: 'd03-versioned-replay-request/v1',
      jobId: '40000000-0000-4000-8000-000000000001',
      jobKind: 'VERSIONED_REPLAY',
      businessKey: 'save-a:1:DAY_REPLAY',
      replay: dayReplayJob(),
    }),
  });
}

class TransactionalIngestionDatabase implements SimulationDatabase {
  private receipts = new Set<string>();
  private jobs = new Map<string, Readonly<{ id: string; inputHash: string; status: string }>>();
  private audits = new Set<string>();
  private deadLetters = new Map<string, string>();
  private transactionTail = Promise.resolve();
  failNextJobInsert = false;
  failNextDeadLetterInsert = false;

  private readonly events: readonly SimulationOutboxEvent[];

  constructor(event: SimulationOutboxEvent | readonly SimulationOutboxEvent[]) {
    this.events = Array.isArray(event) ? event : [event];
  }

  get counts() {
    return Object.freeze({
      receipts: this.receipts.size,
      jobs: this.jobs.size,
      audits: this.audits.size,
      deadLetters: this.deadLetters.size,
    });
  }

  async $queryRawUnsafe<T>(): Promise<T> {
    return [] as T;
  }

  async $transaction<T>(operation: (transaction: SimulationQueryable) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const receipts = new Set(this.receipts);
    const jobs = new Map(this.jobs);
    const audits = new Set(this.audits);
    const deadLetters = new Map(this.deadLetters);
    const queryable: SimulationQueryable = {
      $queryRawUnsafe: async <R>(query: string, ...values: readonly unknown[]): Promise<R> => {
        if (query.includes('FROM "OutboxEvent" event')) {
          const event = this.events.find(
            (candidate) => !receipts.has(`${candidate.eventId}:simulation.dispatch.v1`),
          );
          return (event ? [event] : []) as R;
        }
        if (query.includes('INSERT INTO "OutboxConsumerDeadLetter"')) {
          if (this.failNextDeadLetterInsert) {
            this.failNextDeadLetterInsert = false;
            throw new Error('test transient database interruption');
          }
          const identity = `${String(values[0])}:${String(values[2])}`;
          if (deadLetters.has(identity)) return [] as R;
          const errorCode = String(values[5]);
          deadLetters.set(identity, errorCode);
          return [{ errorCode }] as R;
        }
        if (query.includes('SELECT "errorCode" FROM "OutboxConsumerDeadLetter"')) {
          const identity = `${String(values[0])}:${String(values[1])}`;
          const errorCode = deadLetters.get(identity);
          return (errorCode ? [{ errorCode }] : []) as R;
        }
        if (query.includes('INSERT INTO "OutboxConsumerReceipt"')) {
          const identity = `${String(values[0])}:${String(values[2])}`;
          if (receipts.has(identity)) return [] as R;
          receipts.add(identity);
          return [{ id: identity }] as R;
        }
        if (query.includes('SELECT "id", "inputHash", "status" FROM "SimulationJob"')) {
          const job = [...jobs.values()][0];
          return (job ? [job] : []) as R;
        }
        if (query.includes('INSERT INTO "SimulationJob"')) {
          if (this.failNextJobInsert) {
            this.failNextJobInsert = false;
            throw new Error('test transaction interruption');
          }
          const job = Object.freeze({
            id: String(values[0]),
            inputHash: String(values[8]),
            status: 'PENDING',
          });
          jobs.set(job.id, job);
          return [job] as R;
        }
        if (query.includes('INSERT INTO "SimulationJobAudit"')) {
          audits.add(`${String(values[0])}:enqueued`);
          return [] as R;
        }
        throw new Error(`unexpected ingestion query: ${query}`);
      },
    };
    try {
      const result = await operation(queryable);
      this.receipts = receipts;
      this.jobs = jobs;
      this.audits = audits;
      this.deadLetters = deadLetters;
      return result;
    } finally {
      release();
    }
  }
}

function fakeRegistryDatabase(artifacts: readonly VersionArtifact[]): SimulationDatabase {
  const queryable: SimulationQueryable = {
    async $queryRawUnsafe<T>(_query: string, ...values: readonly unknown[]): Promise<T> {
      const selector: ArtifactSelector = {
        kind: values[0] as ArtifactSelector['kind'],
        key: values[1] as string,
        version: values[2] as string,
      };
      const match = artifacts.find(
        (item) =>
          item.kind === selector.kind &&
          item.key === selector.key &&
          item.version === selector.version,
      );
      const rows = match
        ? [
            {
              artifactKind: match.kind,
              artifactKey: match.key,
              version: match.version,
              processorId: match.processorId,
              payload: match.payload,
              payloadHash: match.payloadHash,
            },
          ]
        : [];
      return rows as T;
    },
  };
  return {
    ...queryable,
    $transaction: async <T>(operation: (transaction: SimulationQueryable) => Promise<T>) =>
      operation(queryable),
  };
}

test('canonical hashes do not depend on object insertion order', () => {
  assert.equal(canonicalHash({ b: 2, a: 1 }), canonicalHash({ a: 1, b: 2 }));
});

test('worker E05 canonical hashes match the API mvp-release-evidence-v1 golden values', () => {
  assert.equal(hashDayReplayEvents(goldenEvents), goldenEventHash);
  assert.equal(
    hashDayReplaySnapshot(goldenFixedFieldSnapshot, goldenFinalResourceVersions),
    goldenSnapshotHash,
  );
});

test('production outbox mapping accepts only the exact API DAY_REPLAY business identity', () => {
  const event = dayReplayRequestEvent();
  assert.deepEqual(mapOutboxEventToSimulationJob(event), {
    jobId: '40000000-0000-4000-8000-000000000001',
    restaurantId: 'restaurant-a',
    saveId: 'save-a',
    sourceEventId: '30000000-0000-4000-8000-000000000001',
    jobKind: 'VERSIONED_REPLAY',
    businessKey: 'save-a:1:DAY_REPLAY',
    payload: dayReplayJob(),
  });

  const request = event.payload as Readonly<Record<string, unknown>>;
  assert.throws(
    () =>
      mapOutboxEventToSimulationJob({
        ...event,
        payload: { ...request, businessKey: 'save-a:2:DAY_REPLAY' },
      }),
    (error: unknown) =>
      error instanceof SimulationJobError && error.code === 'OUTBOX_REPLAY_REQUEST_INVALID',
  );
  assert.throws(
    () =>
      mapOutboxEventToSimulationJob({
        ...event,
        payload: {
          ...request,
          replay: { ...dayReplayJob(), catalogs: [{ kind: 'CATALOG', key: 'EXTRA', version: 'v1' }] },
        },
      }),
    (error: unknown) =>
      error instanceof SimulationJobError && error.code === 'OUTBOX_REPLAY_REQUEST_INVALID',
  );
});

test('E05 DAY_REPLAY re-resolves scoped durable evidence and completes MATCH or MISMATCH', async () => {
  const calls: unknown[] = [];
  const matchingSource: DayReplayEvidenceSource = {
    async load(input) {
      calls.push(input);
      return dayReplaySource().load(input);
    },
  };
  const matching = await createDayReplayEvidenceVerification({
    restaurantId: 'restaurant-a',
    saveId: 'save-a',
    businessDay: 1,
    rule: dayReplayRule,
    catalogs: [],
    replayPayload: dayReplayJob().replayPayload,
    dayReplaySource: matchingSource,
  });
  assert.deepEqual(calls, [
    {
      restaurantId: 'restaurant-a',
      saveId: 'save-a',
      businessDay: 1,
      dayEndSnapshotId: 'day-end-1',
    },
  ]);
  assert.deepEqual(matching, {
    schemaVersion: 'e05-day-replay-verification/v1',
    businessDay: 1,
    dayEndSnapshotId: 'day-end-1',
    eventCount: 2,
    expected: { eventHash: goldenEventHash, snapshotHash: goldenSnapshotHash },
    computed: { eventHash: goldenEventHash, snapshotHash: goldenSnapshotHash },
    status: 'MATCH',
  });

  const mismatch = await createDayReplayEvidenceVerification({
    restaurantId: 'restaurant-a',
    saveId: 'save-a',
    businessDay: 1,
    rule: dayReplayRule,
    catalogs: [],
    replayPayload: dayReplayJob().replayPayload,
    dayReplaySource: dayReplaySource({ ...goldenFixedFieldSnapshot, cashAfter: money('13399') }),
  });
  assert.equal(mismatch.status, 'MISMATCH');
  assert.equal((mismatch.expected as JsonObject).snapshotHash, goldenSnapshotHash);
  assert.notEqual((mismatch.computed as JsonObject).snapshotHash, goldenSnapshotHash);
});

test('E05 DAY_REPLAY permanently rejects tampered locators and corrupt or missing sources', async () => {
  const tamperedReplay = dayReplayJob();
  const tamperedPayload = {
    ...tamperedReplay.replayPayload,
    locator: {
      ...(tamperedReplay.replayPayload.locator as JsonObject),
      eventHash: '0'.repeat(64),
    },
  };
  const base = {
    restaurantId: 'restaurant-a',
    saveId: 'save-a',
    businessDay: 1,
    rule: dayReplayRule,
    catalogs: [],
  } as const;
  await assert.rejects(
    () =>
      createDayReplayEvidenceVerification({
        ...base,
        replayPayload: tamperedPayload,
        dayReplaySource: dayReplaySource(),
      }),
    (error: unknown) =>
      error instanceof SimulationJobError &&
      error.classification === 'PERMANENT' &&
      error.code === 'DAY_REPLAY_LOCATOR_TAMPERED',
  );
  await assert.rejects(
    () =>
      createDayReplayEvidenceVerification({
        ...base,
        replayPayload: dayReplayJob().replayPayload,
        dayReplaySource: { async load() { return undefined; } },
      }),
    (error: unknown) =>
      error instanceof SimulationJobError && error.code === 'DAY_REPLAY_SOURCE_MISSING',
  );
  const corruptSource: DayReplayEvidenceSource = {
    async load(input) {
      const source = await dayReplaySource().load(input);
      assert.ok(source);
      return {
        ...source,
        events: [{ ...source.events[0]!, eventHash: 'not-a-hash' }, ...source.events.slice(1)],
      };
    },
  };
  await assert.rejects(
    () =>
      createDayReplayEvidenceVerification({
        ...base,
        replayPayload: dayReplayJob().replayPayload,
        dayReplaySource: corruptSource,
      }),
    (error: unknown) =>
      error instanceof SimulationJobError && error.code === 'DAY_REPLAY_SOURCE_CORRUPT',
  );
});

test('production outbox mapping is explicit and rejects a mismatched market identity', () => {
  const event = replayRequestEvent();
  const requestPayload = event.payload as Readonly<Record<string, unknown>>;
  assert.deepEqual(mapOutboxEventToSimulationJob(event), {
    jobId: '20000000-0000-4000-8000-000000000001',
    restaurantId: 'restaurant-a',
    saveId: 'save-a',
    sourceEventId: '10000000-0000-4000-8000-000000000001',
    jobKind: 'MARKET_TICK',
    businessKey: 'save-a:2:SUPPLY_PRICE',
    payload: replayJob('market-rule/v1'),
  });
  assert.throws(
    () =>
      mapOutboxEventToSimulationJob({
        ...event,
        payload: { ...requestPayload, businessKey: 'save-a:3:SUPPLY_PRICE' },
      }),
    (error: unknown) =>
      error instanceof SimulationJobError && error.code === 'OUTBOX_REPLAY_REQUEST_INVALID',
  );
});

test('non-monetary command causation maps securely without a fake ledger transaction', () => {
  const event = replayRequestEvent();
  assert.deepEqual(
    mapOutboxEventToSimulationJob({
      ...event,
      eventId: '10000000-0000-4000-8000-000000000009',
      transactionId: null,
      causationCommandId: '90000000-0000-4000-8000-000000000009',
    }),
    {
      jobId: '20000000-0000-4000-8000-000000000001',
      restaurantId: 'restaurant-a',
      saveId: 'save-a',
      sourceEventId: '10000000-0000-4000-8000-000000000009',
      jobKind: 'MARKET_TICK',
      businessKey: 'save-a:2:SUPPLY_PRICE',
      payload: replayJob('market-rule/v1'),
    },
  );
  assert.throws(
    () =>
      mapOutboxEventToSimulationJob({
        ...event,
        causationCommandId: 'not-a-command',
      }),
    (error: unknown) =>
      error instanceof SimulationJobError && error.code === 'OUTBOX_REPLAY_REQUEST_INVALID',
  );
});

test('poison simulation events are atomically dead-lettered and do not block the next event', async () => {
  const invalidEvent = replayRequestEvent();
  const invalidPayload = invalidEvent.payload as Readonly<Record<string, unknown>>;
  const malformed = {
    ...invalidEvent,
    eventId: '10000000-0000-4000-8000-000000000002',
    transactionId: '10000000-0000-4000-8000-000000000002',
    causationCommandId: '10000000-0000-4000-8000-000000000002',
    payload: { ...invalidPayload, businessKey: 'save-a:3:SUPPLY_PRICE' },
  };
  const valid = replayRequestEvent();
  const database = new TransactionalIngestionDatabase([malformed, valid]);
  const platform = new PostgresSimulationPlatform(database);

  assert.equal(await platform.ingestNextOutbox(), true);
  assert.deepEqual(database.counts, { receipts: 1, jobs: 0, audits: 0, deadLetters: 1 });
  assert.deepEqual(await Promise.all([platform.ingestNextOutbox(), platform.ingestNextOutbox()]), [
    true,
    false,
  ]);
  assert.deepEqual(database.counts, { receipts: 2, jobs: 1, audits: 1, deadLetters: 1 });
  assert.equal(await platform.ingestNextOutbox(), false);
});

test('unknown simulation events are auditable and transient DLQ writes are retried', async () => {
  const unknown = {
    ...replayRequestEvent(),
    eventType: 'simulation.future.requested',
  };
  const database = new TransactionalIngestionDatabase(unknown);
  const platform = new PostgresSimulationPlatform(database);
  database.failNextDeadLetterInsert = true;

  await assert.rejects(() => platform.ingestNextOutbox(), /test transient database interruption/);
  assert.deepEqual(database.counts, { receipts: 0, jobs: 0, audits: 0, deadLetters: 0 });
  assert.deepEqual(await Promise.all([platform.ingestNextOutbox(), platform.ingestNextOutbox()]), [
    true,
    false,
  ]);
  assert.deepEqual(database.counts, { receipts: 1, jobs: 0, audits: 0, deadLetters: 1 });
  assert.equal(await platform.ingestNextOutbox(), false);
});

test('reachable production ingestion atomically retries receipt plus job without duplicates', async () => {
  const database = new TransactionalIngestionDatabase(replayRequestEvent());
  const platform = new PostgresSimulationPlatform(database);
  database.failNextJobInsert = true;

  await assert.rejects(() => platform.ingestNextOutbox(), /test transaction interruption/);
  assert.deepEqual(database.counts, { receipts: 0, jobs: 0, audits: 0, deadLetters: 0 });

  assert.deepEqual(await Promise.all([platform.ingestNextOutbox(), platform.ingestNextOutbox()]), [
    true,
    false,
  ]);
  assert.deepEqual(database.counts, { receipts: 1, jobs: 1, audits: 1, deadLetters: 0 });

  assert.equal(await platform.ingestNextOutbox(), false);
  assert.deepEqual(database.counts, { receipts: 1, jobs: 1, audits: 1, deadLetters: 0 });
});

test('worker canonicalization rejects excessive depth before recursive serialization', () => {
  let nested: unknown = 'leaf';
  for (let depth = 0; depth < 40; depth += 1) nested = { nested };
  assert.throws(
    () => canonicalHash(nested),
    (error: unknown) =>
      error instanceof SimulationJobError && error.code === 'JSON_RESOURCE_LIMIT_EXCEEDED',
  );
});

test('only explicit database infrastructure codes are classified for loop retry', () => {
  assert.equal(isTransientSimulationInfrastructureError({ code: '40001' }), true);
  assert.equal(
    isTransientSimulationInfrastructureError({ code: 'P2010', meta: { code: '40P01' } }),
    true,
  );
  assert.equal(isTransientSimulationInfrastructureError(new Error('connection failed')), false);
  assert.equal(isTransientSimulationInfrastructureError({ code: '23514' }), false);
});

test('market replay is deterministic, bounded, sorted, and day one uses references', () => {
  const dayTwo = createMarketTickReplay({
    saveId: 'save-a',
    businessDay: 2,
    rule: ruleV1,
    catalogs: [catalogV1],
    replayPayload: replayJob('market-rule/v1').replayPayload,
  });
  assert.deepEqual(
    dayTwo,
    createMarketTickReplay({
      saveId: 'save-a',
      businessDay: 2,
      rule: ruleV1,
      catalogs: [catalogV1],
      replayPayload: replayJob('market-rule/v1').replayPayload,
    }),
  );
  const quotes = dayTwo.quotes as readonly Readonly<Record<string, unknown>>[];
  assert.deepEqual(
    quotes.map((quote) => quote.ingredientId),
    ['egg', 'rice'],
  );
  assert.ok(
    quotes.every(
      (quote) =>
        typeof quote.priceModifierBps === 'number' &&
        quote.priceModifierBps >= -1000 &&
        quote.priceModifierBps <= 1000,
    ),
  );

  const dayOne = createMarketTickReplay({
    saveId: 'save-a',
    businessDay: 1,
    rule: ruleV1,
    catalogs: [catalogV1],
    replayPayload: replayJob('market-rule/v1').replayPayload,
  });
  const dayOneQuotes = dayOne.quotes as readonly Readonly<Record<string, unknown>>[];
  assert.ok(dayOneQuotes.every((quote) => quote.priceModifierBps === 0));
  assert.ok(dayOneQuotes.every((quote) => quote.unitPriceMinor === quote.referenceUnitPriceMinor));

  assert.throws(
    () =>
      createMarketTickReplay({
        saveId: 'save-a',
        businessDay: 2,
        rule: ruleV1,
        catalogs: [catalogV1],
        replayPayload: { ...replayJob('market-rule/v1').replayPayload, prngCursor: 1 },
      }),
    (error: unknown) =>
      error instanceof SimulationJobError && error.code === 'MARKET_TICK_INPUT_INVALID',
  );
});

test('exact historical rule selection remains replayable after a newer version exists', async () => {
  const registry = new PostgresVersionRegistry(fakeRegistryDatabase([ruleV1, ruleV2, catalogV1]));
  const engine = new VersionedReplayEngine(registry);
  const historical = await engine.replay('save-a', replayJob('market-rule/v1'));
  const latest = await engine.replay('save-a', replayJob('market-rule/v2'));
  const historicalAgain = await engine.replay('save-a', replayJob('market-rule/v1'));

  assert.equal(historical.rule.version, 'market-rule/v1');
  assert.equal(latest.rule.version, 'market-rule/v2');
  assert.equal(historical.resultHash, historicalAgain.resultHash);
  assert.notEqual(historical.resultHash, latest.resultHash);
});

test('a missing historical version fails closed without selecting another version', async () => {
  const engine = new VersionedReplayEngine(
    new PostgresVersionRegistry(fakeRegistryDatabase([ruleV2, catalogV1])),
  );
  await assert.rejects(
    () => engine.replay('save-a', replayJob('market-rule/v1')),
    (error: unknown) =>
      error instanceof SimulationJobError &&
      error.classification === 'PERMANENT' &&
      error.code === 'REPLAY_VERSION_MISSING',
  );
});
