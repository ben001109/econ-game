import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandError } from '../commands/command-contract.js';
import type { D03Database } from '../domains/ledger/postgres-ledger-store.js';
import { PrismaGameplayReadModelRepository } from './gameplay-read-model.js';

const jobId = '20000000-0000-4000-8000-000000000001';

type FakeState = {
  bootstrapRows: unknown[];
  saveRows: unknown[];
  dayRows: unknown[];
  countRows: unknown[];
  dayEndRows: unknown[];
  preopenSnapshotRows: unknown[];
  replayRows: unknown[];
  latestReplayRows: unknown[];
  queries: string[];
};

function save(id = 'save-1') {
  return {
    id,
    restaurantId: 'restaurant-1',
    membershipId: 'membership-1',
    role: 'OWNER',
    version: 4,
    openingScenario: 'DEFAULT_SMALL_SHOP',
    operatingMode: 'STRATEGY',
    servicePeriodPlan: 'TWO_PERIODS',
    difficultyGroup: 'STANDARD',
    simulationRuleVersion: 'mvp-e01-v1',
  };
}

function subject(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    bootstrapRows: [{ version: 1 }],
    saveRows: [save()],
    dayRows: [],
    countRows: [{ completedCount: 0n }],
    dayEndRows: [],
    preopenSnapshotRows: [],
    replayRows: [],
    latestReplayRows: [],
    queries: [],
    ...overrides,
  };
  const queryable = {
    async $queryRawUnsafe<T>(query: string): Promise<T> {
      state.queries.push(query);
      if (query.includes('/* gameplay-read:bootstrap-version */')) return state.bootstrapRows as T;
      if (query.includes('/* gameplay-read:scoped-save */')) return state.saveRows as T;
      if (query.includes('/* gameplay-read:business-day */')) return state.dayRows as T;
      if (query.includes('/* gameplay-read:service-period-count */')) return state.countRows as T;
      if (query.includes('/* gameplay-read:day-end */')) return state.dayEndRows as T;
      if (query.includes('/* gameplay-read:preopen-snapshot-pin */')) return state.preopenSnapshotRows as T;
      if (query.includes('/* gameplay-read:latest-replay-job */')) return state.latestReplayRows as T;
      if (query.includes('/* gameplay-read:replay-job */')) return state.replayRows as T;
      throw new Error('unexpected query');
    },
  };
  const database: D03Database = {
    async $transaction<T>(operation: (transaction: typeof queryable) => Promise<T>): Promise<T> {
      return operation(queryable);
    },
  };
  return { state, repository: new PrismaGameplayReadModelRepository(database) };
}

function commandError(status: number, code: string) {
  return (error: unknown) =>
    error instanceof CommandError && error.status === status && error.code === code;
}

function dayReplayInput(saveId = 'save-1', businessDay = 1) {
  return {
    schemaVersion: 'd03-versioned-replay-job/v1',
    replayKind: 'DAY_REPLAY',
    businessDay,
    rule: { kind: 'RULE', key: 'DAY_REPLAY_EVIDENCE', version: 'mvp-release-evidence-v1' },
    catalogs: [],
    replayPayload: {
      schemaVersion: 'p0-day-replay-locator/v1',
      locator: {
        businessDay,
        dayEndSnapshotId: 'day-end-1',
        eventHash: 'a'.repeat(64),
        saveId,
        snapshotHash: 'b'.repeat(64),
      },
    },
  };
}

function latestReplayRow(overrides: Readonly<Record<string, unknown>> = {}) {
  const inputPayload = dayReplayInput();
  return {
    id: jobId,
    status: 'PENDING',
    errorClass: null,
    businessDay: 1,
    businessKey: 'save-1:1:DAY_REPLAY',
    inputPayload,
    sourceEventType: 'simulation.versioned-replay.requested',
    sourceEventVersion: 1,
    sourcePayload: {
      schemaVersion: 'd03-versioned-replay-request/v1',
      businessKey: 'save-1:1:DAY_REPLAY',
      jobId,
      jobKind: 'VERSIONED_REPLAY',
      replay: inputPayload,
    },
    replayExecutionId: null,
    replayKind: null,
    replayBusinessDay: null,
    resultPayload: null,
    ...overrides,
  };
}

test('durable discovery rejects ambiguous active saves instead of choosing authority', async () => {
  const { repository } = subject({ saveRows: [save('save-1'), save('save-2')] });
  await assert.rejects(
    () => repository.discoverActiveSave('player-1'),
    commandError(409, 'ACTIVE_SAVE_SELECTION_REQUIRED'),
  );
});

test('durable scope query excludes revoked membership and retired saves and returns no projection', async () => {
  const { repository, state } = subject({ saveRows: [] });
  assert.equal(await repository.loadCurrentProjection('player-1', 'save-1'), undefined);
  const query = state.queries.find((entry) =>
    entry.includes('/* gameplay-read:scoped-save */'),
  );
  assert.ok(query);
  assert.match(query, /membership\."playerId" = \$1/);
  assert.match(query, /membership\."revokedAt" IS NULL/);
  assert.match(query, /save\."retiredAt" IS NULL/);
  assert.match(query, /save\."id" = \$2/);
});

test('durable projection rejects impossible phase and service-period counts', async () => {
  for (const [status, completedCount] of [
    ['PREOPEN', 1n],
    ['OPEN', 2n],
    ['SERVICE_COMPLETE', 1n],
    ['SETTLED', 1n],
  ] as const) {
    const { repository } = subject({
      dayRows: [{ businessDay: 1, status, simulationRuleVersion: 'mvp-e01-v1' }],
      countRows: [{ completedCount }],
    });
    await assert.rejects(
      () => repository.loadCurrentProjection('player-1', 'save-1'),
      commandError(503, 'GAMEPLAY_PROJECTION_UNAVAILABLE'),
      `${status}:${completedCount}`,
    );
  }
});

test('durable projection exposes only the immutable pre-open id/hash pin while OPEN is required', async () => {
  const { repository, state } = subject({
    dayRows: [{ businessDay: 1, status: 'PREOPEN', simulationRuleVersion: 'mvp-e01-v1' }],
    preopenSnapshotRows: [{ id: 'preopen-1', snapshotHash: 'a'.repeat(64) }],
  });

  const scoped = await repository.loadCurrentProjection('player-1', 'save-1');
  assert.deepEqual(scoped?.projection.preopenSnapshot, {
    id: 'preopen-1',
    hash: 'a'.repeat(64),
  });
  assert.equal(scoped?.projection.phase, 'OPEN_REQUIRED');
  const pinQuery = state.queries.find((query) =>
    query.includes('/* gameplay-read:preopen-snapshot-pin */'),
  );
  assert.ok(pinQuery);
  assert.match(pinQuery, /SELECT snapshot\."id", snapshot\."snapshotHash"/);
  for (const privateColumn of ['payload', 'demandSeed', 'marketSeed', 'inventory']) {
    assert.equal(pinQuery.includes(privateColumn), false, privateColumn);
  }
});

test('durable projection omits the pre-open pin outside OPEN_REQUIRED and fails closed on a malformed pin', async () => {
  const configured = subject({
    dayRows: [{ businessDay: 1, status: 'PREOPEN', simulationRuleVersion: 'mvp-e01-v1' }],
    preopenSnapshotRows: [{ id: 'preopen-1', snapshotHash: 'not-a-hash' }],
  });
  await assert.rejects(
    () => configured.repository.loadCurrentProjection('player-1', 'save-1'),
    commandError(503, 'GAMEPLAY_PROJECTION_UNAVAILABLE'),
  );

  const opened = subject({
    dayRows: [{ businessDay: 1, status: 'OPEN', simulationRuleVersion: 'mvp-e01-v1' }],
    countRows: [{ completedCount: 0n }],
    preopenSnapshotRows: [{ id: 'preopen-1', snapshotHash: 'a'.repeat(64) }],
  });
  const scoped = await opened.repository.loadCurrentProjection('player-1', 'save-1');
  assert.equal(Object.hasOwn(scoped?.projection ?? {}, 'preopenSnapshot'), false);
  assert.equal(
    opened.state.queries.some((query) => query.includes('/* gameplay-read:preopen-snapshot-pin */')),
    false,
  );
});

test('durable replay projection rejects malformed or self-contradictory worker results', async () => {
  for (const resultPayload of [
    { schemaVersion: 'wrong', businessDay: 1, status: 'MATCH' },
    {
      schemaVersion: 'e05-day-replay-verification/v1',
      businessDay: 1,
      eventCount: 1,
      expected: { eventHash: 'a'.repeat(64), snapshotHash: 'b'.repeat(64) },
      computed: { eventHash: 'a'.repeat(64), snapshotHash: 'c'.repeat(64) },
      status: 'MATCH',
    },
  ]) {
    const { repository } = subject({
      replayRows: [
        {
          id: jobId,
          status: 'SUCCEEDED',
          errorClass: null,
          businessDay: 1,
          resultPayload,
        },
      ],
    });
    await assert.rejects(
      () => repository.loadReplayJob('player-1', 'save-1', jobId),
      commandError(503, 'GAMEPLAY_PROJECTION_UNAVAILABLE'),
    );
  }
});

test('durable replay projection follows exact D03 retry and terminal status combinations', async () => {
  async function project(status: string, errorClass: string | null) {
    const { repository } = subject({
      replayRows: [{ id: jobId, status, errorClass, businessDay: 1, resultPayload: null }],
    });
    return repository.loadReplayJob('player-1', 'save-1', jobId);
  }

  assert.equal((await project('PENDING', null))?.projection.status, 'QUEUED');
  assert.equal((await project('PENDING', 'TRANSIENT'))?.projection.status, 'RETRYING');
  assert.equal((await project('RUNNING', 'TRANSIENT'))?.projection.status, 'RUNNING');
  assert.equal((await project('FAILED', 'PERMANENT'))?.projection.status, 'PERMANENT_FAILURE');
  assert.equal(
    (await project('DEAD_LETTER', 'TRANSIENT'))?.projection.status,
    'RETRY_EXHAUSTED',
  );

  for (const [status, errorClass] of [
    ['PENDING', 'PERMANENT'],
    ['FAILED', 'TRANSIENT'],
    ['FAILED', null],
    ['DEAD_LETTER', 'PERMANENT'],
    ['DEAD_LETTER', null],
    ['SUCCEEDED', 'TRANSIENT'],
  ] as const) {
    await assert.rejects(
      () => project(status, errorClass),
      commandError(503, 'GAMEPLAY_PROJECTION_UNAVAILABLE'),
      `${status}:${errorClass}`,
    );
  }
});

test('latest replay recovery is a read-only, scoped and source-linked DAY_REPLAY lookup', async () => {
  const { repository, state } = subject({ latestReplayRows: [latestReplayRow()] });
  const result = await repository.loadLatestReplayJob('player-1', 'save-1', 1);
  assert.equal(result?.httpStatus, 202);
  assert.deepEqual(result?.projection, {
    schemaVersion: 'gameplay.replay-job/v1',
    jobId,
    saveId: 'save-1',
    businessDay: 1,
    status: 'QUEUED',
    terminal: false,
  });

  const query = state.queries.find((entry) =>
    entry.includes('/* gameplay-read:latest-replay-job */'),
  );
  assert.ok(query);
  assert.match(query, /JOIN "OutboxEvent" source/);
  assert.match(query, /job\."jobKind" = 'VERSIONED_REPLAY'/);
  assert.match(query, /job\."businessKey" = \$3/);
  assert.match(query, /ORDER BY job\."createdAt" DESC, job\."id" ASC/);
  assert.match(query, /LIMIT 2/);
  assert.doesNotMatch(query, /\b(?:INSERT|UPDATE|DELETE)\b/);
});

test('latest replay recovery projects the same exact safe terminal union', async () => {
  const verification = {
    schemaVersion: 'e05-day-replay-verification/v1',
    businessDay: 1,
    eventCount: 3,
    expected: { eventHash: 'a'.repeat(64), snapshotHash: 'b'.repeat(64) },
    computed: { eventHash: 'a'.repeat(64), snapshotHash: 'b'.repeat(64) },
    status: 'MATCH',
  };
  const succeeded = subject({
    latestReplayRows: [
      latestReplayRow({
        status: 'SUCCEEDED',
        replayExecutionId: jobId,
        replayKind: 'DAY_REPLAY',
        replayBusinessDay: 1,
        resultPayload: verification,
      }),
    ],
  });
  const matched = await succeeded.repository.loadLatestReplayJob('player-1', 'save-1', 1);
  assert.equal(matched?.httpStatus, 200);
  assert.equal(matched?.projection.status, 'MATCH');
  assert.equal(Object.hasOwn(matched?.projection ?? {}, 'failure'), false);

  const failed = subject({
    latestReplayRows: [latestReplayRow({ status: 'FAILED', errorClass: 'PERMANENT' })],
  });
  const permanent = await failed.repository.loadLatestReplayJob('player-1', 'save-1', 1);
  assert.deepEqual(permanent?.projection, {
    schemaVersion: 'gameplay.replay-job/v1',
    jobId,
    saveId: 'save-1',
    businessDay: 1,
    status: 'PERMANENT_FAILURE',
    terminal: true,
    failure: { retryable: false, category: 'PERMANENT' },
  });
  assert.equal(JSON.stringify(permanent).includes('errorDetails'), false);
});

test('latest replay recovery returns no job for revoked or unavailable scope and never queries jobs', async () => {
  const { repository, state } = subject({ saveRows: [], latestReplayRows: [latestReplayRow()] });
  assert.equal(await repository.loadLatestReplayJob('player-1', 'save-1', 1), undefined);
  assert.equal(
    state.queries.some((entry) => entry.includes('/* gameplay-read:latest-replay-job */')),
    false,
  );
});

test('latest replay recovery fails closed for duplicate, unlinked, or cross-day candidates', async () => {
  const duplicate = subject({
    latestReplayRows: [
      latestReplayRow(),
      latestReplayRow({ id: '30000000-0000-4000-8000-000000000003' }),
    ],
  });
  await assert.rejects(
    () => duplicate.repository.loadLatestReplayJob('player-1', 'save-1', 1),
    commandError(409, 'DAY_REPLAY_JOB_SELECTION_REQUIRED'),
  );

  for (const row of [
    latestReplayRow({ sourceEventType: 'simulation.other' }),
    latestReplayRow({ businessDay: 2 }),
    latestReplayRow({ replayExecutionId: 'unexpected' }),
    latestReplayRow({
      sourcePayload: {
        schemaVersion: 'd03-versioned-replay-request/v1',
        businessKey: 'save-1:1:DAY_REPLAY',
        jobId,
        jobKind: 'VERSIONED_REPLAY',
        replay: dayReplayInput('save-other'),
      },
    }),
    latestReplayRow({
      sourcePayload: {
        schemaVersion: 'd03-versioned-replay-request/v1',
        businessKey: 'save-1:1:DAY_REPLAY',
        jobId,
        jobKind: 'VERSIONED_REPLAY',
        replay: {
          ...dayReplayInput(),
          replayPayload: {
            schemaVersion: 'p0-day-replay-locator/v1',
            locator: {
              ...dayReplayInput().replayPayload.locator,
              snapshotHash: 'c'.repeat(64),
            },
          },
        },
      },
    }),
  ]) {
    const invalid = subject({ latestReplayRows: [row] });
    await assert.rejects(
      () => invalid.repository.loadLatestReplayJob('player-1', 'save-1', 1),
      commandError(503, 'GAMEPLAY_PROJECTION_UNAVAILABLE'),
    );
  }
});
