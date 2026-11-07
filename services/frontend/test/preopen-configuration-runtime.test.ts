import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ActiveGameplaySaveDiscovery,
  GameplayProjection,
  PreopenConfigurationChoices,
} from '@econ-game/sdk';

import type { WebGameplayTransport } from '../lib/gameplay-machine.js';
import { WebGameplayRuntime } from '../lib/gameplay-runtime.js';
import {
  WebPreopenConfigurationRuntime,
  type PreopenConfigurationDraftStore,
} from '../lib/preopen-configuration-runtime.js';

const hash = 'a'.repeat(64);

test('configuration lifecycle fetches choices only after CONFIGURE_REQUIRED and binds the active save', async () => {
  let choicesCalls = 0;
  const gameplay = gameplayRuntime({
    getActiveSave: async () => active(projection(7)),
    getPreopenConfigurationChoices: async (saveId) => {
      choicesCalls += 1;
      assert.equal(saveId, 'save-1');
      return choices(7);
    },
  });
  const configuration = new WebPreopenConfigurationRuntime(gameplay);

  assert.deepEqual(await configuration.load(), {
    tag: 'reconsider',
    code: 'CONFIGURATION_STATE_CHANGED',
  });
  assert.equal(choicesCalls, 0);

  await gameplay.discover();
  const state = await configuration.load();
  assert.equal(state.tag, 'ready');
  assert.equal(choicesCalls, 1);
  if (state.tag === 'ready') {
    assert.equal(state.choices.save.id, 'save-1');
    assert.equal(state.draft.menu, undefined);
  }
});

test('menu, quote purchase, and locked-grid selection reject any value outside choices', async () => {
  const configuration = await loadedConfiguration();

  assert.throws(
    () => configuration.setMenu(menuSelection(['recipe-1/v1', 'recipe-2/v1'])),
    /PREOPEN_MENU_RECIPE_COUNT_INVALID/,
  );
  assert.throws(
    () => configuration.setMenu(menuSelection(['recipe-1/v1', 'recipe-2/v1', 'forged/v1'])),
    /PREOPEN_MENU_RECIPE_INVALID/,
  );
  assert.throws(
    () => configuration.setMenu(menuSelection(['recipe-1/v1', 'recipe-2/v1', 'recipe-3/v1'], { 'recipe-1/v1': 11, 'recipe-2/v1': 0, 'recipe-3/v1': 0 })),
    /PREOPEN_MENU_PRICE_INVALID/,
  );
  assert.throws(
    () => configuration.setPurchases([{ quoteIngredientId: 'forged-ingredient', quantityPoints: 1 }]),
    /PREOPEN_PURCHASE_INVALID/,
  );
  assert.throws(
    () => configuration.setPurchases([{ quoteIngredientId: 'ingredient-a', quantityPoints: 11 }]),
    /PREOPEN_PURCHASE_CAPACITY_INVALID/,
  );
  assert.throws(
    () => configuration.setLayout({ servicePoint: { x: 0, y: 0 }, fixtures: [{ kind: 'SEAT', x: 3, y: 3 }] }),
    /PREOPEN_LAYOUT_WALKWAY_INVALID/,
  );
  assert.throws(
    () => configuration.setLayout({ servicePoint: { x: 0, y: 0 }, fixtures: [{ kind: 'SEAT', x: 1, y: 0, fixtureId: 'forged' }] as never }),
    /PREOPEN_LAYOUT_INVALID/,
  );
});

test('purchase bounds match the command parser: zero through 100000 and at most 128 entries', async () => {
  const gameplay = gameplayRuntime({
    getActiveSave: async () => active(projection(7)),
    getPreopenConfigurationChoices: async () => choices(7, { purchaseCapacity: 100_000 }),
  });
  await gameplay.discover();
  const configuration = new WebPreopenConfigurationRuntime(gameplay);
  await configuration.load();
  assert.equal(
    configuration.setPurchases([{ quoteIngredientId: 'ingredient-a', quantityPoints: 100_000 }]).tag,
    'ready',
  );
  assert.throws(
    () => configuration.setPurchases([{ quoteIngredientId: 'ingredient-a', quantityPoints: 100_001 }]),
    /PREOPEN_PURCHASE_INVALID/,
  );
  assert.throws(
    () => configuration.setPurchases(Array.from({ length: 129 }, () => ({ quoteIngredientId: 'ingredient-a', quantityPoints: 0 }))),
    /PREOPEN_PURCHASE_INVALID/,
  );
});

test('submit constructs the exact CONFIGURE intent from choices and stores no authority or private errors', async () => {
  const drafts = new MemoryDraftStore();
  let received: unknown;
  const gameplay = gameplayRuntime({
    getActiveSave: async () => active(projection(7)),
    getPreopenConfigurationChoices: async () => choices(7),
    configurePreopenDay: async (_saveId, input) => {
      received = input;
      return completedReceipt();
    },
    getGameplayProjection: async () => openProjection(8),
  });
  await gameplay.discover();
  const configuration = new WebPreopenConfigurationRuntime(gameplay, drafts);
  await configuration.load();
  configuration.setMenu(menuSelection(['recipe-3/v1', 'recipe-1/v1', 'recipe-2/v1'], { 'recipe-3/v1': 1, 'recipe-1/v1': -1, 'recipe-2/v1': 0 }));
  configuration.setPurchases([
    { quoteIngredientId: 'ingredient-b', quantityPoints: 0 },
    { quoteIngredientId: 'ingredient-a', quantityPoints: 2 },
  ]);
  configuration.setLayout({
    servicePoint: { x: 0, y: 0 },
    fixtures: [
      { kind: 'SEAT', x: 2, y: 0 },
      { kind: 'WALKWAY', x: 1, y: 0 },
      { kind: 'WAITING_ZONE', x: 1, y: 1 },
    ],
  });
  const result = await configuration.submit({ commandId: 'command-1', idempotencyKey: 'key-1' });
  assert.equal(result.tag, 'open');
  assert.deepEqual(received, {
    commandId: 'command-1',
    idempotencyKey: 'key-1',
    expectedVersion: 7,
    payload: {
      menuChoice: {
        themeId: 'bistro',
        recipeVersionIds: ['recipe-3/v1', 'recipe-1/v1', 'recipe-2/v1'],
        priceModifierPercentByRecipe: { 'recipe-1/v1': -1, 'recipe-2/v1': 0, 'recipe-3/v1': 1 },
        enabledSubstitutionIds: [],
      },
      floorPlan: {
        width: 4,
        height: 4,
        servicePoint: { x: 0, y: 0 },
        fixtures: [
          { fixtureId: 'fixture:SEAT:2:0', kind: 'SEAT', x: 2, y: 0 },
          { fixtureId: 'fixture:WAITING_ZONE:1:1', kind: 'WAITING_ZONE', x: 1, y: 1 },
          { fixtureId: 'fixture:WALKWAY:1:0', kind: 'WALKWAY', x: 1, y: 0 },
        ],
      },
      spotPurchaseDeltas: [{ ingredientId: 'ingredient-a', quantityPoints: 2 }],
    },
  });
  assert.equal(drafts.current, undefined);
  assert.doesNotMatch(JSON.stringify(received), /save-1|mvp-e01|TWD|seed|forecast/i);
});

test('a stale CONFIGURE response refreshes exactly once and requires reconsideration without resubmit', async () => {
  const drafts = new MemoryDraftStore();
  let configureCalls = 0;
  let projectionCalls = 0;
  const gameplay = gameplayRuntime({
    getActiveSave: async () => active(projection(7)),
    getPreopenConfigurationChoices: async () => choices(7),
    configurePreopenDay: async () => {
      configureCalls += 1;
      throw new StatusError(409, 'EXPECTED_VERSION_CONFLICT');
    },
    getGameplayProjection: async () => {
      projectionCalls += 1;
      return projection(8);
    },
  });
  await gameplay.discover();
  const configuration = new WebPreopenConfigurationRuntime(gameplay, drafts);
  await configuration.load();
  completeDraft(configuration);
  const result = await configuration.submit({ commandId: 'command-1', idempotencyKey: 'key-1' });
  assert.equal(result.tag, 'configure');
  assert.equal(configureCalls, 1);
  assert.equal(projectionCalls, 1);
  assert.deepEqual(configuration.state, { tag: 'reconsider', code: 'CONFIGURATION_VERSION_CHANGED' });
  assert.equal(drafts.current, undefined);
  await assert.rejects(
    () => configuration.submit({ commandId: 'command-1', idempotencyKey: 'key-1' }),
    /PREOPEN_CONFIGURATION_NOT_READY/,
  );
  assert.equal(configureCalls, 1);
});

test('draft recovery is pinned to save, expected version, and catalog versions; private choice errors are redacted', async () => {
  const drafts = new MemoryDraftStore();
  const first = gameplayRuntime({
    getActiveSave: async () => active(projection(7)),
    getPreopenConfigurationChoices: async () => choices(7),
  });
  await first.discover();
  const configuration = new WebPreopenConfigurationRuntime(first, drafts);
  await configuration.load();
  completeDraft(configuration);
  assert.notEqual(drafts.current, undefined);

  const planChanged = gameplayRuntime({
    getActiveSave: async () => active(threePeriodProjection(7)),
    getPreopenConfigurationChoices: async () => threePeriodChoices(7),
  });
  await planChanged.discover();
  const planChangedRecovery = new WebPreopenConfigurationRuntime(planChanged, drafts);
  const planChangedState = await planChangedRecovery.load();
  assert.equal(planChangedState.tag, 'ready');
  if (planChangedState.tag === 'ready') {
    assert.equal(planChangedState.draft.menu, undefined, 'service plan pin must invalidate the stale draft');
  }

  const newer = gameplayRuntime({
    getActiveSave: async () => active(projection(8)),
    getPreopenConfigurationChoices: async () => choices(8),
  });
  await newer.discover();
  const recovered = new WebPreopenConfigurationRuntime(newer, drafts);
  const recoveredState = await recovered.load();
  assert.equal(recoveredState.tag, 'ready');
  if (recoveredState.tag === 'ready') assert.equal(recoveredState.draft.menu, undefined);
  assert.ok(drafts.current, 'the current empty draft is re-persisted under the newer pin');

  const hidden = 'private-token-must-not-leak';
  const failing = gameplayRuntime({
    getActiveSave: async () => active(projection(7)),
    getPreopenConfigurationChoices: async () => {
      throw new Error(hidden);
    },
  });
  await failing.discover();
  const unavailable = await new WebPreopenConfigurationRuntime(failing).load();
  assert.deepEqual(unavailable, { tag: 'unavailable', code: 'PREOPEN_CONFIGURATION_CHOICES_UNAVAILABLE' });
  assert.doesNotMatch(JSON.stringify(unavailable), new RegExp(hidden));
});

async function loadedConfiguration(): Promise<WebPreopenConfigurationRuntime> {
  const gameplay = gameplayRuntime({
    getActiveSave: async () => active(projection(7)),
    getPreopenConfigurationChoices: async () => choices(7),
  });
  await gameplay.discover();
  const configuration = new WebPreopenConfigurationRuntime(gameplay);
  await configuration.load();
  return configuration;
}

function completeDraft(configuration: WebPreopenConfigurationRuntime): void {
  configuration.setMenu(menuSelection(['recipe-1/v1', 'recipe-2/v1', 'recipe-3/v1']));
  configuration.setPurchases([]);
  configuration.setLayout({
    servicePoint: { x: 0, y: 0 },
    fixtures: [
      { kind: 'WALKWAY', x: 1, y: 0 },
      { kind: 'SEAT', x: 2, y: 0 },
    ],
  });
}

function menuSelection(
  recipeVersionIds: readonly string[],
  priceModifierPercentByRecipe = Object.fromEntries(recipeVersionIds.map((recipeVersionId) => [recipeVersionId, 0])),
) {
  return { recipeVersionIds, priceModifierPercentByRecipe, enabledSubstitutionIds: [] } as const;
}

function gameplayRuntime(overrides: Partial<WebGameplayTransport>): WebGameplayRuntime {
  return new WebGameplayRuntime({
    getAccessToken: async () => 'web-access-token',
    createClient: () => client(overrides),
  });
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

function projection(
  expectedVersion: number,
  phase: GameplayProjection['phase'] = 'CONFIGURE_REQUIRED',
): GameplayProjection {
  return {
    schemaVersion: 'gameplay.current-projection/v1',
    save: {
      id: 'save-1',
      aggregateVersion: expectedVersion,
      openingScenario: 'DEFAULT_SMALL_SHOP',
      operatingMode: 'STRATEGY',
      servicePeriodPlan: 'TWO_PERIODS',
      difficultyGroup: 'DEFAULT',
      simulationRuleVersion: 'mvp-e01-v1',
    },
    phase,
    nextCommand: phase === 'CONFIGURE_REQUIRED' ? 'CONFIGURE_PREOPEN_DAY' : 'OPEN_BUSINESS_DAY',
    expectedVersion,
    businessDay: null,
    dayEnd: null,
  } as GameplayProjection;
}

function threePeriodProjection(expectedVersion: number): GameplayProjection {
  return {
    ...projection(expectedVersion),
    save: {
      ...projection(expectedVersion).save,
      servicePeriodPlan: 'THREE_PERIODS',
    },
  };
}

function openProjection(expectedVersion: number): GameplayProjection {
  return {
    ...projection(expectedVersion, 'OPEN_REQUIRED'),
    preopenSnapshot: { id: 'preopen-1', hash },
    businessDay: {
      businessDay: 1,
      status: 'PREOPEN',
      simulationRuleVersion: 'mvp-e01-v1',
      completedServicePeriods: 0,
      totalServicePeriods: 2,
      nextPeriodKey: null,
    },
  };
}

function active(activeSave: GameplayProjection): ActiveGameplaySaveDiscovery {
  return {
    schemaVersion: 'gameplay.active-save-discovery/v1',
    state: 'ACTIVE_SAVE',
    bootstrap: null,
    activeSave,
  };
}

function choices(
  expectedVersion: number,
  limits: Readonly<{ purchaseCapacity?: number }> = {},
): PreopenConfigurationChoices {
  const purchaseCapacity = limits.purchaseCapacity ?? 10;
  return {
    save: {
      id: 'save-1',
      expectedVersion,
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
      difficulty: 'STANDARD',
      requiredRecipeCount: 3,
      themeId: 'bistro',
      recipeCards: [1, 2, 3, 4].map((number) => ({
        recipeVersionId: `recipe-${number}/v1`,
        recipeId: `recipe-${number}`,
        baseQuality: 80,
        ingredients: [
          { ingredientId: 'ingredient-a', quantityPoints: 1 },
          { ingredientId: 'ingredient-b', quantityPoints: 2 },
        ],
        basePrice: money(100),
        priceOptions: Array.from({ length: 21 }, (_, index) => ({ modifierPercent: index - 10, salePrice: money(100 + index) })),
        substitutionIds: [],
      })),
      substitutions: [],
    },
    procurement: {
      settlementCurrency: 'TWD',
      spendLimit: money(purchaseCapacity * 10),
      poolCapacities: { DURABLE: purchaseCapacity, PERISHABLE: purchaseCapacity },
      lockedDay1Quotes: [
        { ingredientId: 'ingredient-a', pool: 'DURABLE', unitPrice: money(10), priceModifierBps: 0 },
        { ingredientId: 'ingredient-b', pool: 'PERISHABLE', unitPrice: money(20), priceModifierBps: 0 },
      ],
    },
    floor: {
      catalogVersion: 'e02-space-v1',
      width: 4,
      height: 4,
      usableFloorCells: 16,
      maxSeats: 4,
      maxWaitingGroups: 1,
      allowedFixtureKinds: ['SEAT', 'WALKWAY', 'WAITING_ZONE'],
      constraints: {
        phase: 'PRE_OPEN',
        exactScenarioDimensionsRequired: true,
        servicePointInBoundsRequired: true,
        servicePointMustNotOverlapFixture: true,
        fixtureIdsMustBeUnique: true,
        fixturesMustBeInBounds: true,
        fixturesMustNotOverlap: true,
        seatsAndWaitingZonesRequireWalkwayConnection: true,
      },
    },
  };
}

function threePeriodChoices(expectedVersion: number): PreopenConfigurationChoices {
  const value = choices(expectedVersion);
  return {
    ...value,
    save: {
      ...value.save,
      servicePeriodPlan: 'THREE_PERIODS',
      servicePeriods: ['LUNCH', 'OFF_PEAK', 'DINNER'],
    },
  };
}

function money(minorUnits: number) {
  return { currency: 'TWD' as const, minorUnits: String(minorUnits) };
}

function completedReceipt() {
  return {
    commandId: 'command-1',
    idempotencyKey: 'key-1',
    commandType: 'CONFIGURE_PREOPEN_DAY',
    aggregateId: 'save-1',
    aggregateVersion: 8,
    result: {},
  } as never;
}

class MemoryDraftStore implements PreopenConfigurationDraftStore {
  current: unknown | undefined;

  read(): unknown | undefined {
    return this.current;
  }

  write(draft: unknown): void {
    this.current = JSON.parse(JSON.stringify(draft)) as unknown;
  }

  clear(): void {
    this.current = undefined;
  }
}

class StatusError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}
