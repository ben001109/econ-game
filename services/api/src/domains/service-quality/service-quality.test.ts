import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ABILITY_FACTOR,
  F_WORK,
  K_WORK,
  MORALE_FACTOR,
  ROLE_BASE,
  calculateFoodQuality,
  calculateServiceSpeed,
  calculateWorkCapacity,
  simulateServiceDay,
  updateFairnessReputation,
  updateOrderReputation,
  type ServiceDayInput,
} from './service-quality.js';

const recipes = [
  {
    id: 'noodles',
    baseQuality: 85,
    substitutionQualityDelta: 0,
    recommendedPrice: 100,
    salePrice: 110,
    portions: 0,
  },
  {
    id: 'rice',
    baseQuality: 80,
    substitutionQualityDelta: -5,
    recommendedPrice: 100,
    salePrice: 100,
    portions: 10,
  },
] as const;

const workers = [
  {
    id: 'cook',
    role: 'KITCHEN_STAFF',
    ability: 'MEDIUM',
    morale: 'NORMAL',
    kind: 'NPC',
    present: true,
  },
  {
    id: 'cashier',
    role: 'CASHIER',
    ability: 'MEDIUM',
    morale: 'NORMAL',
    kind: 'NPC',
    present: true,
  },
] as const;

function createReplayInput(): ServiceDayInput {
  return {
    demandSeed: 'day-1-seed',
    recipes,
    arrivals: [
      {
        groupId: 'reselects',
        arrivalTick: 0,
        cohort: 'PRICE_SENSITIVE',
        size: 2,
        basePatienceTicks: 30,
        recipePreferenceOrder: ['noodles', 'rice'],
      },
      {
        groupId: 'waits-too-long',
        arrivalTick: 0,
        cohort: 'TIME_SENSITIVE',
        size: 2,
        basePatienceTicks: 1,
        recipePreferenceOrder: ['rice', 'noodles'],
      },
    ],
    ticks: Array.from({ length: 22 }, (_, tick) => ({
      tick,
      admissionCapacity: tick === 0 ? 1 : 0,
      demand: 10,
      queueVisibility: 1,
      periodWeight: 1,
    })),
    workers,
    equipment: { kitchen: 'BASIC', front: 'BASIC' },
    kitchenExecutionQualityModifier: 0,
    fairness: { fulfilledAuthorizedHours: 8, scheduledAuthorizedHours: 10 },
  };
}

test('uses the confirmed K/F work constants and role, ability, morale, and equipment capacity', () => {
  assert.equal(K_WORK, 12);
  assert.equal(F_WORK, 8);
  assert.deepEqual(ROLE_BASE, {
    KITCHEN_STAFF: 1,
    OWNER_KITCHEN: 0.7,
    MANAGER_KITCHEN: 0.55,
    CASHIER: 1,
    MANAGER_FRONT: 0.75,
    OWNER_FRONT: 0.65,
  });
  assert.deepEqual(ABILITY_FACTOR, { LOW: 0.8, MEDIUM: 1, HIGH: 1.15 });
  assert.deepEqual(MORALE_FACTOR, { LOW: 0.9, NORMAL: 1, HIGH: 1.1 });

  const capacity = calculateWorkCapacity(
    [
      {
        id: 'old-low-cook',
        role: 'KITCHEN_STAFF',
        ability: 'HIGH',
        morale: 'LOW',
        kind: 'NPC',
        present: true,
      },
      {
        id: 'owner',
        role: 'OWNER_KITCHEN',
        ability: 'MEDIUM',
        morale: 'NORMAL',
        kind: 'PLAYER',
        present: true,
      },
    ],
    'KITCHEN',
    { kitchen: 'AGED', front: 'BASIC' },
    ['owner'],
  );

  assert.equal(capacity, 1.47475);
  assert.equal(
    calculateWorkCapacity(
      [
        {
          id: 'low-morale-npc',
          role: 'KITCHEN_STAFF',
          ability: 'MEDIUM',
          morale: 'LOW',
          kind: 'NPC',
          present: true,
        },
      ],
      'KITCHEN',
      { kitchen: 'BASIC', front: 'BASIC' },
    ),
    0.9,
  );
  assert.equal(
    calculateWorkCapacity(
      [
        {
          id: 'high-morale-npc',
          role: 'KITCHEN_STAFF',
          ability: 'MEDIUM',
          morale: 'HIGH',
          kind: 'NPC',
          present: true,
        },
      ],
      'KITCHEN',
      { kitchen: 'BASIC', front: 'BASIC' },
    ),
    1.1,
  );
  assert.equal(
    calculateWorkCapacity(
      [
        {
          id: 'high-morale-player',
          role: 'KITCHEN_STAFF',
          ability: 'MEDIUM',
          morale: 'HIGH',
          kind: 'PLAYER',
          present: true,
        },
      ],
      'KITCHEN',
      { kitchen: 'BASIC', front: 'BASIC' },
      ['high-morale-player'],
    ),
    1,
  );
  assert.equal(calculateWorkCapacity(workers, 'FRONT', { kitchen: 'BASIC', front: 'AGED' }), 1);
});

test('replays sold-out reselection once, patience departure, and the full service workflow', () => {
  const result = simulateServiceDay(createReplayInput());
  const order = result.orders[0];

  assert.equal(order.recipeId, 'rice');
  assert.equal(order.state, 'SERVED');
  assert.equal(order.kitchenWork, 12);
  assert.equal(order.frontWork, 8);
  assert.equal(order.servedTick, 19);
  assert.equal(order.foodQuality, 75);
  assert.equal(order.serviceSpeed, 100);
  assert.equal(order.lowMoraleKitchenContributionApplied, false);
  assert.deepEqual(result.departedGroupIds, ['waits-too-long']);
  assert.deepEqual(
    result.events
      .filter((event) => event.type === 'ORDER_STATE_CHANGED')
      .map((event) => event.details.to),
    ['CREATED', 'PREPARING', 'READY', 'SERVED'],
  );
  assert.equal(result.events.filter((event) => event.type === 'RESELECTED_ONCE').length, 1);
  assert.equal(result.events.filter((event) => event.type === 'WAITING_LEFT').length, 1);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.events), true);
});

test('leaves without an order when neither preferred nor ranked alternatives can be supplied', () => {
  const input = createReplayInput();
  const result = simulateServiceDay({
    ...input,
    recipes: recipes.map((recipe) => ({ ...recipe, portions: 0 })),
    arrivals: [input.arrivals[0]],
  });

  assert.equal(result.orders.length, 0);
  assert.deepEqual(result.departedGroupIds, ['reselects']);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ['GROUP_ARRIVED', 'PREFERRED_SOLD_OUT', 'SOLD_OUT_LEFT', 'FAIRNESS_UPDATED'],
  );
});

test('emits FLOW_RISK_HIGH only after queue/demand is strictly above 1.2 for two consecutive ticks', () => {
  const arrivals = Array.from({ length: 14 }, (_, index) => ({
    groupId: `group-${index}`,
    arrivalTick: 0,
    cohort: 'EXPERIENCE_ORIENTED' as const,
    size: 1,
    basePatienceTicks: 10,
    recipePreferenceOrder: ['rice'],
  }));
  const base = createReplayInput();
  const risk = simulateServiceDay({
    ...base,
    arrivals,
    ticks: [
      { tick: 0, admissionCapacity: 0, demand: 10, queueVisibility: 1, periodWeight: 1 },
      { tick: 1, admissionCapacity: 0, demand: 10, queueVisibility: 1, periodWeight: 1 },
    ],
    fairness: undefined,
  });
  const boundary = simulateServiceDay({
    ...base,
    arrivals: arrivals.slice(0, 12),
    ticks: [
      { tick: 0, admissionCapacity: 0, demand: 10, queueVisibility: 1, periodWeight: 1 },
      { tick: 1, admissionCapacity: 0, demand: 10, queueVisibility: 1, periodWeight: 1 },
    ],
    fairness: undefined,
  });

  assert.equal(risk.flowRiskHigh, true);
  assert.equal(risk.events.filter((event) => event.type === 'FLOW_RISK_HIGH').length, 1);
  assert.equal(risk.events.find((event) => event.type === 'FLOW_RISK_HIGH')?.tick, 1);
  assert.equal(boundary.flowRiskHigh, false);
});

test('applies food quality, service speed, and five-dimensional reputation formulas with clamps', () => {
  assert.equal(
    calculateFoodQuality({
      recipeBaseQuality: 85,
      substitutionQualityDelta: 0,
      kitchenExecutionQualityModifier: 0,
      equipmentCondition: 'AGED',
      lowMoraleKitchenContribution: false,
    }),
    75,
  );
  assert.equal(
    calculateFoodQuality({
      recipeBaseQuality: 75,
      substitutionQualityDelta: -10,
      kitchenExecutionQualityModifier: -100,
      equipmentCondition: 'AGED',
      lowMoraleKitchenContribution: true,
    }),
    0,
  );
  assert.equal(calculateServiceSpeed(10, 10), 100);
  assert.equal(calculateServiceSpeed(15, 10), 50);
  assert.equal(calculateServiceSpeed(20, 10), 0);
  assert.equal(calculateServiceSpeed(30, 10), 0);

  const reputation = updateOrderReputation(
    { price: 100, speed: 0, quality: 50, fairness: 50, vibe: 50 },
    {
      salePrice: 110,
      recommendedPrice: 100,
      serviceSpeed: 100,
      foodQuality: 100,
      queueCongestion: 3,
    },
  );
  assert.deepEqual(reputation, {
    price: 99.6,
    speed: 0.4,
    quality: 50.4,
    fairness: 50,
    vibe: 49.2,
  });
  assert.equal(
    updateFairnessReputation(reputation, {
      fulfilledAuthorizedHours: 0,
      scheduledAuthorizedHours: 10,
    }).fairness,
    49.2,
  );
});

test('attributes low-morale quality only to orders receiving that NPC capacity contribution', () => {
  const base = createReplayInput();
  const result = simulateServiceDay({
    ...base,
    arrivals: [
      {
        groupId: 'first',
        arrivalTick: 0,
        cohort: 'PRICE_SENSITIVE',
        size: 1,
        basePatienceTicks: 10,
        recipePreferenceOrder: ['rice'],
      },
      {
        groupId: 'second',
        arrivalTick: 0,
        cohort: 'PRICE_SENSITIVE',
        size: 1,
        basePatienceTicks: 10,
        recipePreferenceOrder: ['rice'],
      },
    ],
    ticks: [
      {
        tick: 0,
        admissionCapacity: 2,
        demand: 2,
        queueVisibility: 1,
        periodWeight: 1,
      },
    ],
    workers: [
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `normal-${String(index).padStart(2, '0')}`,
        role: 'KITCHEN_STAFF' as const,
        ability: 'MEDIUM' as const,
        morale: 'NORMAL' as const,
        kind: 'NPC' as const,
        present: true,
      })),
      {
        id: 'z-low-cook',
        role: 'KITCHEN_STAFF',
        ability: 'MEDIUM',
        morale: 'LOW',
        kind: 'NPC',
        present: true,
      },
    ],
    fairness: undefined,
  });

  const normalOnlyOrder = result.orders.find((order) => order.kitchenWork === K_WORK);
  const lowMoraleOrder = result.orders.find((order) => order.kitchenWork === 0.9);
  assert.equal(normalOnlyOrder?.lowMoraleKitchenContributionApplied, false);
  assert.equal(lowMoraleOrder?.lowMoraleKitchenContributionApplied, true);
  assert.deepEqual(
    result.events
      .filter(
        (event) =>
          event.type === 'WORK_CONTRIBUTION' && event.details.contributorKey === 'z-low-cook',
      )
      .map((event) => event.details),
    [
      {
        pool: 'KITCHEN',
        contributorKey: 'z-low-cook',
        orderId: lowMoraleOrder?.id,
        units: 0.9,
      },
    ],
  );
});

test('does not emit or apply a low-morale contribution when that kitchen NPC is idle', () => {
  const base = createReplayInput();
  const result = simulateServiceDay({
    ...base,
    arrivals: [
      {
        groupId: 'normal-only',
        arrivalTick: 0,
        cohort: 'PRICE_SENSITIVE',
        size: 1,
        basePatienceTicks: 20,
        recipePreferenceOrder: ['rice'],
      },
    ],
    ticks: Array.from({ length: 9 }, (_, tick) => ({
      tick,
      admissionCapacity: tick === 0 ? 1 : 0,
      demand: 1,
      queueVisibility: 1,
      periodWeight: 1,
    })),
    workers: [
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `normal-${String(index).padStart(2, '0')}`,
        role: 'KITCHEN_STAFF' as const,
        ability: 'MEDIUM' as const,
        morale: 'NORMAL' as const,
        kind: 'NPC' as const,
        present: true,
      })),
      {
        id: 'z-idle-low-cook',
        role: 'KITCHEN_STAFF',
        ability: 'MEDIUM',
        morale: 'LOW',
        kind: 'NPC',
        present: true,
      },
      workers[1],
    ],
    fairness: undefined,
  });

  assert.equal(result.orders[0].state, 'SERVED');
  assert.equal(result.orders[0].foodQuality, 75);
  assert.equal(result.orders[0].lowMoraleKitchenContributionApplied, false);
  assert.equal(
    result.events.some(
      (event) =>
        event.type === 'WORK_CONTRIBUTION' && event.details.contributorKey === 'z-idle-low-cook',
    ),
    false,
  );
});

test('records a low-morale cashier only in front contributions without food penalty', () => {
  const base = createReplayInput();
  const result = simulateServiceDay({
    ...base,
    arrivals: [
      {
        groupId: 'cashier-order',
        arrivalTick: 0,
        cohort: 'PRICE_SENSITIVE',
        size: 1,
        basePatienceTicks: 20,
        recipePreferenceOrder: ['rice'],
      },
    ],
    ticks: Array.from({ length: 10 }, (_, tick) => ({
      tick,
      admissionCapacity: tick === 0 ? 1 : 0,
      demand: 1,
      queueVisibility: 1,
      periodWeight: 1,
    })),
    workers: [
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `normal-${String(index).padStart(2, '0')}`,
        role: 'KITCHEN_STAFF' as const,
        ability: 'MEDIUM' as const,
        morale: 'NORMAL' as const,
        kind: 'NPC' as const,
        present: true,
      })),
      {
        id: 'low-cashier',
        role: 'CASHIER',
        ability: 'MEDIUM',
        morale: 'LOW',
        kind: 'NPC',
        present: true,
      },
    ],
    fairness: undefined,
  });

  const cashierContributions = result.events.filter(
    (event) => event.type === 'WORK_CONTRIBUTION' && event.details.contributorKey === 'low-cashier',
  );
  assert.ok(cashierContributions.length > 0);
  assert.ok(cashierContributions.every((event) => event.details.pool === 'FRONT'));
  assert.equal(result.orders[0].state, 'SERVED');
  assert.equal(result.orders[0].foodQuality, 75);
  assert.equal(result.orders[0].lowMoraleKitchenContributionApplied, false);
});

test('produces byte-identical output for identical seed and replay inputs', () => {
  const first = simulateServiceDay(createReplayInput());
  const second = simulateServiceDay(createReplayInput());

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(
    JSON.stringify(first.events.filter((event) => event.type === 'WORK_CONTRIBUTION')),
    JSON.stringify(second.events.filter((event) => event.type === 'WORK_CONTRIBUTION')),
  );
  for (const order of first.orders) {
    if (order.foodQuality !== undefined) {
      assert.ok(order.foodQuality >= 0 && order.foodQuality <= 100);
    }
    if (order.serviceSpeed !== undefined) {
      assert.ok(order.serviceSpeed >= 0 && order.serviceSpeed <= 100);
    }
  }
  for (const score of Object.values(first.reputation)) {
    assert.ok(score >= 0 && score <= 100);
  }
});

test('rejects invalid snapshots before simulation', () => {
  const input = createReplayInput();

  assert.throws(() => simulateServiceDay({ ...input, demandSeed: '' }), /seed/);
  assert.throws(
    () =>
      simulateServiceDay({
        ...input,
        recipes: [{ ...recipes[0], baseQuality: 74 }],
      }),
    /base quality/,
  );
  assert.throws(() => calculateServiceSpeed(1, 0), /positive/);
});
