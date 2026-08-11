import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateThreePeriodDinnerPeakFixture,
  calculateFlowIndicators,
  calculatePriceConversionFactor,
  canEnterFirstDayWaitingQueue,
  configureFirstDayLayout,
  createFirstDayDemandSchedule,
  createPreOpeningForecast,
  discloseDemandReplay,
  FORECAST_ERROR_RATE,
  FIRST_DAY_SPACE_CATALOG_VERSION,
  GROUP_SIZE_DISTRIBUTION,
  lockServerDemandDifficulty,
  NORMAL_DEMAND_GROUPS,
  resolveFirstDaySpaceLimits,
  validateFirstDayLayout,
  type FirstDayDemandInput,
  type FirstDayFixture,
  type FirstDayLayout,
  type ServicePeriodPlan,
} from './demand-flow.js';

const tickWindows = Object.freeze({
  LUNCH: { start: 0, end: 9 },
  OFF_PEAK: { start: 10, end: 14 },
  DINNER: { start: 15, end: 29 },
});

function demandInput(overrides: Partial<FirstDayDemandInput> = {}): FirstDayDemandInput {
  return {
    scenario: 'DEFAULT_SMALL_SHOP',
    periodPlan: 'TWO_PERIODS',
    operatingMode: 'STRATEGY',
    demandSeed: 'competitive-save-seed-001',
    weather: { label: 'LIGHT_CLOUD', demandModifierPercent: 0 },
    priceModifierPercentByCohort: {
      PRICE_SENSITIVE: 0,
      TIME_SENSITIVE: 0,
      EXPERIENCE_ORIENTED: 0,
    },
    basePatienceTicks: { min: 8, max: 12 },
    periodTickWindows: { LUNCH: tickWindows.LUNCH, DINNER: tickWindows.DINNER },
    ...overrides,
  };
}

test('locks all three opening-scenario normal demand totals for two- and three-period plans', () => {
  assert.deepEqual(NORMAL_DEMAND_GROUPS, {
    DEFAULT_SMALL_SHOP: { TWO_PERIODS: 24, THREE_PERIODS: 30 },
    EMPTY_PREMISES: { TWO_PERIODS: 20, THREE_PERIODS: 25 },
    TROUBLED_SHOP: { TWO_PERIODS: 19, THREE_PERIODS: 24 },
  });

  for (const [scenario, plans] of Object.entries(NORMAL_DEMAND_GROUPS)) {
    for (const periodPlan of Object.keys(plans) as ServicePeriodPlan[]) {
      const windows =
        periodPlan === 'TWO_PERIODS'
          ? { LUNCH: tickWindows.LUNCH, DINNER: tickWindows.DINNER }
          : tickWindows;
      const schedule = createFirstDayDemandSchedule(
        demandInput({
          scenario: scenario as FirstDayDemandInput['scenario'],
          periodPlan,
          periodTickWindows: windows,
        }),
      );
      assert.equal(schedule.normalDemandGroups, plans[periodPlan]);
      assert.equal(schedule.actualDemandGroups, plans[periodPlan]);
      assert.equal(schedule.groups.length, plans[periodPlan]);
    }
  }
});

test('uses the locked period distributions and only the three regular customer cohorts', () => {
  const two = createFirstDayDemandSchedule(demandInput());
  assert.deepEqual(
    Object.fromEntries(
      ['LUNCH', 'DINNER'].map((period) => [
        period,
        two.groups.filter((group) => group.period === period).length,
      ]),
    ),
    { LUNCH: 10, DINNER: 14 },
  );

  const three = createFirstDayDemandSchedule(
    demandInput({ periodPlan: 'THREE_PERIODS', periodTickWindows: tickWindows }),
  );
  const threePeriodShares = { LUNCH: 0.35, OFF_PEAK: 0.15, DINNER: 0.5 } as const;
  for (const [period, share] of Object.entries(threePeriodShares)) {
    const actual = three.groups.filter((group) => group.period === period).length;
    assert.ok(Math.abs(actual - three.actualDemandGroups * share) <= 1);
  }
  assert.equal(
    three.groups.every((group) => group.kind === 'REGULAR'),
    true,
  );
  assert.deepEqual(
    new Set(three.groups.map((group) => group.cohort)),
    new Set(['PRICE_SENSITIVE', 'TIME_SENSITIVE', 'EXPERIENCE_ORIENTED']),
  );
});

test('allocates group sizes 1-4 by the fixed 15/55/20/10 distribution with pairs dominant', () => {
  const schedule = createFirstDayDemandSchedule(
    demandInput({ periodPlan: 'THREE_PERIODS', periodTickWindows: tickWindows }),
  );
  const counts = new Map<number, number>();
  for (const group of schedule.groups) counts.set(group.size, (counts.get(group.size) ?? 0) + 1);

  for (const size of [1, 2, 3, 4] as const) {
    const expected = schedule.actualDemandGroups * GROUP_SIZE_DISTRIBUTION[size];
    assert.ok(Math.abs((counts.get(size) ?? 0) - expected) <= 1);
  }
  assert.ok((counts.get(2) ?? 0) > (counts.get(1) ?? 0));
  assert.ok((counts.get(2) ?? 0) > (counts.get(3) ?? 0));
  assert.ok((counts.get(2) ?? 0) > (counts.get(4) ?? 0));
});

test('applies the exact E03 elasticity formula, 1% steps, and the first-day total cap', () => {
  assert.equal(calculatePriceConversionFactor('PRICE_SENSITIVE', 10), 0.85);
  assert.equal(calculatePriceConversionFactor('TIME_SENSITIVE', 10), 0.95);
  assert.equal(calculatePriceConversionFactor('EXPERIENCE_ORIENTED', -10), 1.1);
  assert.throws(() => calculatePriceConversionFactor('PRICE_SENSITIVE', 10.5), /whole 1% step/);
  assert.throws(() => calculatePriceConversionFactor('PRICE_SENSITIVE', 11), /-10 through 10/);

  const expensive = createFirstDayDemandSchedule(
    demandInput({
      priceModifierPercentByCohort: {
        PRICE_SENSITIVE: 10,
        TIME_SENSITIVE: 10,
        EXPERIENCE_ORIENTED: 10,
      },
    }),
  );
  assert.ok(
    expensive.actualDemandGroups >= Math.floor(expensive.weatherAdjustedGroups * 0.9 + 0.5),
  );
  assert.ok(
    expensive.actualDemandGroups <= Math.floor(expensive.weatherAdjustedGroups * 1.1 + 0.5),
  );

  const discounted = createFirstDayDemandSchedule(
    demandInput({
      priceModifierPercentByCohort: {
        PRICE_SENSITIVE: -10,
        TIME_SENSITIVE: -10,
        EXPERIENCE_ORIENTED: -10,
      },
    }),
  );
  assert.ok(
    discounted.actualDemandGroups <= Math.floor(discounted.weatherAdjustedGroups * 1.1 + 0.5),
  );
  assert.ok(discounted.actualDemandGroups > expensive.actualDemandGroups);
});

test('limits forecastable first-day weather to plus or minus 5 percent before price conversion', () => {
  const positive = createFirstDayDemandSchedule(
    demandInput({ weather: { label: 'LIGHT_TAILWIND', demandModifierPercent: 5 } }),
  );
  const negative = createFirstDayDemandSchedule(
    demandInput({ weather: { label: 'LIGHT_RAIN', demandModifierPercent: -5 } }),
  );
  assert.equal(positive.weatherAdjustedGroups, 25);
  assert.equal(negative.weatherAdjustedGroups, 23);
  assert.throws(
    () =>
      createFirstDayDemandSchedule(
        demandInput({ weather: { label: 'STORM', demandModifierPercent: 5.01 } }),
      ),
    /plus or minus 5%/,
  );
});

test('same seed and locked inputs produce byte-identical replay schedules', () => {
  const first = createFirstDayDemandSchedule(demandInput());
  const second = createFirstDayDemandSchedule(demandInput());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.groups), true);
  assert.equal(first.replayEvents.length, first.actualDemandGroups + 1);
  assert.deepEqual(
    first.replayEvents.map((event) => event.sequence),
    Array.from({ length: first.replayEvents.length }, (_, index) => index),
  );
  for (const group of first.groups) {
    const factor =
      group.cohort === 'TIME_SENSITIVE' ? 0.75 : group.cohort === 'EXPERIENCE_ORIENTED' ? 1.25 : 1;
    assert.equal(group.hiddenPatienceTicks, Math.floor(group.basePatienceTicks * factor + 0.5));
  }

  const otherSeed = createFirstDayDemandSchedule(demandInput({ demandSeed: 'different-seed' }));
  assert.notEqual(JSON.stringify(first.groups), JSON.stringify(otherSeed.groups));
});

test('strategy and lightweight realtime share all-day demand but may model detailed flow differently', () => {
  const strategy = createFirstDayDemandSchedule(demandInput({ operatingMode: 'STRATEGY' }));
  const realtime = createFirstDayDemandSchedule(
    demandInput({ operatingMode: 'LIGHTWEIGHT_REALTIME' }),
  );
  assert.equal(strategy.actualDemandGroups, realtime.actualDemandGroups);
  assert.equal(strategy.leaderboardCohortKey, 'DEFAULT_SMALL_SHOP|TWO_PERIODS|STRATEGY');
  assert.equal(
    realtime.leaderboardCohortKey,
    'DEFAULT_SMALL_SHOP|TWO_PERIODS|LIGHTWEIGHT_REALTIME',
  );
  assert.notDeepEqual(strategy.groups, realtime.groups);
});

test('future difficulty is locked and leaderboard-grouped only by active groups and forecast clarity', () => {
  const lock = lockServerDemandDifficulty({
    ruleId: 'demand-difficulty:future:1',
    simultaneousActiveGroupLimit: 8,
    forecastClarityErrorPercent: 12.5,
  });
  assert.deepEqual(lock, {
    ruleId: 'demand-difficulty:future:1',
    simultaneousActiveGroupLimit: 8,
    forecastClarityErrorPercent: 12.5,
    leaderboardDimensionKey: 'demand-difficulty:future:1|active:8|forecast:12.5',
    locked: true,
  });
  assert.equal(Object.isFrozen(lock), true);
  assert.throws(
    () =>
      lockServerDemandDifficulty({
        ruleId: 'invalid',
        simultaneousActiveGroupLimit: 0,
        forecastClarityErrorPercent: 5,
      }),
    /positive integer/,
  );
  assert.throws(
    () =>
      lockServerDemandDifficulty({
        ruleId: 'invalid',
        simultaneousActiveGroupLimit: 1,
        forecastClarityErrorPercent: 101,
      }),
    /0 through 100/,
  );
});

test('pre-opening forecast rounds scenario error to whole groups and leaks no seed or individual flow', () => {
  const schedule = createFirstDayDemandSchedule(demandInput());
  const forecast = createPreOpeningForecast(schedule, { min: 8, max: 12 });
  assert.equal(FORECAST_ERROR_RATE.DEFAULT_SMALL_SHOP, 0.05);
  assert.deepEqual(forecast.allDayGroups, { min: 23, max: 25 });
  assert.deepEqual(forecast.patienceTicks, {
    PRICE_SENSITIVE: { min: 8, max: 12 },
    TIME_SENSITIVE: { min: 6, max: 9 },
    EXPERIENCE_ORIENTED: { min: 10, max: 15 },
  });
  assert.deepEqual(forecast.disclosure, {
    exactArrivalTimesShown: false,
    individualOrdersShown: false,
    demandSeedShown: false,
    exactPatienceCountdownShown: false,
  });
  const publicJson = JSON.stringify(forecast);
  assert.equal(publicJson.includes(schedule.demandSeed), false);
  assert.equal(publicJson.includes('arrivalTick'), false);
  assert.equal(publicJson.includes('groupId'), false);
});

test('demand seed and exact schedule are disclosed only after settlement', () => {
  const schedule = createFirstDayDemandSchedule(demandInput());
  assert.throws(() => discloseDemandReplay(schedule, 'PRE_OPEN'), /only after day settlement/);
  assert.throws(() => discloseDemandReplay(schedule, 'OPERATING'), /only after day settlement/);
  assert.deepEqual(discloseDemandReplay(schedule, 'DAY_SETTLED'), {
    day: 1,
    demandSeed: schedule.demandSeed,
    actualDemandGroups: schedule.actualDemandGroups,
    groups: schedule.groups,
    events: schedule.replayEvents,
  });
});

test('rejects invalid plans, missing windows, empty seed, and invalid patience ranges', () => {
  assert.throws(() => createFirstDayDemandSchedule(demandInput({ demandSeed: ' ' })), /seed/);
  assert.throws(
    () => createFirstDayDemandSchedule(demandInput({ basePatienceTicks: { min: 0, max: 1 } })),
    /patience/,
  );
  assert.throws(
    () =>
      createFirstDayDemandSchedule(
        demandInput({
          periodPlan: 'THREE_PERIODS',
          periodTickWindows: { LUNCH: tickWindows.LUNCH, DINNER: tickWindows.DINNER },
        }),
      ),
    /OFF_PEAK requires/,
  );
});

const layout: FirstDayLayout = {
  width: 10,
  height: 9,
  servicePoint: { x: 0, y: 1 },
  fixtures: [
    { fixtureId: 'walk:1', kind: 'WALKWAY', x: 1, y: 1 },
    { fixtureId: 'walk:2', kind: 'WALKWAY', x: 2, y: 1 },
    { fixtureId: 'walk:3', kind: 'WALKWAY', x: 3, y: 1 },
    { fixtureId: 'walk:4', kind: 'WALKWAY', x: 4, y: 1 },
    { fixtureId: 'seat:1', kind: 'SEAT', x: 2, y: 0 },
    { fixtureId: 'seat:2', kind: 'SEAT', x: 4, y: 0 },
    { fixtureId: 'wait:1', kind: 'WAITING_ZONE', x: 5, y: 1 },
    { fixtureId: 'wait:2', kind: 'WAITING_ZONE', x: 4, y: 2 },
  ],
};

function layoutAtCanonicalCaps(
  scenario: FirstDayDemandInput['scenario'],
): Readonly<{ layout: FirstDayLayout; unused: readonly Readonly<{ x: number; y: number }>[] }> {
  const limits = resolveFirstDaySpaceLimits(scenario);
  const servicePoint = { x: 0, y: 0 };
  const walkwayColumns = new Set<number>();
  for (let x = 1; x < limits.width; x += 3) walkwayColumns.add(x);
  const fixtures: FirstDayFixture[] = [];
  const occupied = new Set<string>(['0,0']);
  for (const x of [...walkwayColumns].sort((left, right) => left - right)) {
    for (let y = 0; y < limits.height; y += 1) {
      const key = `${x},${y}`;
      if (occupied.has(key)) continue;
      occupied.add(key);
      fixtures.push({ fixtureId: `walk:${x}:${y}`, kind: 'WALKWAY', x, y });
    }
  }
  for (let x = 1; x < limits.width; x += 1) {
    const key = `${x},0`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    fixtures.push({ fixtureId: `walk:${x}:0`, kind: 'WALKWAY', x, y: 0 });
  }
  const available: Array<Readonly<{ x: number; y: number }>> = [];
  for (let y = 1; y < limits.height; y += 1) {
    for (let x = 0; x < limits.width; x += 1) {
      if (!occupied.has(`${x},${y}`) && (walkwayColumns.has(x - 1) || walkwayColumns.has(x + 1))) {
        available.push({ x, y });
      }
    }
  }
  for (let index = 0; index < limits.maxSeats; index += 1) {
    fixtures.push({ fixtureId: `seat:${index + 1}`, kind: 'SEAT', ...available[index]! });
  }
  for (let index = 0; index < limits.maxWaitingGroups; index += 1) {
    fixtures.push({
      fixtureId: `wait:${index + 1}`,
      kind: 'WAITING_ZONE',
      ...available[limits.maxSeats + index]!,
    });
  }
  return {
    layout: { width: limits.width, height: limits.height, servicePoint, fixtures },
    unused: available.slice(limits.maxSeats + limits.maxWaitingGroups),
  };
}

test('e02-space-v1 resolves exact fully usable grids and ignores BASIC, AGED, and repair state', () => {
  assert.equal(FIRST_DAY_SPACE_CATALOG_VERSION, 'e02-space-v1');
  const expected = {
    EMPTY_PREMISES: {
      width: 9,
      height: 8,
      usableFloorCells: 72,
      maxSeats: 26,
      maxWaitingGroups: 3,
    },
    DEFAULT_SMALL_SHOP: {
      width: 10,
      height: 9,
      usableFloorCells: 90,
      maxSeats: 30,
      maxWaitingGroups: 4,
    },
    TROUBLED_SHOP: { width: 8, height: 7, usableFloorCells: 56, maxSeats: 24, maxWaitingGroups: 2 },
  } as const;
  for (const [scenario, values] of Object.entries(expected)) {
    const baseline = resolveFirstDaySpaceLimits(scenario as FirstDayDemandInput['scenario']);
    assert.deepEqual(baseline, {
      catalogVersion: 'e02-space-v1',
      scenario,
      ...values,
    });
    assert.equal(baseline.usableFloorCells, baseline.width * baseline.height);
    for (const state of ['BASIC', 'AGED', 'REPAIRED'] as const) {
      assert.equal(
        JSON.stringify(
          resolveFirstDaySpaceLimits(scenario as FirstDayDemandInput['scenario'], state),
        ),
        JSON.stringify(baseline),
      );
    }
  }
});

test('canonical three-period dinner fixtures reproduce 30/34/27 people and 10-20% overload', () => {
  assert.deepEqual(calculateThreePeriodDinnerPeakFixture('EMPTY_PREMISES'), {
    scenario: 'EMPTY_PREMISES',
    peakGroups: 13,
    peakPeople: 30,
    seatLimit: 26,
    rawPeakOverloadRatio: 0.153846,
    rawPeakOverloadPercent: 15.38,
  });
  assert.deepEqual(calculateThreePeriodDinnerPeakFixture('DEFAULT_SMALL_SHOP'), {
    scenario: 'DEFAULT_SMALL_SHOP',
    peakGroups: 15,
    peakPeople: 34,
    seatLimit: 30,
    rawPeakOverloadRatio: 0.133333,
    rawPeakOverloadPercent: 13.33,
  });
  assert.deepEqual(calculateThreePeriodDinnerPeakFixture('TROUBLED_SHOP'), {
    scenario: 'TROUBLED_SHOP',
    peakGroups: 12,
    peakPeople: 27,
    seatLimit: 24,
    rawPeakOverloadRatio: 0.125,
    rawPeakOverloadPercent: 12.5,
  });
});

test('seat and complete-group waiting counts pass exactly at each cap and reject plus one', () => {
  for (const scenario of ['EMPTY_PREMISES', 'DEFAULT_SMALL_SHOP', 'TROUBLED_SHOP'] as const) {
    const fixture = layoutAtCanonicalCaps(scenario);
    validateFirstDayLayout(fixture.layout, scenario);
    const limits = resolveFirstDaySpaceLimits(scenario);
    assert.equal(canEnterFirstDayWaitingQueue(scenario, limits.maxWaitingGroups - 1), true);
    assert.equal(canEnterFirstDayWaitingQueue(scenario, limits.maxWaitingGroups), false);
    assert.throws(
      () =>
        validateFirstDayLayout(
          {
            ...fixture.layout,
            fixtures: [
              ...fixture.layout.fixtures,
              { fixtureId: 'seat:over-cap', kind: 'SEAT', ...fixture.unused[0]! },
            ],
          },
          scenario,
        ),
      /seat or waiting-group limit/,
    );
    assert.throws(
      () =>
        validateFirstDayLayout(
          {
            ...fixture.layout,
            fixtures: [
              ...fixture.layout.fixtures,
              { fixtureId: 'wait:over-cap', kind: 'WAITING_ZONE', ...fixture.unused[1]! },
            ],
          },
          scenario,
        ),
      /seat or waiting-group limit/,
    );
  }
});

test('configuration is allowed pre-open and between periods, while all three service peaks lock', () => {
  const preOpen = configureFirstDayLayout(
    0,
    layout,
    'DEFAULT_SMALL_SHOP',
    'TWO_PERIODS',
    'PRE_OPEN',
  );
  assert.equal(preOpen.snapshot.revision, 1);
  assert.equal(preOpen.snapshot.layoutHash.length, 64);
  assert.deepEqual(preOpen.snapshot.spaceLimits, resolveFirstDaySpaceLimits('DEFAULT_SMALL_SHOP'));
  assert.deepEqual(preOpen.event, {
    type: 'LAYOUT_CONFIGURED',
    revision: 1,
    phase: 'PRE_OPEN',
    scenario: 'DEFAULT_SMALL_SHOP',
    spaceCatalogVersion: 'e02-space-v1',
    layoutHash: preOpen.snapshot.layoutHash,
  });
  assert.equal(Object.isFrozen(preOpen.snapshot.layout.fixtures), true);
  const between = configureFirstDayLayout(
    1,
    layout,
    'DEFAULT_SMALL_SHOP',
    'THREE_PERIODS',
    'BETWEEN_SERVICE_PERIODS',
  );
  assert.equal(between.snapshot.revision, 2);
  assert.throws(
    () =>
      configureFirstDayLayout(
        1,
        layout,
        'DEFAULT_SMALL_SHOP',
        'TWO_PERIODS',
        'BETWEEN_SERVICE_PERIODS',
      ),
    /locked during peak/,
  );
  for (const peak of ['LUNCH', 'OFF_PEAK', 'DINNER'] as const) {
    assert.throws(
      () => configureFirstDayLayout(1, layout, 'DEFAULT_SMALL_SHOP', 'THREE_PERIODS', peak),
      /locked during peak/,
    );
  }
});

test('layout snapshot, replay, limits, and raw metrics are deterministic across equipment states', () => {
  const reversed = { ...layout, fixtures: [...layout.fixtures].reverse() };
  const first = configureFirstDayLayout(
    0,
    layout,
    'DEFAULT_SMALL_SHOP',
    'TWO_PERIODS',
    'PRE_OPEN',
    'BASIC',
  );
  const second = configureFirstDayLayout(
    0,
    reversed,
    'DEFAULT_SMALL_SHOP',
    'TWO_PERIODS',
    'PRE_OPEN',
    'AGED',
  );
  assert.equal(first.snapshot.layoutHash, second.snapshot.layoutHash);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const state = { seatedGuests: 2, waitingGroups: 3, activeGuests: 6, demandGroups: 10 };
  assert.equal(
    JSON.stringify(calculateFlowIndicators(layout, 'DEFAULT_SMALL_SHOP', state, 'BASIC')),
    JSON.stringify(calculateFlowIndicators(layout, 'DEFAULT_SMALL_SHOP', state, 'REPAIRED')),
  );
});

test('computes raw deterministic walkway, congestion, capacity, and visibility indicators', () => {
  const indicators = calculateFlowIndicators(layout, 'DEFAULT_SMALL_SHOP', {
    seatedGuests: 2,
    waitingGroups: 3,
    activeGuests: 6,
    demandGroups: 10,
  });
  assert.deepEqual(indicators, {
    seatCapacity: 2,
    waitingCapacity: 2,
    walkwayCells: 4,
    averageSeatWalkwayDistanceSteps: 4,
    maximumSeatWalkwayDistanceSteps: 5,
    visibleWaitingAreas: 1,
    waitingVisibilityRatio: 0.5,
    seatedGuestPressure: 1,
    waitingGroupPressure: 1.5,
    walkwayLoad: 1.5,
    queueDemandRatio: 0.3,
  });
});

test('first-day layout permits only SEAT, WALKWAY, and WAITING_ZONE on the canonical grid', () => {
  validateFirstDayLayout(layout, 'DEFAULT_SMALL_SHOP');
  assert.throws(
    () =>
      validateFirstDayLayout(
        {
          ...layout,
          fixtures: [
            ...layout.fixtures,
            { fixtureId: 'kitchen', kind: 'KITCHEN' as 'WALKWAY', x: 0, y: 3 },
          ],
        },
        'DEFAULT_SMALL_SHOP',
      ),
    /only seats/,
  );
  assert.throws(
    () => validateFirstDayLayout({ ...layout, width: 9 }, 'DEFAULT_SMALL_SHOP'),
    /canonical fully usable scenario grid/,
  );
  assert.throws(
    () =>
      validateFirstDayLayout(
        {
          ...layout,
          fixtures: [...layout.fixtures, { fixtureId: 'isolated', kind: 'SEAT', x: 0, y: 8 }],
        },
        'DEFAULT_SMALL_SHOP',
      ),
    /static walkway network/,
  );
  assert.throws(
    () =>
      validateFirstDayLayout(
        {
          ...layout,
          fixtures: [...layout.fixtures, { fixtureId: 'overlap', kind: 'SEAT', x: 1, y: 1 }],
        },
        'DEFAULT_SMALL_SHOP',
      ),
    /cannot overlap/,
  );
});
