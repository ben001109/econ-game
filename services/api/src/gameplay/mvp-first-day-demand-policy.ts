import { createHash } from 'node:crypto';

import {
  createFirstDayDemandSchedule,
  createPreOpeningForecast,
  type ServicePeriod,
  type ServicePeriodPlan,
  type TickWindow,
} from '../domains/demand-flow/demand-flow.js';
import type { OpeningScenario } from '../domains/opening-scenario/catalog.js';
import type { CompetitiveOperatingMode } from '../domains/opening-scenario/snapshot.js';
import type { PreopenDemandBuilder } from './preopen-day-plan.js';

/**
 * Server registry key for the only first-day demand policy currently supported
 * by the E01 opening snapshot registry. This is deliberately not a client
 * selectable ruleset: callers must resolve the policy from persisted authority.
 */
export const MVP_FIRST_DAY_DEMAND_SIMULATION_RULE_VERSION = 'mvp-e01-v1' as const;
export const MVP_FIRST_DAY_DEMAND_POLICY_VERSION = 'mvp-first-day-demand-policy/v1' as const;

export type MvpFirstDayWeather = Readonly<{
  label: 'LIGHT_RAIN' | 'CLEAR' | 'LIGHT_TAILWIND';
  demandModifierPercent: -5 | 0 | 5;
}>;

type DemandBuilderInput = Parameters<PreopenDemandBuilder['create']>[0];

const weatherBuckets = Object.freeze([
  Object.freeze({ label: 'LIGHT_RAIN', demandModifierPercent: -5 }),
  Object.freeze({ label: 'CLEAR', demandModifierPercent: 0 }),
  Object.freeze({ label: 'LIGHT_TAILWIND', demandModifierPercent: 5 }),
] as const satisfies readonly MvpFirstDayWeather[]);

const tickWindowsByPlan = Object.freeze({
  TWO_PERIODS: Object.freeze({
    LUNCH: Object.freeze({ start: 0, end: 9 }),
    DINNER: Object.freeze({ start: 10, end: 19 }),
  }),
  THREE_PERIODS: Object.freeze({
    LUNCH: Object.freeze({ start: 0, end: 7 }),
    OFF_PEAK: Object.freeze({ start: 8, end: 11 }),
    DINNER: Object.freeze({ start: 12, end: 19 }),
  }),
} satisfies Readonly<
  Record<ServicePeriodPlan, Readonly<Partial<Record<ServicePeriod, TickWindow>>>>
>);
const basePatienceTicks = Object.freeze({ min: 8, max: 12 });
const openingScenarios = new Set<OpeningScenario>([
  'DEFAULT_SMALL_SHOP',
  'EMPTY_PREMISES',
  'TROUBLED_SHOP',
]);
const operatingModes = new Set<CompetitiveOperatingMode>(['STRATEGY', 'LIGHTWEIGHT_REALTIME']);
const periodPlans = new Set<ServicePeriodPlan>(['TWO_PERIODS', 'THREE_PERIODS']);

function assertCanonicalDemandSeed(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error('first-day server demand seed must be a non-empty canonical string');
  }
}

function assertPlainDataRecord(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${name} must be a plain server-authoritative record`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) {
      throw new Error(`${name}.${key} must be a data property`);
    }
  }
}

function assertExactKeys(value: unknown, expected: readonly string[], name: string): void {
  assertPlainDataRecord(value, name);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} contains unknown or missing server-authority fields`);
  }
}

function assertMenuAuthority(
  activeRecipeVersionIds: unknown,
  priceModifierPercentByRecipe: unknown,
): asserts activeRecipeVersionIds is readonly string[] {
  if (!Array.isArray(activeRecipeVersionIds) || activeRecipeVersionIds.length === 0) {
    throw new Error('first-day active recipe IDs must be a non-empty server-authoritative array');
  }
  const recipeIds = new Set<string>();
  for (const recipeId of activeRecipeVersionIds) {
    if (typeof recipeId !== 'string' || recipeId.length === 0 || recipeId.trim() !== recipeId) {
      throw new Error('first-day active recipe IDs must be canonical strings');
    }
    if (recipeIds.has(recipeId)) {
      throw new Error('first-day active recipe IDs must not contain duplicates');
    }
    recipeIds.add(recipeId);
  }

  assertPlainDataRecord(priceModifierPercentByRecipe, 'first-day price modifiers');
  const modifierIds = Object.keys(priceModifierPercentByRecipe);
  if (
    modifierIds.length !== recipeIds.size ||
    modifierIds.some((recipeId) => !recipeIds.has(recipeId))
  ) {
    throw new Error('first-day price modifiers must map exactly the active recipe IDs');
  }
  for (const recipeId of recipeIds) {
    const modifier = priceModifierPercentByRecipe[recipeId];
    if (!Number.isInteger(modifier) || modifier < -10 || modifier > 10) {
      throw new Error('first-day price modifiers must be whole percentages from -10 through 10');
    }
  }
}

function assertBuilderAuthority(input: DemandBuilderInput): void {
  assertExactKeys(
    input,
    [
      'activeRecipeVersionIds',
      'businessDay',
      'demandSeed',
      'layout',
      'operatingMode',
      'priceModifierPercentByRecipe',
      'scenario',
      'servicePeriodPlan',
      'simulationRuleVersion',
    ],
    'first-day demand builder input',
  );
  if (input.businessDay !== 1) {
    throw new Error('first-day server demand policy accepts only business day 1');
  }
  if (input.simulationRuleVersion !== MVP_FIRST_DAY_DEMAND_SIMULATION_RULE_VERSION) {
    throw new Error('unknown first-day simulation rule version; replay cannot fall back to latest');
  }
  if (!openingScenarios.has(input.scenario)) throw new Error('unknown first-day opening scenario');
  if (!operatingModes.has(input.operatingMode)) throw new Error('unknown first-day operating mode');
  if (!periodPlans.has(input.servicePeriodPlan))
    throw new Error('unknown first-day service period plan');
  assertCanonicalDemandSeed(input.demandSeed);
  if (input.layout === null || typeof input.layout !== 'object') {
    throw new Error('first-day layout authority is required');
  }
  assertMenuAuthority(input.activeRecipeVersionIds, input.priceModifierPercentByRecipe);
}

/**
 * The weather bucket is deterministic, visible in the pre-open forecast, and
 * bounded to the three confirmed mild first-day modifiers. It derives solely
 * from the persisted demand seed and this policy version.
 */
export function selectMvpFirstDayWeather(demandSeed: string): MvpFirstDayWeather {
  assertCanonicalDemandSeed(demandSeed);
  const bucketIndex =
    createHash('sha256')
      .update(`${MVP_FIRST_DAY_DEMAND_POLICY_VERSION}:weather:${demandSeed}`, 'utf8')
      .digest()[0]! % weatherBuckets.length;
  return weatherBuckets[bucketIndex]!;
}

function createMvpFirstDayDemand(input: DemandBuilderInput) {
  assertBuilderAuthority(input);
  const schedule = createFirstDayDemandSchedule({
    scenario: input.scenario,
    periodPlan: input.servicePeriodPlan,
    operatingMode: input.operatingMode,
    demandSeed: input.demandSeed,
    weather: selectMvpFirstDayWeather(input.demandSeed),
    activeRecipeVersionIds: [...input.activeRecipeVersionIds],
    priceModifierPercentByRecipe: { ...input.priceModifierPercentByRecipe },
    basePatienceTicks,
    periodTickWindows: tickWindowsByPlan[input.servicePeriodPlan],
  });
  return Object.freeze({
    schedule,
    forecast: createPreOpeningForecast(schedule, basePatienceTicks),
  });
}

const mvpFirstDayDemandBuilder: PreopenDemandBuilder = Object.freeze({
  create: createMvpFirstDayDemand,
});

/**
 * Resolves the sole supported first-day builder from a persisted simulation
 * rule. There is intentionally no default/latest fallback and no client input
 * for weather, patience, or service-period windows.
 */
export function resolveMvpFirstDayDemandBuilder(
  simulationRuleVersion: string,
): PreopenDemandBuilder {
  if (simulationRuleVersion !== MVP_FIRST_DAY_DEMAND_SIMULATION_RULE_VERSION) {
    throw new Error('unknown first-day simulation rule version; replay cannot fall back to latest');
  }
  return mvpFirstDayDemandBuilder;
}
