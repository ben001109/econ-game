import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ActiveGameplaySaveDiscovery,
  GameplayProjection,
  ReplayJobPollResponse,
} from '@econ-game/sdk';

import {
  stateFromProjection,
  stateFromReplayJob,
  type AnyGameplayRecoveryRecord,
  type WebGameplayTransport,
} from '../lib/gameplay-machine.js';
import {
  type GameplayRecoveryStore,
  WebGameplayRuntime,
} from '../lib/gameplay-runtime.js';

const hash = 'a'.repeat(64);

test('all server projection phases map to exactly one visible gameplay state', () => {
  const expected = {
    CONFIGURE_REQUIRED: 'configure',
    OPEN_REQUIRED: 'open',
    ADVANCE_REQUIRED: 'advance',
    SETTLE_REQUIRED: 'settle',
    REPLAY_AVAILABLE: 'replay',
  } as const;

  for (const [phase, tag] of Object.entries(expected)) {
    assert.equal(stateFromProjection(projection(phase as keyof typeof expected)).tag, tag);
  }
});

test('EMPTY_PREMISES is non-playable until an equipment path exists', () => {
  assert.deepEqual(stateFromProjection(projection('CONFIGURE_REQUIRED', 'EMPTY_PREMISES')), {
    tag: 'incompatible',
    reason: 'EMPTY_PREMISES_EQUIPMENT_PATH_REQUIRED',
  });
});

test('missing and failed token acquisition fail closed without creating a client or persisting', async () => {
  for (const getAccessToken of [
    async () => undefined,
    async () => {
      throw new Error('identity unavailable');
    },
  ]) {
    const recovery = new MemoryRecoveryStore();
    let clients = 0;
    const runtime = new WebGameplayRuntime({
      getAccessToken,
      createClient: () => {
        clients += 1;
        return client({});
      },
      recoveryStore: recovery,
    });

    const state = await runtime.discover();
    assert.equal(state.tag, 'auth-unavailable');
    assert.equal(clients, 0);
    assert.equal(recovery.writes.length, 0);
  }
});

test('network failure neither auto-retries nor changes the exact persisted request', async () => {
  const recovery = new MemoryRecoveryStore();
  const calls: unknown[] = [];
  let attempts = 0;
  const runtime = runtimeFor({
    recovery,
    transport: client({
      getActiveSave: async () => active(projection('CONFIGURE_REQUIRED')),
      configurePreopenDay: async (_saveId, input) => {
        calls.push(input);
        attempts += 1;
        if (attempts === 1) throw new Error('ambiguous network failure');
        return completedReceipt();
      },
      getGameplayProjection: async () => projection('OPEN_REQUIRED'),
    }),
  });
  await runtime.discover();
  const input = configureInput();
  const failed = await runtime.configure(input);
  assert.equal(failed.tag, 'failure');
  assert.equal(failed.retry, 'retry-same-request');
  assert.equal(attempts, 1);
  assert.equal(recovery.writes.at(-1)?.stage, 'MUTATION_UNCONFIRMED');
  assert.deepEqual(recovery.writes.at(-1)?.mutation?.input, input);

  const restored = await runtime.restore();
  assert.equal(restored.tag, 'failure');
  assert.equal(attempts, 1, 'restore must not retry a mutation');

  const retried = await runtime.retryLastMutation();
  assert.equal(retried.tag, 'open');
  assert.equal(attempts, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(recovery.current, undefined);
});

test('401, 403, 404, 409, 422, 503, and network errors use their fail-closed transitions', async () => {
  const cases = [
    { status: 401, tag: 'auth-unavailable', retry: undefined, retained: true },
    { status: 403, tag: 'auth-unavailable', retry: undefined, retained: true },
    { status: 404, tag: 'incompatible', retry: undefined, retained: false },
    { status: 422, tag: 'failure', retry: 'none', retained: false },
    { status: 503, tag: 'failure', retry: 'retry-same-request', retained: true },
    { status: undefined, tag: 'failure', retry: 'retry-same-request', retained: true },
  ] as const;

  for (const item of cases) {
    const recovery = new MemoryRecoveryStore();
    const runtime = runtimeFor({
      recovery,
      transport: client({
        getActiveSave: async () => active(projection('CONFIGURE_REQUIRED')),
        configurePreopenDay: async () => {
          throw item.status === undefined ? new Error('network') : new StatusError(item.status);
        },
      }),
    });
    await runtime.discover();
    const state = await runtime.configure(configureInput());
    assert.equal(state.tag, item.tag, `status ${item.status}`);
    if (state.tag === 'failure') assert.equal(state.retry, item.retry);
    assert.equal(recovery.current !== undefined, item.retained);
  }

  const conflictRecovery = new MemoryRecoveryStore();
  let refreshed = 0;
  const conflict = runtimeFor({
    recovery: conflictRecovery,
    transport: client({
      getActiveSave: async () => active(projection('CONFIGURE_REQUIRED')),
      configurePreopenDay: async () => {
        throw new StatusError(409, 'EXPECTED_VERSION_CONFLICT');
      },
      getGameplayProjection: async () => {
        refreshed += 1;
        return projection('OPEN_REQUIRED');
      },
    }),
  });
  await conflict.discover();
  const state = await conflict.configure(configureInput());
  assert.equal(state.tag, 'open');
  assert.equal(refreshed, 1);
  assert.equal(conflictRecovery.current, undefined);
});

test('replay polling preserves only public locators and reaches terminal match or mismatch', async () => {
  const recovery = new MemoryRecoveryStore();
  const hiddenToken = 'hidden-token-never-persisted';
  const runtime = runtimeFor({
    recovery,
    token: hiddenToken,
    transport: client({
      getActiveSave: async () => active(projection('REPLAY_AVAILABLE')),
      requestDayReplay: async () => acceptedReplayReceipt('replay-job-1'),
      pollReplayJob: async () => matchResponse('replay-job-1'),
    }),
  });
  await runtime.discover();
  const queued = await runtime.requestReplay(replayInput());
  assert.equal(queued.tag, 'polling');
  assert.deepEqual(recovery.current, {
    schemaVersion: 'web-gameplay-recovery/v1',
    stage: 'REPLAY_POLL_REQUIRED',
    replay: { saveId: 'save-1', jobId: 'replay-job-1' },
  });
  assert.doesNotMatch(JSON.stringify(recovery.writes), new RegExp(hiddenToken));

  const matched = await runtime.pollReplay();
  assert.equal(matched.tag, 'match');
  assert.equal(recovery.current, undefined);

  const mismatched = stateFromReplayJob('save-1', {
    ...matchResponse('replay-job-2').body,
    status: 'MISMATCH',
  });
  assert.equal(mismatched.tag, 'mismatch');
});

test('recovered mutations must match freshly discovered save, version, phase, and pinned snapshot', async () => {
  const inputs = [
    Object.freeze({
      kind: 'CONFIGURE_PREOPEN_DAY' as const,
      saveId: 'other-save',
      input: configureInput(),
    }),
    Object.freeze({
      kind: 'CONFIGURE_PREOPEN_DAY' as const,
      saveId: 'save-1',
      input: { ...configureInput(), expectedVersion: 6 },
    }),
    Object.freeze({
      kind: 'OPEN_BUSINESS_DAY' as const,
      saveId: 'save-1',
      input: {
        commandId: 'open-command-1',
        idempotencyKey: 'open-key-1',
        expectedVersion: 7,
        payload: { preopenSnapshotId: 'preopen-1', preopenSnapshotHash: 'b'.repeat(64) },
      },
    }),
  ];

  for (const mutation of inputs) {
    const recovery = new MemoryRecoveryStore();
    recovery.write({
      schemaVersion: 'web-gameplay-recovery/v1',
      stage: 'MUTATION_UNCONFIRMED',
      mutation,
    });
    let dispatched = 0;
    const runtime = runtimeFor({
      recovery,
      transport: client({
        getActiveSave: async () => active(
          mutation.kind === 'OPEN_BUSINESS_DAY'
            ? projection('OPEN_REQUIRED')
            : projection('CONFIGURE_REQUIRED'),
        ),
        configurePreopenDay: async () => {
          dispatched += 1;
          return completedReceipt();
        },
        openBusinessDay: async () => {
          dispatched += 1;
          return completedReceipt();
        },
      }),
    });
    const state = await runtime.retryLastMutation();
    assert.equal(state.tag, 'failure');
    assert.equal(state.code, 'RECOVERY_INVALID');
    assert.equal(dispatched, 0);
    assert.equal(recovery.current, undefined);
  }
});

test('strict recovery decode rejects unknown and secret fields before any action', async () => {
  const recovery = new MemoryRecoveryStore();
  recovery.current = {
    schemaVersion: 'web-gameplay-recovery/v1',
    stage: 'MUTATION_UNCONFIRMED',
    mutation: {
      kind: 'CONFIGURE_PREOPEN_DAY',
      saveId: 'save-1',
      input: configureInput(),
      accessToken: 'forged-secret',
    },
  };
  let calls = 0;
  const runtime = runtimeFor({
    recovery,
    transport: client({
      getActiveSave: async () => {
        calls += 1;
        return active(projection('CONFIGURE_REQUIRED'));
      },
    }),
  });
  const state = await runtime.restore();
  assert.equal(state.tag, 'failure');
  assert.equal(state.code, 'RECOVERY_INVALID');
  assert.equal(calls, 0);
  assert.equal(recovery.current, undefined);
});

test('malformed discovery, projection, and replay responses become incompatible before actions', async () => {
  const malformedDiscovery = runtimeFor({
    transport: client({ getActiveSave: async () => ({ schemaVersion: 'wrong' }) as never }),
  });
  assert.equal((await malformedDiscovery.discover()).tag, 'incompatible');

  const malformedProjection = runtimeFor({
    transport: client({
      getActiveSave: async () => active(projection('CONFIGURE_REQUIRED')),
      configurePreopenDay: async () => completedReceipt(),
      getGameplayProjection: async () => ({ phase: 'OPEN_REQUIRED' }) as never,
    }),
  });
  await malformedProjection.discover();
  assert.equal((await malformedProjection.configure(configureInput())).tag, 'incompatible');

  const malformedReplay = runtimeFor({
    transport: client({
      getActiveSave: async () => active(projection('REPLAY_AVAILABLE')),
      requestDayReplay: async () => acceptedReplayReceipt('job-malformed'),
      pollReplayJob: async () => ({ status: 200, body: { terminal: true } }) as never,
    }),
  });
  await malformedReplay.discover();
  await malformedReplay.requestReplay(replayInput());
  assert.equal((await malformedReplay.pollReplay()).tag, 'incompatible');
});

function runtimeFor(options: {
  transport: WebGameplayTransport;
  recovery?: MemoryRecoveryStore;
  token?: string;
}): WebGameplayRuntime {
  return new WebGameplayRuntime({
    getAccessToken: async () => options.token ?? 'web-access-token',
    createClient: () => options.transport,
    recoveryStore: options.recovery,
  });
}

function projection(
  phase: 'CONFIGURE_REQUIRED' | 'OPEN_REQUIRED' | 'ADVANCE_REQUIRED' | 'SETTLE_REQUIRED' | 'REPLAY_AVAILABLE',
  openingScenario = 'DEFAULT_SMALL_SHOP',
): GameplayProjection {
  const nextCommand = {
    CONFIGURE_REQUIRED: 'CONFIGURE_PREOPEN_DAY',
    OPEN_REQUIRED: 'OPEN_BUSINESS_DAY',
    ADVANCE_REQUIRED: 'ADVANCE_SERVICE_PERIOD',
    SETTLE_REQUIRED: 'SETTLE_BUSINESS_DAY',
    REPLAY_AVAILABLE: 'REQUEST_DAY_REPLAY',
  } as const;
  const businessDay = phase === 'CONFIGURE_REQUIRED'
    ? null
    : {
        businessDay: 1 as const,
        status: phase === 'OPEN_REQUIRED' ? 'PREOPEN' as const : phase === 'ADVANCE_REQUIRED' ? 'OPEN' as const : phase === 'SETTLE_REQUIRED' ? 'SERVICE_COMPLETE' as const : 'SETTLED' as const,
        simulationRuleVersion: 'mvp-e02-v1',
        completedServicePeriods:
          phase === 'ADVANCE_REQUIRED' || phase === 'OPEN_REQUIRED' ? 0 : 2,
        totalServicePeriods: 2 as const,
        nextPeriodKey: phase === 'ADVANCE_REQUIRED' ? 'LUNCH' as const : null,
      };
  return {
    schemaVersion: 'gameplay.current-projection/v1',
    save: {
      id: 'save-1',
      aggregateVersion: 7,
      openingScenario,
      operatingMode: 'STRATEGY',
      servicePeriodPlan: 'TWO_PERIODS',
      difficultyGroup: 'DEFAULT',
      simulationRuleVersion: 'mvp-e02-v1',
    },
    phase,
    nextCommand: nextCommand[phase],
    expectedVersion: 7,
    ...(phase === 'OPEN_REQUIRED' ? { preopenSnapshot: { id: 'preopen-1', hash } } : {}),
    businessDay,
    dayEnd: phase === 'REPLAY_AVAILABLE'
      ? { businessDay: 1 as const, dayEndSnapshotId: 'day-end-1', eventHash: hash, snapshotHash: hash }
      : null,
  };
}

function active(value: GameplayProjection): ActiveGameplaySaveDiscovery {
  return {
    schemaVersion: 'gameplay.active-save-discovery/v1',
    state: 'ACTIVE_SAVE',
    bootstrap: null,
    activeSave: value,
  };
}

function configureInput() {
  return {
    commandId: 'configure-command-1',
    idempotencyKey: 'configure-key-1',
    expectedVersion: 7,
    payload: {
      menuChoice: {
        themeId: 'bistro',
        recipeVersionIds: ['bistro-omelet/v1'],
        priceModifierPercentByRecipe: { 'bistro-omelet/v1': 0 },
        enabledSubstitutionIds: [],
      },
      floorPlan: {
        width: 2,
        height: 2,
        servicePoint: { x: 0, y: 0 },
        fixtures: [],
      },
      spotPurchaseDeltas: [],
    },
  } as const;
}

function replayInput() {
  return {
    commandId: 'replay-command-1',
    idempotencyKey: 'replay-key-1',
    expectedVersion: 7,
    payload: { businessDay: 1 },
  } as const;
}

function completedReceipt() {
  return {
    commandId: 'configure-command-1',
    idempotencyKey: 'configure-key-1',
    commandType: 'CONFIGURE_PREOPEN_DAY',
    aggregateId: 'save-1',
    aggregateVersion: 8,
    result: {},
  } as never;
}

function acceptedReplayReceipt(jobId: string) {
  return {
    commandId: 'replay-command-1',
    idempotencyKey: 'replay-key-1',
    commandType: 'REQUEST_DAY_REPLAY',
    aggregateId: 'save-1',
    aggregateVersion: 8,
    result: {},
    jobId,
  } as never;
}

function matchResponse(jobId: string): ReplayJobPollResponse {
  return {
    status: 200,
    body: {
      schemaVersion: 'gameplay.replay-job/v1',
      jobId,
      saveId: 'save-1',
      businessDay: 1,
      status: 'MATCH',
      terminal: true,
      verification: {
        eventCount: 3,
        eventHash: { expected: hash, computed: hash, match: true },
        snapshotHash: { expected: hash, computed: hash, match: true },
      },
    },
  };
}

function client(overrides: Partial<WebGameplayTransport>): WebGameplayTransport {
  const unavailable = async (): Promise<never> => {
    throw new Error('unexpected transport call');
  };
  return {
    initializeCompetitiveSave: unavailable,
    getActiveSave: unavailable,
    getGameplayProjection: unavailable,
    getPreopenConfigurationChoices: unavailable,
    pollReplayJob: unavailable,
    configurePreopenDay: unavailable,
    openBusinessDay: unavailable,
    advanceServicePeriod: unavailable,
    settleBusinessDay: unavailable,
    requestDayReplay: unavailable,
    ...overrides,
  };
}

class MemoryRecoveryStore implements GameplayRecoveryStore {
  current: unknown | undefined;
  readonly writes: AnyGameplayRecoveryRecord[] = [];

  read(): unknown | undefined {
    return this.current;
  }

  write(record: AnyGameplayRecoveryRecord): void {
    this.current = JSON.parse(JSON.stringify(record)) as AnyGameplayRecoveryRecord;
    this.writes.push(this.current);
  }

  clear(): void {
    this.current = undefined;
  }
}

class StatusError extends Error {
  constructor(readonly status: number, readonly code = `HTTP_${status}`) {
    super(code);
  }
}
