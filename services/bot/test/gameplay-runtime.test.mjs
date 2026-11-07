import assert from 'node:assert/strict';
import test from 'node:test';

import { createGameplayApiClient } from '../../../packages/econ-game-sdk/dist/index.js';

import { BotGameplayRuntime, BotGameplayRuntimeError } from '../dist/test-only/gameplay-runtime.js';

const hash = 'a'.repeat(64);
const interaction = Object.freeze({
  discordUserId: 'discord-user-1',
  interactionId: 'discord-interaction-1',
});

test('status sends only trusted Bot audit headers and returns a redacted display', async () => {
  let clientOptions;
  const runtime = runtimeFor({
    createClient(options) {
      clientOptions = options;
      return clientFor({});
    },
  });

  const display = await runtime.status(interaction);
  const headers = new Headers(clientOptions.headers);
  assert.equal(headers.get('authorization'), 'Bot service-credential');
  assert.equal(headers.get('x-discord-user-id'), interaction.discordUserId);
  assert.equal(headers.get('x-discord-interaction-id'), interaction.interactionId);
  assert.equal(headers.get('x-correlation-id'), interaction.interactionId);
  assert.deepEqual([...headers.keys()].sort(), [
    'authorization',
    'x-correlation-id',
    'x-discord-interaction-id',
    'x-discord-user-id',
  ]);
  assert.deepEqual(display, {
    kind: 'status',
    phase: 'OPEN_REQUIRED',
    nextAction: 'OPEN_BUSINESS_DAY',
    aggregateVersion: 4,
    businessDay: {
      status: 'PREOPEN',
      completedServicePeriods: 0,
      totalServicePeriods: 2,
      nextPeriodKey: null,
    },
  });
  assertSafeDisplay(display);
});

test('runtime and canonical SDK compose into the exact Bot HTTP command boundary', async () => {
  let commandRequest;
  const runtime = runtimeFor({
    createClient(options) {
      return createGameplayApiClient({
        ...options,
        fetch: async (url, init) => {
          const pathname = new URL(String(url)).pathname;
          if (pathname === '/gameplay/active-save') {
            return json(active(projection('OPEN_REQUIRED')));
          }
          if (pathname === '/saves/save-1/gameplay') {
            return json(projection('OPEN_REQUIRED'));
          }
          commandRequest = { url: String(url), init };
          return json({ error: { version: 'd02-command-error/v1', code: 'COMMAND_INVALID' } }, 422);
        },
      });
    },
  });

  const display = await runtime.open(interaction);
  assert.equal(display.kind, 'failure');
  assert.equal(display.code, 'COMMAND_INVALID');
  const headers = new Headers(commandRequest.init.headers);
  assert.equal(headers.get('authorization'), 'Bot service-credential');
  assert.equal(headers.get('x-discord-user-id'), interaction.discordUserId);
  assert.equal(headers.get('x-discord-interaction-id'), interaction.interactionId);
  const envelope = JSON.parse(commandRequest.init.body);
  assert.deepEqual(envelope, {
    schemaVersion: 'd02-command/v1',
    commandId: 'runtime-command-1',
    idempotencyKey: interaction.interactionId,
    commandType: 'OPEN_BUSINESS_DAY',
    aggregateId: 'save-1',
    expectedVersion: 4,
    payload: { preopenSnapshotId: 'preopen-1', preopenSnapshotHash: hash },
  });
  assert.equal(
    commandRequest.url,
    'https://api.example.test/saves/save-1/actions/OPEN_BUSINESS_DAY',
  );
});

test('open derives save, version, and snapshot pins and uses interaction idempotency', async () => {
  let captured;
  let reads = 0;
  const runtime = runtimeFor({
    client: clientFor({
      async getGameplayProjection() {
        reads += 1;
        return reads === 1 ? projection('OPEN_REQUIRED') : projection('ADVANCE_REQUIRED', 5);
      },
      async openBusinessDay(saveId, input) {
        captured = { saveId, input };
        return completedReceipt('OPEN_BUSINESS_DAY', 5);
      },
    }),
  });

  const display = await runtime.open(interaction);
  assert.deepEqual(captured, {
    saveId: 'save-1',
    input: {
      commandId: 'runtime-command-1',
      idempotencyKey: interaction.interactionId,
      expectedVersion: 4,
      payload: { preopenSnapshotId: 'preopen-1', preopenSnapshotHash: hash },
    },
  });
  assert.equal(display.kind, 'status');
  for (const forbidden of [
    'actor',
    'actorId',
    'playerId',
    'tenant',
    'tenantId',
    'roles',
    'scope',
  ]) {
    assert.equal(JSON.stringify(captured).includes(`"${forbidden}"`), false);
  }
});

test('advance accepts only owner assignment and derives day, period, save, and version', async () => {
  let captured;
  let reads = 0;
  const runtime = runtimeFor({
    client: clientFor({
      async getActiveSave() {
        return active(projection('ADVANCE_REQUIRED'));
      },
      async getGameplayProjection() {
        reads += 1;
        return reads === 1 ? projection('ADVANCE_REQUIRED') : projection('SETTLE_REQUIRED', 5);
      },
      async advanceServicePeriod(saveId, input) {
        captured = { saveId, input };
        return completedReceipt('ADVANCE_SERVICE_PERIOD', 5);
      },
    }),
  });

  await runtime.advance(interaction, 'FRONT');
  assert.deepEqual(captured.input.payload, {
    businessDay: 1,
    expectedPeriodKey: 'LUNCH',
    ownerAssignment: 'FRONT',
  });
  assert.equal(captured.input.expectedVersion, 4);
  await assert.rejects(
    runtime.advance(interaction, 'OWNER'),
    (error) =>
      error instanceof BotGameplayRuntimeError && error.code === 'BOT_GAMEPLAY_INPUT_INVALID',
  );
});

test('phase and nextCommand gate mutations before dispatch', async () => {
  let mutations = 0;
  const runtime = runtimeFor({
    client: clientFor({
      async openBusinessDay() {
        mutations += 1;
        return completedReceipt('OPEN_BUSINESS_DAY', 5);
      },
    }),
  });
  const result = await runtime.settle(interaction);
  assert.deepEqual(result, {
    kind: 'failure',
    action: 'SETTLE_BUSINESS_DAY',
    code: 'BOT_GAMEPLAY_ACTION_UNAVAILABLE',
    resolution: 'NONE',
  });
  assert.equal(mutations, 0);
});

test('replay checks the latest job first and never creates a duplicate', async () => {
  let requests = 0;
  let latestReads = 0;
  const existing = replayResponse('existing-job', 'RUNNING');
  const runtime = runtimeFor({
    client: clientFor({
      async getActiveSave() {
        return active(projection('REPLAY_AVAILABLE'));
      },
      async getGameplayProjection() {
        return projection('REPLAY_AVAILABLE');
      },
      async getLatestReplayJob(saveId, businessDay) {
        latestReads += 1;
        assert.equal(saveId, 'save-1');
        assert.equal(businessDay, 1);
        return existing;
      },
      async requestDayReplay() {
        requests += 1;
        return acceptedReceipt('new-job');
      },
    }),
  });

  assert.deepEqual(await runtime.replay(interaction), {
    kind: 'replay',
    jobId: 'existing-job',
    status: 'RUNNING',
    terminal: false,
  });
  assert.equal(latestReads, 1);
  assert.equal(requests, 0);
});

test('new replay derives its payload and refreshes projection before polling', async () => {
  let projectionReads = 0;
  let captured;
  let polled;
  const runtime = runtimeFor({
    client: clientFor({
      async getActiveSave() {
        return active(projection('REPLAY_AVAILABLE'));
      },
      async getGameplayProjection() {
        projectionReads += 1;
        return projection('REPLAY_AVAILABLE');
      },
      async getLatestReplayJob() {
        throw new HttpError(404, 'REPLAY_JOB_NOT_FOUND');
      },
      async requestDayReplay(saveId, input) {
        captured = { saveId, input };
        return acceptedReceipt('job-new');
      },
      async pollReplayJob(saveId, jobId) {
        polled = { saveId, jobId };
        return replayResponse(jobId, 'QUEUED');
      },
    }),
  });

  const display = await runtime.replay(interaction);
  assert.deepEqual(captured, {
    saveId: 'save-1',
    input: {
      commandId: 'runtime-command-1',
      idempotencyKey: interaction.interactionId,
      expectedVersion: 4,
      payload: { businessDay: 1 },
    },
  });
  assert.deepEqual(polled, { saveId: 'save-1', jobId: 'job-new' });
  assert.equal(projectionReads, 2, 'pre-mutation projection plus successful refresh');
  assert.equal(display.kind, 'replay');
});

test('settlement payload is derived from the server first-day projection', async () => {
  let captured;
  let reads = 0;
  const runtime = runtimeFor({
    client: clientFor({
      async getActiveSave() {
        return active(projection('SETTLE_REQUIRED'));
      },
      async getGameplayProjection() {
        reads += 1;
        return reads === 1 ? projection('SETTLE_REQUIRED') : projection('REPLAY_AVAILABLE', 5);
      },
      async settleBusinessDay(saveId, input) {
        captured = { saveId, input };
        return completedReceipt('SETTLE_BUSINESS_DAY', 5);
      },
    }),
  });
  await runtime.settle(interaction);
  assert.deepEqual(captured.input, {
    commandId: 'runtime-command-1',
    idempotencyKey: interaction.interactionId,
    expectedVersion: 4,
    payload: { businessDay: 1 },
  });
});

test('one transport retry reuses the exact command identity and envelope', async () => {
  const calls = [];
  let reads = 0;
  const runtime = runtimeFor({
    client: clientFor({
      async getGameplayProjection() {
        reads += 1;
        return reads === 1 ? projection('OPEN_REQUIRED') : projection('ADVANCE_REQUIRED', 5);
      },
      async openBusinessDay(saveId, input) {
        calls.push(structuredClone({ saveId, input }));
        if (calls.length === 1) throw new Error('socket closed');
        return completedReceipt('OPEN_BUSINESS_DAY', 5);
      },
    }),
  });

  const result = await runtime.open(interaction);
  assert.equal(result.kind, 'status');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[0].input.commandId, 'runtime-command-1');
  assert.equal(calls[0].input.idempotencyKey, interaction.interactionId);
});

test('409 refreshes without replay, while 422 and 5xx never retry', async () => {
  for (const item of [
    { status: 409, code: 'EXPECTED_VERSION_CONFLICT', resolution: undefined },
    { status: 422, code: 'COMMAND_INVALID', resolution: 'NONE' },
    { status: 503, code: 'COMMAND_UNAVAILABLE', resolution: 'STATUS_REQUIRED' },
  ]) {
    let mutations = 0;
    let reads = 0;
    const runtime = runtimeFor({
      client: clientFor({
        async getGameplayProjection() {
          reads += 1;
          return projection('OPEN_REQUIRED');
        },
        async openBusinessDay() {
          mutations += 1;
          throw new HttpError(item.status, item.code);
        },
      }),
    });
    const result = await runtime.open(interaction);
    assert.equal(mutations, 1);
    if (item.status === 409) {
      assert.equal(result.kind, 'status');
      assert.equal(result.notice, 'CONFLICT_REFRESHED');
      assert.equal(reads, 2);
    } else {
      assert.equal(result.kind, 'failure');
      assert.equal(result.code, item.code);
      assert.equal(result.resolution, item.resolution);
      assert.equal(reads, 1);
    }
  }
});

test('a second transport failure is unconfirmed and requires status', async () => {
  let mutations = 0;
  const runtime = runtimeFor({
    client: clientFor({
      async openBusinessDay() {
        mutations += 1;
        throw new Error('ambiguous transport');
      },
    }),
  });
  const result = await runtime.open(interaction);
  assert.equal(mutations, 2);
  assert.deepEqual(result, {
    kind: 'failure',
    action: 'OPEN_BUSINESS_DAY',
    code: 'BOT_GAMEPLAY_MUTATION_UNCONFIRMED',
    resolution: 'STATUS_REQUIRED',
  });
});

test('replay display omits hashes, save scope, authority, and raw verification payloads', async () => {
  const runtime = runtimeFor({
    client: clientFor({
      async pollReplayJob() {
        return replayResponse('job-1', 'MATCH');
      },
    }),
  });
  const display = await runtime.replayStatus(interaction, 'job-1');
  assert.deepEqual(display, {
    kind: 'replay',
    jobId: 'job-1',
    status: 'MATCH',
    terminal: true,
    outcome: 'MATCH',
  });
  assertSafeDisplay(display);
  assert.doesNotMatch(JSON.stringify(display), new RegExp(hash));
});

function runtimeFor(options = {}) {
  const fixedClient = options.client ?? clientFor({});
  return new BotGameplayRuntime({
    apiBaseUrl: 'https://api.example.test',
    serviceCredential: 'service-credential',
    createCommandId: () => 'runtime-command-1',
    createClient: options.createClient ?? (() => fixedClient),
  });
}

function clientFor(overrides) {
  const initial = projection('OPEN_REQUIRED');
  return {
    async getActiveSave() {
      return active(initial);
    },
    async getGameplayProjection() {
      return initial;
    },
    async openBusinessDay() {
      return completedReceipt('OPEN_BUSINESS_DAY', 5);
    },
    async advanceServicePeriod() {
      return completedReceipt('ADVANCE_SERVICE_PERIOD', 5);
    },
    async settleBusinessDay() {
      return completedReceipt('SETTLE_BUSINESS_DAY', 5);
    },
    async requestDayReplay() {
      return acceptedReceipt('job-1');
    },
    async getLatestReplayJob() {
      throw new HttpError(404, 'REPLAY_JOB_NOT_FOUND');
    },
    async pollReplayJob(_saveId, jobId) {
      return replayResponse(jobId, 'RUNNING');
    },
    ...overrides,
  };
}

function active(value) {
  return {
    schemaVersion: 'gameplay.active-save-discovery/v1',
    state: 'ACTIVE_SAVE',
    bootstrap: null,
    activeSave: value,
  };
}

function projection(phase, aggregateVersion = 4) {
  const map = {
    OPEN_REQUIRED: {
      nextCommand: 'OPEN_BUSINESS_DAY',
      status: 'PREOPEN',
      completed: 0,
      nextPeriodKey: null,
    },
    ADVANCE_REQUIRED: {
      nextCommand: 'ADVANCE_SERVICE_PERIOD',
      status: 'OPEN',
      completed: 0,
      nextPeriodKey: 'LUNCH',
    },
    SETTLE_REQUIRED: {
      nextCommand: 'SETTLE_BUSINESS_DAY',
      status: 'SERVICE_COMPLETE',
      completed: 2,
      nextPeriodKey: null,
    },
    REPLAY_AVAILABLE: {
      nextCommand: 'REQUEST_DAY_REPLAY',
      status: 'SETTLED',
      completed: 2,
      nextPeriodKey: null,
    },
  };
  const state = map[phase];
  return {
    schemaVersion: 'gameplay.current-projection/v1',
    save: {
      id: 'save-1',
      aggregateVersion,
      openingScenario: 'DEFAULT_SMALL_SHOP',
      operatingMode: 'STRATEGY',
      servicePeriodPlan: 'TWO_PERIODS',
      difficultyGroup: 'STANDARD',
      simulationRuleVersion: 'mvp-rules/v1',
    },
    phase,
    nextCommand: state.nextCommand,
    expectedVersion: aggregateVersion,
    ...(phase === 'OPEN_REQUIRED' ? { preopenSnapshot: { id: 'preopen-1', hash } } : {}),
    businessDay: {
      businessDay: 1,
      status: state.status,
      simulationRuleVersion: 'mvp-rules/v1',
      completedServicePeriods: state.completed,
      totalServicePeriods: 2,
      nextPeriodKey: state.nextPeriodKey,
    },
    dayEnd:
      phase === 'REPLAY_AVAILABLE'
        ? { businessDay: 1, dayEndSnapshotId: 'day-end-1', eventHash: hash, snapshotHash: hash }
        : null,
  };
}

function completedReceipt(commandType, aggregateVersion) {
  return {
    commandId: 'runtime-command-1',
    idempotencyKey: interaction.interactionId,
    commandType,
    aggregateId: 'save-1',
    aggregateVersion,
    result: {},
  };
}

function acceptedReceipt(jobId) {
  return {
    ...completedReceipt('REQUEST_DAY_REPLAY', 5),
    jobId,
  };
}

function replayResponse(jobId, status) {
  if (status === 'MATCH' || status === 'MISMATCH') {
    return {
      status: 200,
      body: {
        schemaVersion: 'gameplay.replay-job/v1',
        jobId,
        saveId: 'save-1',
        businessDay: 1,
        status,
        terminal: true,
        verification: {
          eventCount: 9,
          eventHash: { expected: hash, computed: hash, match: true },
          snapshotHash: { expected: hash, computed: hash, match: true },
        },
      },
    };
  }
  return {
    status: 202,
    body: {
      schemaVersion: 'gameplay.replay-job/v1',
      jobId,
      saveId: 'save-1',
      businessDay: 1,
      status,
      terminal: false,
    },
  };
}

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function assertSafeDisplay(display) {
  const serialized = JSON.stringify(display);
  for (const forbidden of [
    'tenant',
    'player',
    'membership',
    'seed',
    'snapshotHash',
    'eventHash',
    'saveId',
    'raw',
    'verification',
    'service-credential',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
}
