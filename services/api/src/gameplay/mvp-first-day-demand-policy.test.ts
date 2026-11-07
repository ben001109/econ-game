import assert from 'node:assert/strict';
import test from 'node:test';

import { configureFirstDayLayout, type LayoutSnapshot } from '../domains/demand-flow/demand-flow.js';
import type { PreopenDemandBuilder } from './preopen-day-plan.js';
import {
  MVP_FIRST_DAY_DEMAND_SIMULATION_RULE_VERSION,
  resolveMvpFirstDayDemandBuilder,
  selectMvpFirstDayWeather,
} from './mvp-first-day-demand-policy.js';

function layout(): LayoutSnapshot {
  return configureFirstDayLayout(
    0,
    {
      width: 10,
      height: 9,
      servicePoint: { x: 0, y: 0 },
      fixtures: [
        { fixtureId: 'walkway-1', kind: 'WALKWAY', x: 1, y: 0 },
        { fixtureId: 'seat-1', kind: 'SEAT', x: 2, y: 0 },
      ],
    },
    'DEFAULT_SMALL_SHOP',
    'TWO_PERIODS',
    'PRE_OPEN',
    'BASIC',
  ).snapshot;
}

function builderInput(
  overrides: Partial<Parameters<PreopenDemandBuilder['create']>[0]> = {},
): Parameters<PreopenDemandBuilder['create']>[0] {
  return {
    businessDay: 1,
    scenario: 'DEFAULT_SMALL_SHOP',
    operatingMode: 'STRATEGY',
    servicePeriodPlan: 'TWO_PERIODS',
    demandSeed: 'first-day-policy-seed',
    simulationRuleVersion: MVP_FIRST_DAY_DEMAND_SIMULATION_RULE_VERSION,
    activeRecipeVersionIds: ['bistro-rice-v1', 'bistro-greens-v1', 'bistro-chicken-v1'],
    priceModifierPercentByRecipe: {
      'bistro-rice-v1': 0,
      'bistro-greens-v1': -1,
      'bistro-chicken-v1': 1,
    },
    layout: layout(),
    ...overrides,
  };
}

test('uses the persisted seed deterministically and preserves the private forecast contract', () => {
  const builder = resolveMvpFirstDayDemandBuilder(MVP_FIRST_DAY_DEMAND_SIMULATION_RULE_VERSION);
  const input = builderInput();
  const first = builder.create(input);
  const second = builder.create(input);

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.schedule.demandSeed, input.demandSeed);
  assert.deepEqual(first.forecast.disclosure, {
    exactArrivalTimesShown: false,
    individualOrdersShown: false,
    demandSeedShown: false,
    exactPatienceCountdownShown: false,
  });
  assert.equal(JSON.stringify(first.forecast).includes(input.demandSeed), false);
  for (const group of first.schedule.groups) {
    assert.ok(group.basePatienceTicks >= 8 && group.basePatienceTicks <= 12);
  }
});

test('seeded mild weather is limited to and can select all three exact policy buckets', () => {
  const seen = new Map<number, string>();
  for (let index = 0; seen.size < 3 && index < 10_000; index += 1) {
    const seed = `weather-policy-seed-${index}`;
    const weather = selectMvpFirstDayWeather(seed);
    seen.set(weather.demandModifierPercent, seed);
    assert.ok([-5, 0, 5].includes(weather.demandModifierPercent));
  }
  assert.deepEqual([...seen.keys()].sort((left, right) => left - right), [-5, 0, 5]);
  for (const [modifier, seed] of seen) {
    assert.equal(selectMvpFirstDayWeather(seed).demandModifierPercent, modifier);
  }
});

test('uses the locked two- and three-period tick windows', () => {
  const builder = resolveMvpFirstDayDemandBuilder(MVP_FIRST_DAY_DEMAND_SIMULATION_RULE_VERSION);
  const two = builder.create(builderInput());
  for (const group of two.schedule.groups) {
    if (group.period === 'LUNCH') assert.ok(group.arrivalTick >= 0 && group.arrivalTick <= 9);
    if (group.period === 'DINNER') assert.ok(group.arrivalTick >= 10 && group.arrivalTick <= 19);
    assert.notEqual(group.period, 'OFF_PEAK');
  }

  const three = builder.create(
    builderInput({ servicePeriodPlan: 'THREE_PERIODS', demandSeed: 'three-period-policy-seed' }),
  );
  for (const group of three.schedule.groups) {
    if (group.period === 'LUNCH') assert.ok(group.arrivalTick >= 0 && group.arrivalTick <= 7);
    if (group.period === 'OFF_PEAK') assert.ok(group.arrivalTick >= 8 && group.arrivalTick <= 11);
    if (group.period === 'DINNER') assert.ok(group.arrivalTick >= 12 && group.arrivalTick <= 19);
  }
  assert.ok(three.schedule.groups.some((group) => group.period === 'OFF_PEAK'));
});

test('passes exact active recipe IDs and price modifiers to the recipe-price demand flow', () => {
  const builder = resolveMvpFirstDayDemandBuilder(MVP_FIRST_DAY_DEMAND_SIMULATION_RULE_VERSION);
  const input = builderInput({
    activeRecipeVersionIds: ['recipe-c:v1', 'recipe-a:v1'],
    priceModifierPercentByRecipe: { 'recipe-c:v1': 10, 'recipe-a:v1': -10 },
  });
  const result = builder.create(input);
  for (const group of result.schedule.groups) {
    assert.deepEqual(new Set(group.recipePreferenceOrder), new Set(input.activeRecipeVersionIds));
  }
  assert.notEqual(result.schedule.actualDemandGroups, result.schedule.weatherAdjustedGroups);
});

test('fails closed for an unknown rule, non-first day, invalid period plan, seed, and menu modifiers', () => {
  assert.throws(() => resolveMvpFirstDayDemandBuilder('mvp-e01-v2'), /unknown first-day simulation rule/);
  const builder = resolveMvpFirstDayDemandBuilder(MVP_FIRST_DAY_DEMAND_SIMULATION_RULE_VERSION);
  for (const input of [
    builderInput({ businessDay: 2 as 1 }),
    builderInput({ demandSeed: ' bad-seed' }),
    builderInput({ servicePeriodPlan: 'FOUR_PERIODS' as 'TWO_PERIODS' }),
    builderInput({ priceModifierPercentByRecipe: { 'bistro-rice-v1': 0 } }),
    builderInput({
      priceModifierPercentByRecipe: {
        'bistro-rice-v1': 11,
        'bistro-greens-v1': -1,
        'bistro-chicken-v1': 1,
      },
    }),
  ]) {
    assert.throws(() => builder.create(input));
  }
});
