import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOOTSTRAP_COMMAND_ENVELOPE_VERSION,
  EconGameApiError,
  GAMEPLAY_RESPONSE_VALIDATION_VERSION,
  createGameplayApiClient,
  createGameplayResponseValidationGuard,
} from '../dist/index.js';

const commandId = '11111111-1111-4111-8111-111111111111';
const hash = 'a'.repeat(64);
const initialIntent = {
  scenario: 'DEFAULT_SMALL_SHOP',
  operatingMode: 'STRATEGY',
  settlementCurrency: 'TWD',
  servicePeriodPlan: 'TWO_PERIODS',
};

test('canonical gameplay response guard is version-pinned and rejects malformed raw projections', () => {
  const guard = createGameplayResponseValidationGuard(GAMEPLAY_RESPONSE_VALIDATION_VERSION);
  assert.equal(guard.version, GAMEPLAY_RESPONSE_VALIDATION_VERSION);
  assert.throws(() => guard.activeSaveDiscovery({ schemaVersion: 'wrong' }), TypeError);
  assert.throws(() => guard.gameplayProjection({ phase: 'OPEN_REQUIRED' }), TypeError);
  assert.throws(() => guard.replayJobPollResponse({ status: 200, body: { terminal: true } }), TypeError);
  assert.throws(() => createGameplayResponseValidationGuard('gameplay-response-validation/v0'), RangeError);
});

test('gameplay bootstrap uses the dedicated route and caller-supplied authorization only', async () => {
  let received;
  const client = createGameplayApiClient({
    baseUrl: 'https://api.example.test/root',
    headers: { authorization: 'Bearer caller-provided-token', 'x-client': 'web' },
    fetch: async (url, init) => {
      received = { url, init };
      return json(commandResponse('INITIALIZE_COMPETITIVE_SAVE', {
        authorityId: 'authority-1',
        epochId: 'epoch-1',
        epochNumber: 1,
        provisionedRestaurantId: 'restaurant-1',
        ownerMembershipId: 'membership-1',
        saveId: 'save-1',
        ownerAuditLogId: 'audit-1',
        replayed: false,
      }, { aggregateId: 'bootstrap-player:player-1' }));
    },
  });

  await client.initializeCompetitiveSave({
    commandId,
    idempotencyKey: 'bootstrap-1',
    expectedVersion: 0,
    payload: initialIntent,
  });

  assert.equal(received.url, 'https://api.example.test/root/bootstrap/actions/INITIALIZE_COMPETITIVE_SAVE');
  assert.equal(received.init.method, 'POST');
  assert.equal(received.init.headers.get('authorization'), 'Bearer caller-provided-token');
  assert.equal(received.init.headers.get('x-client'), 'web');
  assert.deepEqual(JSON.parse(received.init.body), {
    schemaVersion: BOOTSTRAP_COMMAND_ENVELOPE_VERSION,
    commandId,
    idempotencyKey: 'bootstrap-1',
    commandType: 'INITIALIZE_COMPETITIVE_SAVE',
    expectedVersion: 0,
    payload: initialIntent,
  });
  assert.equal(received.init.body.includes('actor'), false);
  assert.equal(received.init.body.includes('tenant'), false);
});

test('gameplay read methods encode scoped identifiers and retain server expectedVersion handoff', async () => {
  const calls = [];
  const client = createGameplayApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith('/gameplay/active-save')) {
        return json({
          schemaVersion: 'gameplay.active-save-discovery/v1',
          state: 'INITIALIZE_REQUIRED',
          bootstrap: {
            route: '/bootstrap/actions/INITIALIZE_COMPETITIVE_SAVE',
            aggregateId: 'bootstrap-player:player-1',
            expectedVersion: 4,
          },
          activeSave: null,
        });
      }
      return json({
        schemaVersion: 'gameplay.current-projection/v1',
        save: { id: 'save/1', aggregateVersion: 7, openingScenario: 'DEFAULT', operatingMode: 'STRATEGY', servicePeriodPlan: 'TWO_PERIODS', difficultyGroup: 'NORMAL', simulationRuleVersion: 'rule/v1' },
        phase: 'ADVANCE_REQUIRED',
        nextCommand: 'ADVANCE_SERVICE_PERIOD',
        expectedVersion: 7,
        businessDay: {
          businessDay: 1,
          status: 'OPEN',
          simulationRuleVersion: 'rule/v1',
          completedServicePeriods: 0,
          totalServicePeriods: 2,
          nextPeriodKey: 'LUNCH',
        },
        dayEnd: null,
      });
    },
  });

  const discovery = await client.getActiveSave();
  assert.equal(discovery.state, 'INITIALIZE_REQUIRED');
  assert.equal(discovery.bootstrap.expectedVersion, 4);
  const projection = await client.getGameplayProjection('save/1');
  assert.equal(projection.expectedVersion, 7);
  assert.deepEqual(calls, [
    'https://api.example.test/gameplay/active-save',
    'https://api.example.test/saves/save%2F1/gameplay',
  ]);
});

test('active OPEN_REQUIRED discovery preserves the exact safe recovery pin', async () => {
  const client = createGameplayApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async () => json({
      schemaVersion: 'gameplay.active-save-discovery/v1',
      state: 'ACTIVE_SAVE',
      bootstrap: null,
      activeSave: {
        schemaVersion: 'gameplay.current-projection/v1',
        save: { id: 'save-1', aggregateVersion: 2, openingScenario: 'DEFAULT_SMALL_SHOP', operatingMode: 'STRATEGY', servicePeriodPlan: 'TWO_PERIODS', difficultyGroup: 'STANDARD', simulationRuleVersion: 'mvp-e01-v1' },
        phase: 'OPEN_REQUIRED',
        nextCommand: 'OPEN_BUSINESS_DAY',
        expectedVersion: 2,
        preopenSnapshot: { id: 'preopen-1', hash },
        businessDay: { businessDay: 1, status: 'PREOPEN', simulationRuleVersion: 'mvp-e01-v1', completedServicePeriods: 0, totalServicePeriods: 2, nextPeriodKey: null },
        dayEnd: null,
      },
    }),
  });

  const result = await client.getActiveSave();
  assert.equal(result.state, 'ACTIVE_SAVE');
  assert.deepEqual(result.activeSave.preopenSnapshot, { id: 'preopen-1', hash });
});

test('gameplay reads reject unknown fields, malformed state pairings, and pins outside OPEN_REQUIRED', async () => {
  const validProjection = {
    schemaVersion: 'gameplay.current-projection/v1',
    save: { id: 'save-1', aggregateVersion: 2, openingScenario: 'DEFAULT_SMALL_SHOP', operatingMode: 'STRATEGY', servicePeriodPlan: 'TWO_PERIODS', difficultyGroup: 'STANDARD', simulationRuleVersion: 'mvp-e01-v1' },
    phase: 'ADVANCE_REQUIRED',
    nextCommand: 'ADVANCE_SERVICE_PERIOD',
    expectedVersion: 2,
    businessDay: { businessDay: 1, status: 'OPEN', simulationRuleVersion: 'mvp-e01-v1', completedServicePeriods: 0, totalServicePeriods: 2, nextPeriodKey: 'LUNCH' },
    dayEnd: null,
  };
  const cases = [
    {
      method: 'getActiveSave',
      body: { schemaVersion: 'gameplay.active-save-discovery/v1', state: 'INITIALIZE_REQUIRED', bootstrap: { route: '/bootstrap/actions/INITIALIZE_COMPETITIVE_SAVE', aggregateId: 'bootstrap-player:1', expectedVersion: 0 }, activeSave: null, marketSeed: 'leak' },
    },
    { method: 'getGameplayProjection', body: { ...validProjection, nextCommand: 'SETTLE_BUSINESS_DAY' } },
    { method: 'getGameplayProjection', body: { ...validProjection, preopenSnapshot: { id: 'preopen-1', hash } } },
    { method: 'getGameplayProjection', body: { ...validProjection, save: { ...validProjection.save, aggregateVersion: 3 } } },
  ];
  for (const { method, body } of cases) {
    const client = createGameplayApiClient({ baseUrl: 'https://api.example.test', fetch: async () => json(body) });
    await assert.rejects(
      method === 'getActiveSave' ? client.getActiveSave() : client.getGameplayProjection('save-1'),
      TypeError,
    );
  }
});

test('six typed command helpers send only client-owned payload and use the shared D02 envelope', async () => {
  const calls = [];
  const client = createGameplayApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      return json(
        body.commandType === 'REQUEST_DAY_REPLAY'
          ? { ...commandResponse(body.commandType, resultForCommand(body.commandType)), jobId: 'job-1' }
          : commandResponse(body.commandType, resultForCommand(body.commandType)),
        body.commandType === 'REQUEST_DAY_REPLAY' ? 202 : 200,
      );
    },
  });
  const input = (suffix, payload) => ({ commandId: commandId.replace(/1$/, suffix), idempotencyKey: `key-${suffix}`, expectedVersion: 3, payload });

  await client.configurePreopenDay('save/1', input('2', {
    menuChoice: { themeId: 'theme', recipeVersionIds: ['recipe'], priceModifierPercentByRecipe: { recipe: 0 }, enabledSubstitutionIds: [] },
    floorPlan: { width: 2, height: 2, servicePoint: { x: 0, y: 0 }, fixtures: [] },
    spotPurchaseDeltas: [],
  }));
  await client.openBusinessDay('save/1', input('3', { preopenSnapshotId: 'snapshot-1', preopenSnapshotHash: 'a'.repeat(64) }));
  await client.advanceServicePeriod('save/1', input('4', { businessDay: 1, expectedPeriodKey: 'LUNCH', ownerAssignment: 'NONE' }));
  await client.settleBusinessDay('save/1', input('5', { businessDay: 1 }));
  const replayRequest = await client.requestDayReplay('save/1', input('6', { businessDay: 1 }));

  assert.deepEqual(calls.map(({ url }) => url), [
    'https://api.example.test/saves/save%2F1/actions/CONFIGURE_PREOPEN_DAY',
    'https://api.example.test/saves/save%2F1/actions/OPEN_BUSINESS_DAY',
    'https://api.example.test/saves/save%2F1/actions/ADVANCE_SERVICE_PERIOD',
    'https://api.example.test/saves/save%2F1/actions/SETTLE_BUSINESS_DAY',
    'https://api.example.test/saves/save%2F1/actions/REQUEST_DAY_REPLAY',
  ]);
  for (const call of calls) {
    assert.equal(call.body.schemaVersion, 'd02-command/v1');
    assert.equal(call.body.aggregateId, 'save/1');
    assert.equal(Object.hasOwn(call.body, 'actorId'), false);
    assert.equal(Object.hasOwn(call.body, 'tenantId'), false);
    assert.equal(Object.hasOwn(call.body.payload, 'actorId'), false);
    assert.equal(Object.hasOwn(call.body.payload, 'tenantId'), false);
  }
  assert.equal(replayRequest.jobId, 'job-1');
});

test('replay polling keeps 202 pending responses separate from safe terminal results', async () => {
  const client = createGameplayApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async () => json({ schemaVersion: 'gameplay.replay-job/v1', jobId: 'job/1', saveId: 'save/1', businessDay: 1, status: 'RUNNING', terminal: false }, 202),
  });
  const pending = await client.pollReplayJob('save/1', 'job/1');
  assert.equal(pending.status, 202);
  assert.equal(pending.body.terminal, false);

  const terminal = createGameplayApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async () => json({ schemaVersion: 'gameplay.replay-job/v1', jobId: 'job-1', saveId: 'save-1', businessDay: 1, status: 'PERMANENT_FAILURE', terminal: true, failure: { retryable: false, category: 'PERMANENT' } }),
  });
  const result = await terminal.pollReplayJob('save-1', 'job-1');
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'PERMANENT_FAILURE');

  const verified = createGameplayApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async () => json({
      schemaVersion: 'gameplay.replay-job/v1',
      jobId: 'job-2', saveId: 'save-1', businessDay: 1, status: 'MATCH', terminal: true,
      verification: verification(hash, hash),
    }),
  });
  assert.equal((await verified.pollReplayJob('save-1', 'job-2')).body.status, 'MATCH');
});

test('replay recovery performs only a strict read and reuses the exact safe replay validator', async () => {
  const calls = [];
  const client = createGameplayApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return json({
        schemaVersion: 'gameplay.replay-job/v1',
        jobId: 'job-1',
        saveId: 'save/1',
        businessDay: 1,
        status: 'RUNNING',
        terminal: false,
      }, 202);
    },
  });

  const first = await client.getLatestReplayJob('save/1', 1);
  const recoveredAgain = await client.getLatestReplayJob('save/1', 1);
  assert.equal(first.status, 202);
  assert.equal(recoveredAgain.body.status, 'RUNNING');
  assert.deepEqual(calls.map(({ url }) => url), [
    'https://api.example.test/saves/save%2F1/replay-jobs/latest?businessDay=1',
    'https://api.example.test/saves/save%2F1/replay-jobs/latest?businessDay=1',
  ]);
  for (const { init } of calls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
  }
  assert.throws(() => client.getLatestReplayJob('save-1', 2), /businessDay 1/);

  const malformed = createGameplayApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async () => json({
      schemaVersion: 'gameplay.replay-job/v1',
      jobId: 'job-1',
      saveId: 'save-1',
      businessDay: 1,
      status: 'MATCH',
      terminal: true,
      verification: verification(hash, hash),
      sourcePayload: { marketSeed: 'leak' },
    }),
  });
  await assert.rejects(malformed.getLatestReplayJob('save-1', 1), /unknown or missing fields/);

  for (const override of [{ saveId: 'save-other' }, { businessDay: 2 }]) {
    const wrongTarget = createGameplayApiClient({
      baseUrl: 'https://api.example.test',
      fetch: async () => json({
        schemaVersion: 'gameplay.replay-job/v1',
        jobId: 'job-1',
        saveId: 'save-1',
        businessDay: 1,
        status: 'RUNNING',
        terminal: false,
        ...override,
      }, 202),
    });
    await assert.rejects(
      wrongTarget.getLatestReplayJob('save-1', 1),
      /does not match the requested scope/,
    );
  }

  const wrongPollTarget = createGameplayApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async () => json({
      schemaVersion: 'gameplay.replay-job/v1',
      jobId: 'job-other',
      saveId: 'save-1',
      businessDay: 1,
      status: 'QUEUED',
      terminal: false,
    }, 202),
  });
  await assert.rejects(
    wrongPollTarget.pollReplayJob('save-1', 'job-1'),
    /does not match the requested scope/,
  );
});

test('pre-open choices are Web-scoped, exact, and never accept private authority fields', async () => {
  const calls = [];
  const client = createGameplayApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return json(preopenChoices('save/1'));
    },
  });
  const choices = await client.getPreopenConfigurationChoices('save/1');
  assert.equal(choices.save.id, 'save/1');
  assert.equal(choices.menu.recipeCards[0].priceOptions.length, 21);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/saves/save%2F1/preopen/configuration-choices');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);

  for (const invalid of [
    { ...preopenChoices('save-1'), demandSeed: 'forbidden' },
    { ...preopenChoices('save-1'), save: { ...preopenChoices('save-1').save, id: 'other-save' } },
    { ...preopenChoices('save-1'), menu: { ...preopenChoices('save-1').menu, recipeCards: preopenChoices('save-1').menu.recipeCards.slice(0, 2) } },
    { ...preopenChoices('save-1'), menu: { ...preopenChoices('save-1').menu, recipeCards: [{ ...preopenChoices('save-1').menu.recipeCards[0], priceOptions: preopenChoices('save-1').menu.recipeCards[0].priceOptions.slice(1) }] } },
    { ...preopenChoices('save-1'), procurement: { ...preopenChoices('save-1').procurement, lockedDay1Quotes: [{ ...preopenChoices('save-1').procurement.lockedDay1Quotes[0], priceModifierBps: 1 }] } },
  ]) {
    const invalidClient = createGameplayApiClient({ baseUrl: 'https://api.example.test', fetch: async () => json(invalid) });
    await assert.rejects(invalidClient.getPreopenConfigurationChoices('save-1'), TypeError);
  }
});

test('gameplay client preserves stable error envelopes and rejects invalid replay status pairings', async () => {
  const rejected = createGameplayApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async () => json({ error: { version: 'd02-command-error/v1', code: 'EXPECTED_VERSION_CONFLICT' } }, 409, 'Conflict'),
  });
  await assert.rejects(rejected.settleBusinessDay('save-1', {
    commandId,
    idempotencyKey: 'settle-conflict',
    expectedVersion: 2,
    payload: { businessDay: 1 },
  }), (error) => {
    assert.ok(error instanceof EconGameApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'EXPECTED_VERSION_CONFLICT');
    return true;
  });

  const malformed = createGameplayApiClient({
    baseUrl: 'https://api.example.test',
    fetch: async () => json({ schemaVersion: 'gameplay.replay-job/v1', jobId: 'job-1', saveId: 'save-1', businessDay: 1, status: 'MATCH', terminal: true, verification: { eventCount: 1, eventHash: { expected: 'a', computed: 'a', match: true }, snapshotHash: { expected: 'a', computed: 'a', match: true } } }, 202),
  });
  await assert.rejects(malformed.pollReplayJob('save-1', 'job-1'), /HTTP status must match/);
});

test('replay polling rejects leaked fields and malformed terminal verification or failure shapes', async () => {
  const cases = [
    {
      status: 202,
      body: {
        schemaVersion: 'gameplay.replay-job/v1', jobId: 'job-1', saveId: 'save-1', businessDay: 1,
        status: 'QUEUED', terminal: false, verification: verification(hash, hash),
      },
    },
    {
      status: 200,
      body: {
        schemaVersion: 'gameplay.replay-job/v1', jobId: 'job-1', saveId: 'save-1', businessDay: 1,
        status: 'MISMATCH', terminal: true, verification: verification(hash, hash),
      },
    },
    {
      status: 200,
      body: {
        schemaVersion: 'gameplay.replay-job/v1', jobId: 'job-1', saveId: 'save-1', businessDay: 1,
        status: 'RETRY_EXHAUSTED', terminal: true,
        failure: { retryable: false, category: 'PERMANENT' }, verification: verification(hash, hash),
      },
    },
  ];
  for (const { status, body } of cases) {
    const client = createGameplayApiClient({
      baseUrl: 'https://api.example.test',
      fetch: async () => json(body, status),
    });
    await assert.rejects(client.pollReplayJob('save-1', 'job-1'));
  }
});

test('command helpers reject mismatched targets, unknown result fields, and private authority leaks', async () => {
  const cases = [
    commandResponse('SETTLE_BUSINESS_DAY', { ...resultForCommand('SETTLE_BUSINESS_DAY'), demandSeed: 'leak' }),
    commandResponse('SETTLE_BUSINESS_DAY', { ...resultForCommand('SETTLE_BUSINESS_DAY'), unexpected: true }),
    commandResponse('OPEN_BUSINESS_DAY', resultForCommand('OPEN_BUSINESS_DAY'), { aggregateId: 'save-other' }),
  ];
  for (const body of cases) {
    const client = createGameplayApiClient({ baseUrl: 'https://api.example.test', fetch: async () => json(body) });
    const action = body.commandType === 'OPEN_BUSINESS_DAY'
      ? client.openBusinessDay('save/1', { commandId, idempotencyKey: 'bad-open', expectedVersion: 3, payload: { preopenSnapshotId: 'preopen-1', preopenSnapshotHash: hash } })
      : client.settleBusinessDay('save/1', { commandId, idempotencyKey: 'bad-settle', expectedVersion: 3, payload: { businessDay: 1 } });
    await assert.rejects(action, TypeError);
  }
});

function preopenChoices(saveId) {
  const money = { currency: 'TWD', minorUnits: '100' };
  const ingredients = [
    { ingredientId: 'rice', quantityPoints: 1 },
    { ingredientId: 'chicken', quantityPoints: 2 },
  ];
  const priceOptions = Array.from({ length: 21 }, (_, index) => ({
    modifierPercent: index - 10,
    salePrice: money,
  }));
  return {
    save: {
      id: saveId,
      expectedVersion: 4,
      scenario: 'DEFAULT_SMALL_SHOP',
      operatingMode: 'STRATEGY',
      servicePeriodPlan: 'TWO_PERIODS',
      servicePeriods: ['LUNCH', 'DINNER'],
      simulationRuleVersion: 'mvp-e01-v1',
    },
    businessDay: 1,
    versions: {
      preopenSchema: 'p0-preopen-day/v1',
      openingCatalog: 'mvp-e01-opening-v2',
      simulationRule: 'mvp-e01-v1',
      currencyMetadata: 'iso-4217-mvp/v1',
      catalog: 'mvp-first-day-catalog/v1',
      ingredientCatalog: 'mvp-first-day-ingredients/v1',
      recipeCatalog: 'mvp-first-day-recipes/v1',
      substitutionCatalog: 'mvp-first-day-substitutions/v1',
      floorSpace: 'e02-space-v1',
    },
    menu: {
      difficulty: 'STANDARD', requiredRecipeCount: 3, themeId: 'bistro',
      recipeCards: [
        { recipeVersionId: 'recipe-v1', recipeId: 'recipe', baseQuality: 80, ingredients, basePrice: money, priceOptions, substitutionIds: ['sub-v1'] },
        { recipeVersionId: 'recipe-v2', recipeId: 'recipe-2', baseQuality: 81, ingredients, basePrice: money, priceOptions, substitutionIds: [] },
        { recipeVersionId: 'recipe-v3', recipeId: 'recipe-3', baseQuality: 82, ingredients, basePrice: money, priceOptions, substitutionIds: [] },
      ],
      substitutions: [{
        id: 'sub-v1', recipeVersionId: 'recipe-v1', priority: 10, qualityDelta: -3,
        ingredients,
      }],
    },
    procurement: {
      settlementCurrency: 'TWD', spendLimit: money,
      poolCapacities: { DURABLE: 305, PERISHABLE: 305 },
      lockedDay1Quotes: [
        { ingredientId: 'rice', pool: 'DURABLE', unitPrice: money, priceModifierBps: 0 },
        { ingredientId: 'chicken', pool: 'PERISHABLE', unitPrice: money, priceModifierBps: 0 },
      ],
    },
    floor: {
      catalogVersion: 'e02-space-v1', width: 10, height: 9, usableFloorCells: 90,
      maxSeats: 30, maxWaitingGroups: 4,
      allowedFixtureKinds: ['SEAT', 'WALKWAY', 'WAITING_ZONE'],
      constraints: {
        phase: 'PRE_OPEN', exactScenarioDimensionsRequired: true,
        servicePointInBoundsRequired: true, servicePointMustNotOverlapFixture: true,
        fixtureIdsMustBeUnique: true, fixturesMustBeInBounds: true,
        fixturesMustNotOverlap: true, seatsAndWaitingZonesRequireWalkwayConnection: true,
      },
    },
  };
}

function commandResponse(commandType, result, overrides = {}) {
  return {
    commandId,
    idempotencyKey: 'test-key',
    commandType,
    aggregateId: overrides.aggregateId ?? 'save/1',
    aggregateVersion: 4,
    result,
  };
}

function resultForCommand(commandType) {
  const competitiveSave = { id: 'save/1', version: 4 };
  if (commandType === 'CONFIGURE_PREOPEN_DAY') {
    return {
      competitiveSave,
      preopenDaySnapshot: {
        envelopeVersion: 'p0-preopen-day/v1',
        preopenSnapshotId: 'preopen-1',
        preopenSnapshotHash: hash,
        businessDay: 1,
        menu: { themeId: 'theme', items: [] },
        floorPlan: { revision: 1, layoutHash: hash, layout: { width: 2, height: 2, servicePoint: { x: 0, y: 0 }, fixtures: [] } },
        demandForecast: demandForecast(),
      },
    };
  }
  if (commandType === 'OPEN_BUSINESS_DAY') {
    return {
      competitiveSave,
      businessDay: {
        id: 'day-1', businessDay: 1, status: 'OPEN', servicePeriodPlan: 'TWO_PERIODS',
        simulationRuleVersion: 'mvp-e01-v1', consumedPreopenSnapshotId: 'preopen-1', openSnapshotHash: hash,
      },
      preopenDaySnapshot: { id: 'preopen-1', revision: 1, snapshotSchemaVersion: 'p0-preopen-day/v1', snapshotHash: hash },
      demandForecast: demandForecast(),
    };
  }
  if (commandType === 'ADVANCE_SERVICE_PERIOD') {
    return {
      competitiveSave,
      businessDay: { id: 'day-1', businessDay: 1, status: 'OPEN', simulationRuleVersion: 'mvp-e01-v1' },
      servicePeriodExecution: {
        id: 'execution-1', ordinal: 1, periodKey: 'LUNCH', inputHash: hash, resultHash: hash,
        finalPeriod: false,
        summary: { ordersServed: 4, groupsDeparted: 1, reputation: reputation(), flowRiskHigh: false },
      },
    };
  }
  if (commandType === 'SETTLE_BUSINESS_DAY') {
    return {
      competitiveSave, businessDay: 1, businessDayId: 'day-1', status: 'SETTLED',
      dayEndSnapshotId: 'day-end-1', eventHash: hash, snapshotHash: hash,
      summary: { ordersServed: 4, servicePeriodsCompleted: 2, wasteLinesRecorded: 1 },
      ledgerSummary: { transactionId: commandId, currency: 'TWD', balanced: true },
      risk: { status: 'NORMAL', tags: [], highRiskRevenueEnabled: false, leaderboardEligible: true },
      reputation: reputation(),
    };
  }
  return { businessDay: 1, eventHash: hash, replayAvailability: 'QUEUED', snapshotHash: hash };
}

function demandForecast() {
  return {
    day: 1,
    periodPlan: 'TWO_PERIODS',
    weather: { label: 'CLEAR', demandModifierPercent: 0 },
    allDayGroups: { min: 20, max: 24 },
    periods: [
      { period: 'LUNCH', groups: { min: 8, max: 10 }, mainCohortTendencies: ['TIME_SENSITIVE'] },
      { period: 'DINNER', groups: { min: 12, max: 14 }, mainCohortTendencies: ['EXPERIENCE_ORIENTED'] },
    ],
    patienceTicks: {
      PRICE_SENSITIVE: { min: 8, max: 12 },
      TIME_SENSITIVE: { min: 6, max: 9 },
      EXPERIENCE_ORIENTED: { min: 10, max: 15 },
    },
    disclosure: {
      exactArrivalTimesShown: false,
      individualOrdersShown: false,
      demandSeedShown: false,
      exactPatienceCountdownShown: false,
    },
  };
}

function reputation() {
  return { price: 50, speed: 50, quality: 50, fairness: 50, vibe: 50 };
}

function json(value, status = 200, statusText = '') {
  return new Response(JSON.stringify(value), { status, statusText, headers: { 'content-type': 'application/json' } });
}

function verification(expected, computed) {
  return {
    eventCount: 1,
    eventHash: { expected, computed, match: expected === computed },
    snapshotHash: { expected, computed, match: expected === computed },
  };
}
