import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLOOR_FLOW_SERVICE_PROFILE_VERSION,
  FIRST_DAY_SPACE_CATALOG_VERSION,
  type DemandGroup,
  type DemandSchedule,
  type ServicePeriodPlan,
} from '../domains/demand-flow/demand-flow.js';
import { createMoney } from '../domains/money/money.js';
import type {
  CatalogSubstitution,
  IngredientCatalogItem,
  RecipeVersion,
} from '../domains/inventory-procurement/catalog-menu.js';
import {
  createEmptyInventory,
  receiveInventory,
  type InventoryState,
} from '../domains/inventory-procurement/inventory.js';
import type { NpcContractSnapshot } from '../domains/opening-scenario/snapshot.js';
import type { RecipeServiceSnapshot } from '../domains/service-quality/service-quality.js';
import {
  advanceServicePeriod,
  createAdvanceServicePeriodInput,
  parseAdvanceServicePeriodIntent,
  replayAdvanceServicePeriod,
  type AdvanceServicePeriodAuthority,
  type AdvanceServicePeriodResultSnapshot,
} from './advance-service-period.js';

const recipe: RecipeServiceSnapshot = Object.freeze({
  id: 'recipe:rice:v1',
  baseQuality: 80,
  substitutionQualityDelta: 0,
  recommendedPrice: 100,
  salePrice: 100,
  portions: 20,
});

const ingredient: IngredientCatalogItem = Object.freeze({
  id: 'ingredient:rice',
  revision: 'ingredients/v1',
  kind: 'COMMON',
  pool: 'DURABLE',
  referenceUnitPrice: createMoney('TWD', '100'),
  unlockedThemeIds: Object.freeze(['test']),
});

const alternateIngredient: IngredientCatalogItem = Object.freeze({
  ...ingredient,
  id: 'ingredient:greens',
  pool: 'PERISHABLE',
});

const recipeVersion: RecipeVersion = Object.freeze({
  id: recipe.id,
  recipeId: 'recipe:rice',
  version: 1,
  catalogRevision: 'recipes/v1',
  themeId: 'test',
  baseQuality: recipe.baseQuality,
  ingredients: Object.freeze([{ ingredientId: ingredient.id, quantityPoints: 1 }]),
});

function stockedInventory(quantityPoints = 100): InventoryState {
  return receiveInventory(
    createEmptyInventory('TWD', { DURABLE: 200, PERISHABLE: 200 }),
    [ingredient],
    {
      transactionId: 'opening-receipt:rice',
      referenceId: 'opening-purchase:rice',
      ingredientId: ingredient.id,
      quantityPoints,
      totalCost: createMoney('TWD', String(quantityPoints * 100)),
    },
  );
}

function inventoryWithStocks(
  entries: readonly Readonly<{ ingredient: IngredientCatalogItem; quantityPoints: number }>[],
): InventoryState {
  let inventory = createEmptyInventory('TWD', { DURABLE: 200, PERISHABLE: 200 });
  for (const entry of entries) {
    inventory = receiveInventory(inventory, [entry.ingredient], {
      transactionId: `opening-receipt:${entry.ingredient.id}`,
      referenceId: `opening-purchase:${entry.ingredient.id}`,
      ingredientId: entry.ingredient.id,
      quantityPoints: entry.quantityPoints,
      totalCost: createMoney('TWD', String(entry.quantityPoints * 100)),
    });
  }
  return inventory;
}

const profile = Object.freeze({
  version: FLOOR_FLOW_SERVICE_PROFILE_VERSION,
  layoutRevision: 1,
  layoutHash: 'a'.repeat(64),
  spaceCatalogVersion: FIRST_DAY_SPACE_CATALOG_VERSION,
  seatCapacity: 8,
  waitingCapacity: 2,
  queueVisibility: 1,
  frontServiceDelayTicks: 0,
});

function contract(role: 'KITCHEN' | 'CASHIER', morale: 'NORMAL' | 'LOW' = 'NORMAL') {
  const suffix = role.toLowerCase();
  return Object.freeze({
    contractKey: `npc-contract:${suffix}:1`,
    npcKey: `npc:${suffix}:1`,
    role,
    capability: 'MEDIUM',
    morale,
    salary: createMoney('TWD', '100'),
    salaryUnit: 'PER_COMPLETED_SCHEDULED_DAY',
    shiftCoverage: 'ALL_LOCKED_SERVICE_PERIODS',
    effectiveCompletedBusinessDay: 1,
    endCompletedBusinessDay: 30,
    bonusType: 'NONE',
    bonusAmount: createMoney('TWD', '0'),
    profitShareBps: 0,
    termsVersion: 'mvp-e01-opening-v2',
  } as const satisfies NpcContractSnapshot);
}

const fullNpcRoster = Object.freeze([contract('KITCHEN'), contract('CASHIER')]);

function openingReputation(score: number) {
  return Object.freeze({
    dimensions: Object.freeze({
      QUALITY: score,
      SPEED: score,
      PRICE: score,
      FAIRNESS: score,
      VIBE: score,
    }),
    overall: score,
    overallRounding: 'ROUND_HALF_UP' as const,
  });
}

function group(
  groupId: string,
  period: DemandGroup['period'],
  arrivalTick: number,
  options: Readonly<{
    size?: 1 | 2 | 3 | 4;
    hiddenPatienceTicks?: number;
    recipePreferenceOrder?: readonly string[];
  }> = {},
): DemandGroup {
  return Object.freeze({
    groupId,
    kind: 'REGULAR',
    period,
    cohort: 'PRICE_SENSITIVE',
    size: options.size ?? 1,
    arrivalTick,
    basePatienceTicks: 10,
    hiddenPatienceTicks: options.hiddenPatienceTicks ?? 10,
    recipePreferenceOrder: Object.freeze([...(options.recipePreferenceOrder ?? [recipe.id])]),
  });
}

function schedule(plan: ServicePeriodPlan, groups: readonly DemandGroup[]): DemandSchedule {
  return Object.freeze({
    day: 1,
    scenario: 'DEFAULT_SMALL_SHOP',
    periodPlan: plan,
    operatingMode: 'STRATEGY',
    leaderboardCohortKey: `DEFAULT_SMALL_SHOP|${plan}|STRATEGY`,
    demandSeed: 'first-day-demand-seed',
    normalDemandGroups: groups.length,
    weatherAdjustedGroups: groups.length,
    actualDemandGroups: groups.length,
    weather: Object.freeze({ label: 'CLEAR', demandModifierPercent: 0 }),
    groups: Object.freeze([...groups]),
    replayEvents: Object.freeze([]),
  });
}

function authority(
  plan: ServicePeriodPlan,
  groups: readonly DemandGroup[],
  overrides: Partial<AdvanceServicePeriodAuthority> = {},
): AdvanceServicePeriodAuthority {
  const previousInventory = overrides.previousResult?.inventoryState;
  return Object.freeze({
    businessDay: 1,
    servicePeriodPlan: plan,
    initiator: Object.freeze({ actorId: 'actor:owner', role: 'OWNER' }),
    npcContracts: fullNpcRoster,
    demandSchedule: schedule(plan, groups),
    recipes: Object.freeze([recipe]),
    inventoryState: previousInventory ?? stockedInventory(),
    recipeVersions: Object.freeze([recipeVersion]),
    enabledSubstitutions: Object.freeze([] as CatalogSubstitution[]),
    equipment: Object.freeze({ kitchen: 'BASIC', front: 'BASIC' }),
    kitchenExecutionQualityModifier: 0,
    floorFlowServiceProfile: profile,
    openingReputation: openingReputation(50),
    ...overrides,
  });
}

function intent(period: DemandGroup['period'], ownerAssignment: 'KITCHEN' | 'FRONT' | 'NONE') {
  return { businessDay: 1, expectedPeriodKey: period, ownerAssignment };
}

test('strictly parses the only client-owned ADVANCE_SERVICE_PERIOD fields', () => {
  assert.deepEqual(parseAdvanceServicePeriodIntent(intent('LUNCH', 'KITCHEN')), {
    businessDay: 1,
    expectedPeriodKey: 'LUNCH',
    ownerAssignment: 'KITCHEN',
  });
  assert.throws(
    () => parseAdvanceServicePeriodIntent({ ...intent('LUNCH', 'NONE'), seed: 'forged' }),
    /unknown or missing fields/,
  );
  assert.throws(
    () => parseAdvanceServicePeriodIntent({ ...intent('LUNCH', 'NONE'), businessDay: 2 }),
    /only business day 1/,
  );
});

test('runs a resumable two-period plan with immutable hashes and continuous events', () => {
  const groups = [group('lunch:1', 'LUNCH', 0), group('dinner:1', 'DINNER', 10)];
  const lunch = advanceServicePeriod(intent('LUNCH', 'KITCHEN'), authority('TWO_PERIODS', groups));

  assert.equal(lunch.resultSnapshot.status, 'PERIOD_COMPLETE');
  assert.equal(lunch.resultSnapshot.orders.length, 1);
  assert.equal(lunch.resultSnapshot.orders[0]?.state, 'SERVED');
  assert.equal(lunch.resultSnapshot.inventoryOutcomes.length, 1);
  assert.equal(lunch.resultSnapshot.inventoryOutcomes[0]?.cogs.minorUnits, '100');
  assert.equal(lunch.resultSnapshot.inventoryState.stocks[0]?.onHandPoints, 99);
  assert.equal(lunch.resultSnapshot.inventoryState.stocks[0]?.reservedPoints, 0);
  assert.equal(lunch.resultSnapshot.inventoryState.orderReservations.length, 0);
  assert.deepEqual(
    lunch.resultSnapshot.inventoryState.transactions
      .slice(-2)
      .map((transaction) => transaction.type),
    ['ORDER_RESERVED', 'ORDER_COMPLETED'],
  );
  assert.deepEqual(lunch.resultSnapshot.completedPeriodKeys, ['LUNCH']);
  assert.equal(
    lunch.resultSnapshot.workerRoster.filter((worker) => worker.kind === 'PLAYER').length,
    1,
  );
  assert.equal(
    lunch.resultSnapshot.workerRoster.find((worker) => worker.kind === 'PLAYER')?.role,
    'OWNER_KITCHEN',
  );
  assert.ok(
    lunch.resultSnapshot.closingTicks > 0,
    'pending service drains after the period window',
  );
  assert.equal(Object.isFrozen(lunch.inputSnapshot), true);
  assert.equal(Object.isFrozen(lunch.resultSnapshot.events), true);

  const dinner = advanceServicePeriod(
    intent('DINNER', 'FRONT'),
    authority('TWO_PERIODS', groups, { previousResult: lunch.resultSnapshot }),
  );
  assert.deepEqual(dinner.resultSnapshot.completedPeriodKeys, ['LUNCH', 'DINNER']);
  assert.equal(dinner.resultSnapshot.inventoryState.stocks[0]?.onHandPoints, 98);
  const mutationIds = dinner.resultSnapshot.inventoryState.transactions
    .filter((transaction) => transaction.type !== 'RECEIPT')
    .map((transaction) => transaction.transactionId);
  assert.equal(new Set(mutationIds).size, mutationIds.length);
  assert.equal(dinner.inputSnapshot.previousResultHash, lunch.resultSnapshot.resultHash);
  assert.equal(dinner.resultSnapshot.eventSequenceStart, lunch.resultSnapshot.nextEventSequence);
  assert.equal(dinner.resultSnapshot.events[0]?.sequence, lunch.resultSnapshot.nextEventSequence);
  assert.equal(
    dinner.resultSnapshot.workerRoster.find((worker) => worker.kind === 'PLAYER')?.role,
    'OWNER_FRONT',
  );
  assert.throws(
    () =>
      createAdvanceServicePeriodInput(
        intent('LUNCH', 'NONE'),
        authority('TWO_PERIODS', groups, { previousResult: lunch.resultSnapshot }),
      ),
    /stale|canonical order/,
  );
});

test('enforces LUNCH -> OFF_PEAK -> DINNER for the three-period plan', () => {
  const groups = [
    group('lunch:1', 'LUNCH', 0),
    group('off-peak:1', 'OFF_PEAK', 8),
    group('dinner:1', 'DINNER', 12),
  ];
  let previous: AdvanceServicePeriodResultSnapshot | undefined;
  for (const period of ['LUNCH', 'OFF_PEAK', 'DINNER'] as const) {
    const execution = advanceServicePeriod(
      intent(period, 'NONE'),
      authority('THREE_PERIODS', groups, { previousResult: previous }),
    );
    previous = execution.resultSnapshot;
  }
  assert.deepEqual(previous?.completedPeriodKeys, ['LUNCH', 'OFF_PEAK', 'DINNER']);
  assert.throws(
    () =>
      createAdvanceServicePeriodInput(intent('DINNER', 'NONE'), authority('THREE_PERIODS', groups)),
    /stale|canonical order/,
  );
});

test('maps manager assignment without adding any second PLAYER worker', () => {
  const input = createAdvanceServicePeriodInput(
    intent('LUNCH', 'FRONT'),
    authority('TWO_PERIODS', [group('lunch:1', 'LUNCH', 0)], {
      initiator: Object.freeze({ actorId: 'actor:manager', role: 'MANAGER' }),
    }),
  );
  const players = input.workers.filter((worker) => worker.kind === 'PLAYER');
  assert.deepEqual(
    players.map((worker) => worker.role),
    ['MANAGER_FRONT'],
  );
  assert.equal(players[0]?.ability, 'MEDIUM');
  assert.equal(players[0]?.morale, 'NORMAL');
});

test('binds ordinal 1 to E01 opening reputation and later periods only to prior results', () => {
  for (const [scenario, score] of [
    ['DEFAULT_SMALL_SHOP', 50],
    ['EMPTY_PREMISES', 50],
    ['TROUBLED_SHOP', 30],
  ] as const) {
    const input = createAdvanceServicePeriodInput(
      intent('LUNCH', 'NONE'),
      authority('TWO_PERIODS', [group(`${scenario}:lunch`, 'LUNCH', 0)], {
        openingReputation: openingReputation(score),
      }),
    );
    assert.deepEqual(Object.values(input.initialReputation), [score, score, score, score, score]);
  }
  assert.throws(
    () =>
      createAdvanceServicePeriodInput(
        intent('LUNCH', 'NONE'),
        authority('TWO_PERIODS', [group('lunch:1', 'LUNCH', 0)], {
          openingReputation: undefined,
        }),
      ),
    /ordinal 1 requires immutable E01 opening reputation/,
  );

  const groups = [group('lunch:1', 'LUNCH', 0), group('dinner:1', 'DINNER', 10)];
  const lunch = advanceServicePeriod(intent('LUNCH', 'NONE'), authority('TWO_PERIODS', groups));
  const dinnerInput = createAdvanceServicePeriodInput(
    intent('DINNER', 'NONE'),
    authority('TWO_PERIODS', groups, {
      openingReputation: openingReputation(99),
      previousResult: lunch.resultSnapshot,
    }),
  );
  assert.deepEqual(dinnerInput.initialReputation, lunch.resultSnapshot.reputation);
});

test('rejects duplicate NPC contract keys independently of NPC identity', () => {
  const first = contract('KITCHEN');
  const duplicateContractKey = Object.freeze({
    ...contract('CASHIER'),
    contractKey: first.contractKey,
  });
  assert.throws(
    () =>
      createAdvanceServicePeriodInput(
        intent('LUNCH', 'NONE'),
        authority('TWO_PERIODS', [group('lunch:1', 'LUNCH', 0)], {
          npcContracts: Object.freeze([first, duplicateContractKey]),
        }),
      ),
    /NPC contract keys must be unique/,
  );
});

test('never auto-replaces a missing pool and concludes all waiters without creating orders', () => {
  const execution = advanceServicePeriod(
    intent('LUNCH', 'KITCHEN'),
    authority('TWO_PERIODS', [group('waiting:1', 'LUNCH', 0, { hiddenPatienceTicks: 2 })], {
      npcContracts: Object.freeze([]),
    }),
  );
  assert.equal(execution.resultSnapshot.kitchenCapacity, 0.7);
  assert.equal(execution.resultSnapshot.frontCapacity, 0);
  assert.equal(execution.resultSnapshot.admissionEnabled, false);
  assert.equal(execution.resultSnapshot.orders.length, 0);
  assert.deepEqual(execution.resultSnapshot.departedGroupIds, ['waiting:1']);
  assert.deepEqual(execution.resultSnapshot.waitingGroupIds, []);
  assert.equal(execution.resultSnapshot.workerRoster.length, 1);
});

test('drains admitted work and lets a capacity-blocked waiter leave at authoritative patience', () => {
  const constrainedProfile = Object.freeze({ ...profile, seatCapacity: 2 });
  const execution = advanceServicePeriod(
    intent('LUNCH', 'NONE'),
    authority(
      'TWO_PERIODS',
      [
        group('admitted:1', 'LUNCH', 9, { size: 2, hiddenPatienceTicks: 1 }),
        group('waiting:1', 'LUNCH', 9, { size: 2, hiddenPatienceTicks: 1 }),
      ],
      { floorFlowServiceProfile: constrainedProfile },
    ),
  );
  assert.equal(execution.resultSnapshot.orders.length, 1);
  assert.equal(execution.resultSnapshot.orders[0]?.state, 'SERVED');
  assert.equal(execution.resultSnapshot.departedGroupIds.length, 1);
  assert.deepEqual(execution.resultSnapshot.waitingGroupIds, []);
  assert.ok(execution.resultSnapshot.closingTicks >= 2);
  const departedGroupId = execution.resultSnapshot.departedGroupIds[0]!;
  const waitingLeft = execution.resultSnapshot.events.find(
    (event) => event.type === 'WAITING_LEFT' && event.subjectId === departedGroupId,
  );
  assert.equal(waitingLeft?.tick, 11);
});

test('refuses deterministic overflow immediately when the E02 waiting zone is full', () => {
  const fullQueueProfile = Object.freeze({ ...profile, seatCapacity: 0, waitingCapacity: 1 });
  const execution = advanceServicePeriod(
    intent('LUNCH', 'NONE'),
    authority(
      'TWO_PERIODS',
      [
        group('queue:1', 'LUNCH', 0, { hiddenPatienceTicks: 2 }),
        group('queue:2', 'LUNCH', 0, { hiddenPatienceTicks: 2 }),
        group('queue:3', 'LUNCH', 0, { hiddenPatienceTicks: 2 }),
      ],
      { floorFlowServiceProfile: fullQueueProfile },
    ),
  );
  const refused = execution.resultSnapshot.events.filter(
    (event) => event.type === 'WAITING_FULL_LEFT',
  );
  assert.equal(refused.length, 2);
  assert.deepEqual(
    refused.map((event) => event.tick),
    [0, 0],
  );
  assert.equal(
    refused.every((event) => event.details.waitedTicks === 0),
    true,
  );
  assert.equal(
    execution.resultSnapshot.events.filter((event) => event.type === 'WAITING_LEFT').length,
    1,
  );
  assert.equal(execution.resultSnapshot.departedGroupIds.length, 3);
  assert.deepEqual(execution.resultSnapshot.waitingGroupIds, []);
});

test('uses E03 substitution priority and binds per-order quality and COGS to completion', () => {
  const substitution: CatalogSubstitution = Object.freeze({
    id: 'substitution:rice-to-greens',
    catalogRevision: 'substitutions/v1',
    recipeVersionId: recipe.id,
    priority: 10,
    qualityDelta: -3,
    ingredients: Object.freeze([{ ingredientId: alternateIngredient.id, quantityPoints: 1 }]),
  });
  const execution = advanceServicePeriod(
    intent('LUNCH', 'NONE'),
    authority('TWO_PERIODS', [group('substitution:group', 'LUNCH', 0, { size: 2 })], {
      inventoryState: inventoryWithStocks([{ ingredient: alternateIngredient, quantityPoints: 4 }]),
      enabledSubstitutions: Object.freeze([substitution]),
    }),
  );

  const outcome = execution.resultSnapshot.inventoryOutcomes[0]!;
  assert.equal(outcome.substitutionId, substitution.id);
  assert.equal(outcome.substitutionQualityDelta, -3);
  assert.equal(outcome.cogs.minorUnits, '200');
  assert.equal(outcome.consumed[0]?.ingredientId, alternateIngredient.id);
  assert.equal(execution.resultSnapshot.orders[0]?.foodQuality, 77);
  assert.equal(execution.resultSnapshot.inventoryState.stocks[0]?.onHandPoints, 2);
  assert.equal(execution.resultSnapshot.inventoryState.orderReservations.length, 0);
});

test('reserves a ranked alternative before creating the order and leaves cleanly when all recipes sell out', () => {
  const alternativeServiceRecipe: RecipeServiceSnapshot = Object.freeze({
    ...recipe,
    id: 'recipe:greens:v1',
    baseQuality: 82,
  });
  const alternativeRecipeVersion: RecipeVersion = Object.freeze({
    ...recipeVersion,
    id: alternativeServiceRecipe.id,
    recipeId: 'recipe:greens',
    baseQuality: alternativeServiceRecipe.baseQuality,
    ingredients: Object.freeze([{ ingredientId: alternateIngredient.id, quantityPoints: 1 }]),
  });
  const preferenceOrder = Object.freeze([recipe.id, alternativeServiceRecipe.id]);
  const available = advanceServicePeriod(
    intent('LUNCH', 'NONE'),
    authority(
      'TWO_PERIODS',
      [group('reselect:group', 'LUNCH', 0, { recipePreferenceOrder: preferenceOrder })],
      {
        recipes: Object.freeze([recipe, alternativeServiceRecipe]),
        recipeVersions: Object.freeze([recipeVersion, alternativeRecipeVersion]),
        inventoryState: inventoryWithStocks([
          { ingredient: alternateIngredient, quantityPoints: 2 },
        ]),
      },
    ),
  );
  assert.equal(available.resultSnapshot.orders[0]?.recipeId, alternativeServiceRecipe.id);
  assert.equal(
    available.resultSnapshot.inventoryOutcomes[0]?.recipeId,
    alternativeServiceRecipe.id,
  );
  assert.deepEqual(
    available.resultSnapshot.events
      .filter((event) => event.type === 'PREFERRED_SOLD_OUT' || event.type === 'RESELECTED_ONCE')
      .map((event) => event.type),
    ['PREFERRED_SOLD_OUT', 'RESELECTED_ONCE'],
  );
  const reserveTransaction = available.resultSnapshot.inventoryState.transactions.find(
    (transaction) => transaction.type === 'ORDER_RESERVED',
  )!;
  const completeTransaction = available.resultSnapshot.inventoryState.transactions.find(
    (transaction) => transaction.type === 'ORDER_COMPLETED',
  )!;
  assert.equal(reserveTransaction.sequence < completeTransaction.sequence, true);

  const unavailable = advanceServicePeriod(
    intent('LUNCH', 'NONE'),
    authority(
      'TWO_PERIODS',
      [group('sold-out:group', 'LUNCH', 0, { recipePreferenceOrder: preferenceOrder })],
      {
        recipes: Object.freeze([recipe, alternativeServiceRecipe]),
        recipeVersions: Object.freeze([recipeVersion, alternativeRecipeVersion]),
        inventoryState: createEmptyInventory('TWD', { DURABLE: 200, PERISHABLE: 200 }),
      },
    ),
  );
  assert.equal(unavailable.resultSnapshot.orders.length, 0);
  assert.equal(unavailable.resultSnapshot.inventoryOutcomes.length, 0);
  assert.equal(unavailable.resultSnapshot.inventoryState.transactions.length, 0);
  assert.equal(unavailable.resultSnapshot.inventoryState.orderReservations.length, 0);
  assert.equal(
    unavailable.resultSnapshot.events.some((event) => event.type === 'SOLD_OUT_LEFT'),
    true,
  );
});

test('rejects non-canonical recipe scope and external inventory rewind between periods', () => {
  assert.throws(
    () =>
      createAdvanceServicePeriodInput(
        intent('LUNCH', 'NONE'),
        authority('TWO_PERIODS', [group('scope:group', 'LUNCH', 0)], {
          recipeVersions: Object.freeze([{ ...recipeVersion, id: 'forged:recipe:v1' }]),
        }),
      ),
    /map exactly the canonical service recipes/,
  );

  const groups = [group('lunch:inventory', 'LUNCH', 0), group('dinner:inventory', 'DINNER', 10)];
  const lunch = advanceServicePeriod(intent('LUNCH', 'NONE'), authority('TWO_PERIODS', groups));
  assert.throws(
    () =>
      createAdvanceServicePeriodInput(
        intent('DINNER', 'NONE'),
        authority('TWO_PERIODS', groups, {
          previousResult: lunch.resultSnapshot,
          inventoryState: stockedInventory(),
        }),
      ),
    /resume only from the prior E03 inventory result/,
  );
});

test('replays byte-identical results and rejects forged input or previous-result hashes', () => {
  const execution = advanceServicePeriod(
    intent('LUNCH', 'NONE'),
    authority('TWO_PERIODS', [group('lunch:1', 'LUNCH', 0)]),
  );
  assert.deepEqual(replayAdvanceServicePeriod(execution.inputSnapshot), execution.resultSnapshot);

  assert.throws(
    () =>
      replayAdvanceServicePeriod({
        ...execution.inputSnapshot,
        ownerAssignment: 'FRONT',
      }),
    /hash does not match/,
  );
  const forgedPrevious = {
    ...execution.resultSnapshot,
    resultHash: '0'.repeat(64),
  } as AdvanceServicePeriodResultSnapshot;
  assert.throws(
    () =>
      createAdvanceServicePeriodInput(
        intent('DINNER', 'NONE'),
        authority('TWO_PERIODS', [group('lunch:1', 'LUNCH', 0), group('dinner:1', 'DINNER', 10)], {
          previousResult: forgedPrevious,
        }),
      ),
    /hash does not match/,
  );
});

test('canonical hashes are byte-identical for canonically equivalent Unicode-key insertion order', () => {
  const firstProfile = Object.freeze({
    ...profile,
    ['e\u0301']: 'first',
    ['é']: 'second',
  });
  const secondProfile = Object.freeze({
    ...profile,
    ['é']: 'second',
    ['e\u0301']: 'first',
  });
  const first = advanceServicePeriod(
    intent('LUNCH', 'NONE'),
    authority('TWO_PERIODS', [group('lunch:unicode', 'LUNCH', 0)], {
      floorFlowServiceProfile: firstProfile,
    }),
  );
  const second = advanceServicePeriod(
    intent('LUNCH', 'NONE'),
    authority('TWO_PERIODS', [group('lunch:unicode', 'LUNCH', 0)], {
      floorFlowServiceProfile: secondProfile,
    }),
  );

  assert.equal(first.inputSnapshot.inputHash, second.inputSnapshot.inputHash);
  assert.equal(first.resultSnapshot.resultHash, second.resultSnapshot.resultHash);
});
