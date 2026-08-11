import { createHash } from 'node:crypto';

import type { OpeningScenario } from '../opening-scenario/catalog.js';
import type { CompetitiveOperatingMode } from '../opening-scenario/snapshot.js';
import type { CustomerCohort } from '../service-quality/service-quality.js';

export type ServicePeriod = 'LUNCH' | 'OFF_PEAK' | 'DINNER';
export type ServicePeriodPlan = 'TWO_PERIODS' | 'THREE_PERIODS';

export type DemandDifficultyLock = Readonly<{
  ruleId: string;
  simultaneousActiveGroupLimit: number;
  forecastClarityErrorPercent: number;
  leaderboardDimensionKey: string;
  locked: true;
}>;

export const NORMAL_DEMAND_GROUPS = Object.freeze({
  DEFAULT_SMALL_SHOP: Object.freeze({ TWO_PERIODS: 24, THREE_PERIODS: 30 }),
  EMPTY_PREMISES: Object.freeze({ TWO_PERIODS: 20, THREE_PERIODS: 25 }),
  TROUBLED_SHOP: Object.freeze({ TWO_PERIODS: 19, THREE_PERIODS: 24 }),
} satisfies Readonly<Record<OpeningScenario, Readonly<Record<ServicePeriodPlan, number>>>>);

export const GROUP_SIZE_DISTRIBUTION = Object.freeze({ 1: 0.15, 2: 0.55, 3: 0.2, 4: 0.1 });

export const PERIOD_DISTRIBUTION = Object.freeze({
  TWO_PERIODS: Object.freeze({ LUNCH: 0.4, DINNER: 0.6 }),
  THREE_PERIODS: Object.freeze({ LUNCH: 0.35, OFF_PEAK: 0.15, DINNER: 0.5 }),
} satisfies Readonly<Record<ServicePeriodPlan, Readonly<Partial<Record<ServicePeriod, number>>>>>);

export const COHORT_DISTRIBUTION = Object.freeze({
  LUNCH: Object.freeze({
    PRICE_SENSITIVE: 0.3,
    TIME_SENSITIVE: 0.5,
    EXPERIENCE_ORIENTED: 0.2,
  }),
  OFF_PEAK: Object.freeze({
    PRICE_SENSITIVE: 0.5,
    TIME_SENSITIVE: 0.3,
    EXPERIENCE_ORIENTED: 0.2,
  }),
  DINNER: Object.freeze({
    PRICE_SENSITIVE: 0.35,
    TIME_SENSITIVE: 0.2,
    EXPERIENCE_ORIENTED: 0.45,
  }),
} satisfies Readonly<Record<ServicePeriod, Readonly<Record<CustomerCohort, number>>>>);

export const COHORT_ELASTICITY = Object.freeze({
  PRICE_SENSITIVE: 1.5,
  TIME_SENSITIVE: 0.5,
  EXPERIENCE_ORIENTED: 1,
} satisfies Readonly<Record<CustomerCohort, number>>);

export const COHORT_PATIENCE_FACTOR = Object.freeze({
  PRICE_SENSITIVE: 1,
  TIME_SENSITIVE: 0.75,
  EXPERIENCE_ORIENTED: 1.25,
} satisfies Readonly<Record<CustomerCohort, number>>);

export const FORECAST_ERROR_RATE = Object.freeze({
  DEFAULT_SMALL_SHOP: 0.05,
  TROUBLED_SHOP: 0.1,
  EMPTY_PREMISES: 0.15,
} satisfies Readonly<Record<OpeningScenario, number>>);

const COHORTS = Object.freeze([
  'PRICE_SENSITIVE',
  'TIME_SENSITIVE',
  'EXPERIENCE_ORIENTED',
] as const satisfies readonly CustomerCohort[]);

const PERIODS_BY_PLAN = Object.freeze({
  TWO_PERIODS: Object.freeze(['LUNCH', 'DINNER'] as const),
  THREE_PERIODS: Object.freeze(['LUNCH', 'OFF_PEAK', 'DINNER'] as const),
});

export type TickWindow = Readonly<{ start: number; end: number }>;
export type PatienceRange = Readonly<{ min: number; max: number }>;

export type FirstDayDemandInput = Readonly<{
  scenario: OpeningScenario;
  periodPlan: ServicePeriodPlan;
  operatingMode: CompetitiveOperatingMode;
  demandSeed: string;
  weather: Readonly<{
    label: string;
    demandModifierPercent: number;
  }>;
  priceModifierPercentByCohort: Readonly<Record<CustomerCohort, number>>;
  basePatienceTicks: PatienceRange;
  periodTickWindows: Readonly<Partial<Record<ServicePeriod, TickWindow>>>;
}>;

export type DemandGroup = Readonly<{
  groupId: string;
  kind: 'REGULAR';
  period: ServicePeriod;
  cohort: CustomerCohort;
  size: 1 | 2 | 3 | 4;
  arrivalTick: number;
  basePatienceTicks: number;
  hiddenPatienceTicks: number;
}>;

export type DemandReplayEvent = Readonly<{
  sequence: number;
  type: 'FIRST_DAY_DEMAND_SCHEDULED' | 'DEMAND_GROUP_SCHEDULED';
  subjectId: string;
  details: Readonly<Record<string, string | number>>;
}>;

export type DemandSchedule = Readonly<{
  day: 1;
  scenario: OpeningScenario;
  periodPlan: ServicePeriodPlan;
  operatingMode: CompetitiveOperatingMode;
  leaderboardCohortKey: string;
  demandSeed: string;
  normalDemandGroups: number;
  weatherAdjustedGroups: number;
  actualDemandGroups: number;
  weather: Readonly<{ label: string; demandModifierPercent: number }>;
  groups: readonly DemandGroup[];
  replayEvents: readonly DemandReplayEvent[];
}>;

export type DemandForecast = Readonly<{
  day: 1;
  periodPlan: ServicePeriodPlan;
  weather: Readonly<{ label: string; demandModifierPercent: number }>;
  allDayGroups: Readonly<{ min: number; max: number }>;
  periods: readonly Readonly<{
    period: ServicePeriod;
    groups: Readonly<{ min: number; max: number }>;
    mainCohortTendencies: readonly CustomerCohort[];
  }>[];
  patienceTicks: Readonly<Record<CustomerCohort, PatienceRange>>;
  disclosure: Readonly<{
    exactArrivalTimesShown: false;
    individualOrdersShown: false;
    demandSeedShown: false;
    exactPatienceCountdownShown: false;
  }>;
}>;

export type DemandReplayDisclosure = Readonly<{
  day: 1;
  demandSeed: string;
  actualDemandGroups: number;
  groups: readonly DemandGroup[];
  events: readonly DemandReplayEvent[];
}>;

type WeightedKey<T extends string | number> = Readonly<{ key: T; weight: number }>;

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function lockServerDemandDifficulty(
  definition: Readonly<{
    ruleId: string;
    simultaneousActiveGroupLimit: number;
    forecastClarityErrorPercent: number;
  }>,
): DemandDifficultyLock {
  if (definition.ruleId.trim().length === 0) throw new Error('difficulty rule ID is required');
  if (
    !Number.isInteger(definition.simultaneousActiveGroupLimit) ||
    definition.simultaneousActiveGroupLimit <= 0
  ) {
    throw new Error('simultaneous active group limit must be a positive integer');
  }
  assertFinite(definition.forecastClarityErrorPercent, 'forecast clarity error percent');
  if (definition.forecastClarityErrorPercent < 0 || definition.forecastClarityErrorPercent > 100) {
    throw new Error('forecast clarity error percent must be from 0 through 100');
  }
  return deepFreeze({
    ruleId: definition.ruleId,
    simultaneousActiveGroupLimit: definition.simultaneousActiveGroupLimit,
    forecastClarityErrorPercent: definition.forecastClarityErrorPercent,
    leaderboardDimensionKey: `${definition.ruleId}|active:${definition.simultaneousActiveGroupLimit}|forecast:${definition.forecastClarityErrorPercent}`,
    locked: true,
  });
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

function roundHalfUp(value: number): number {
  if (value < 0) throw new Error('roundHalfUp accepts only non-negative values');
  return Math.floor(value + 0.5);
}

function roundSix(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function stableSeedOrder(seed: string, namespace: string): number {
  let hash = 2_166_136_261;
  const value = `${seed}:${namespace}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function allocateByLargestRemainder<T extends string | number>(
  total: number,
  weightedKeys: readonly WeightedKey<T>[],
  seed: string,
  namespace: string,
): Map<T, number> {
  if (!Number.isInteger(total) || total < 0)
    throw new Error('allocation total must be a non-negative integer');
  const weightTotal = weightedKeys.reduce((sum, item) => sum + item.weight, 0);
  if (
    weightTotal <= 0 ||
    weightedKeys.some((item) => !Number.isFinite(item.weight) || item.weight < 0)
  ) {
    throw new Error('allocation weights must be finite, non-negative, and have a positive sum');
  }

  const rows = weightedKeys.map((item) => {
    const exact = (total * item.weight) / weightTotal;
    const floor = Math.floor(exact);
    return { ...item, count: floor, remainder: exact - floor };
  });
  let remaining = total - rows.reduce((sum, row) => sum + row.count, 0);
  rows.sort(
    (left, right) =>
      right.remainder - left.remainder ||
      stableSeedOrder(seed, `${namespace}:${String(left.key)}`) -
        stableSeedOrder(seed, `${namespace}:${String(right.key)}`) ||
      String(left.key).localeCompare(String(right.key)),
  );
  for (const row of rows) {
    if (remaining === 0) break;
    row.count += 1;
    remaining -= 1;
  }
  return new Map(rows.map((row) => [row.key, row.count]));
}

export function calculatePriceConversionFactor(
  cohort: CustomerCohort,
  priceModifierPercent: number,
): number {
  assertFinite(priceModifierPercent, 'price modifier percent');
  if (
    !Number.isInteger(priceModifierPercent) ||
    priceModifierPercent < -10 ||
    priceModifierPercent > 10
  ) {
    throw new Error('price modifier percent must be a whole 1% step from -10 through 10');
  }
  return roundSix(1 - COHORT_ELASTICITY[cohort] * (priceModifierPercent / 100));
}

function validateDemandInput(input: FirstDayDemandInput): void {
  if (!(input.scenario in NORMAL_DEMAND_GROUPS)) throw new Error('unknown opening scenario');
  if (!(input.periodPlan in PERIODS_BY_PLAN)) throw new Error('unknown service period plan');
  if (input.operatingMode !== 'STRATEGY' && input.operatingMode !== 'LIGHTWEIGHT_REALTIME') {
    throw new Error('unknown competitive operating mode');
  }
  if (input.demandSeed.trim().length === 0) throw new Error('demand seed is required');
  if (input.weather.label.trim().length === 0)
    throw new Error('forecastable weather label is required');
  assertFinite(input.weather.demandModifierPercent, 'weather demand modifier percent');
  if (input.weather.demandModifierPercent < -5 || input.weather.demandModifierPercent > 5) {
    throw new Error('first-day light weather demand modifier must remain within plus or minus 5%');
  }
  if (
    !Number.isInteger(input.basePatienceTicks.min) ||
    !Number.isInteger(input.basePatienceTicks.max) ||
    input.basePatienceTicks.min <= 0 ||
    input.basePatienceTicks.max < input.basePatienceTicks.min
  ) {
    throw new Error('base patience range must contain positive integer ticks');
  }
  for (const cohort of COHORTS) {
    calculatePriceConversionFactor(cohort, input.priceModifierPercentByCohort[cohort]);
  }
  const requiredPeriods = PERIODS_BY_PLAN[input.periodPlan];
  for (const period of requiredPeriods) {
    const window = input.periodTickWindows[period];
    if (
      window === undefined ||
      !Number.isInteger(window.start) ||
      !Number.isInteger(window.end) ||
      window.start < 0 ||
      window.end < window.start
    ) {
      throw new Error(`${period} requires a valid integer tick window`);
    }
  }
  for (const period of Object.keys(input.periodTickWindows) as ServicePeriod[]) {
    if (!requiredPeriods.includes(period as never)) {
      throw new Error(`${period} is not part of ${input.periodPlan}`);
    }
  }
}

function periodShare(plan: ServicePeriodPlan, period: ServicePeriod): number {
  return (
    (PERIOD_DISTRIBUTION[plan] as Readonly<Partial<Record<ServicePeriod, number>>>)[period] ?? 0
  );
}

function calculateActualDemandGroups(input: FirstDayDemandInput): Readonly<{
  normal: number;
  weatherAdjusted: number;
  actual: number;
}> {
  const normal = NORMAL_DEMAND_GROUPS[input.scenario][input.periodPlan];
  const weatherAdjusted = roundHalfUp(normal * (1 + input.weather.demandModifierPercent / 100));
  let weightedConversion = 0;
  for (const period of PERIODS_BY_PLAN[input.periodPlan]) {
    const share = periodShare(input.periodPlan, period);
    for (const cohort of COHORTS) {
      weightedConversion +=
        share *
        COHORT_DISTRIBUTION[period][cohort] *
        calculatePriceConversionFactor(cohort, input.priceModifierPercentByCohort[cohort]);
    }
  }
  const rawPriceAdjusted = roundHalfUp(weatherAdjusted * weightedConversion);
  const minimum = roundHalfUp(weatherAdjusted * 0.9);
  const maximum = roundHalfUp(weatherAdjusted * 1.1);
  return {
    normal,
    weatherAdjusted,
    actual: Math.min(maximum, Math.max(minimum, rawPriceAdjusted)),
  };
}

function periodCohortCounts(input: FirstDayDemandInput, total: number): Map<string, number> {
  const cells: WeightedKey<string>[] = [];
  for (const period of PERIODS_BY_PLAN[input.periodPlan]) {
    const share = periodShare(input.periodPlan, period);
    for (const cohort of COHORTS) {
      cells.push({
        key: `${period}|${cohort}`,
        weight:
          share *
          COHORT_DISTRIBUTION[period][cohort] *
          calculatePriceConversionFactor(cohort, input.priceModifierPercentByCohort[cohort]),
      });
    }
  }
  return allocateByLargestRemainder(
    total,
    cells,
    input.demandSeed,
    `period-cohort:${input.operatingMode}`,
  );
}

function deterministicTick(seed: string, namespace: string, window: TickWindow): number {
  return window.start + (stableSeedOrder(seed, namespace) % (window.end - window.start + 1));
}

function deterministicBasePatience(seed: string, namespace: string, range: PatienceRange): number {
  return range.min + (stableSeedOrder(seed, namespace) % (range.max - range.min + 1));
}

export function createFirstDayDemandSchedule(input: FirstDayDemandInput): DemandSchedule {
  validateDemandInput(input);
  const totals = calculateActualDemandGroups(input);
  const cellCounts = periodCohortCounts(input, totals.actual);
  const sizeCounts = allocateByLargestRemainder(
    totals.actual,
    ([1, 2, 3, 4] as const).map((size) => ({ key: size, weight: GROUP_SIZE_DISTRIBUTION[size] })),
    input.demandSeed,
    'group-size',
  );
  const sizes = ([1, 2, 3, 4] as const).flatMap((size) =>
    Array.from({ length: sizeCounts.get(size) ?? 0 }, () => size),
  );
  sizes.sort(
    (left, right) =>
      stableSeedOrder(input.demandSeed, `size:${input.operatingMode}:${left}`) -
        stableSeedOrder(input.demandSeed, `size:${input.operatingMode}:${right}`) || left - right,
  );

  const groupDrafts: Array<Omit<DemandGroup, 'groupId' | 'size'>> = [];
  for (const period of PERIODS_BY_PLAN[input.periodPlan]) {
    for (const cohort of COHORTS) {
      const count = cellCounts.get(`${period}|${cohort}`) ?? 0;
      for (let localIndex = 0; localIndex < count; localIndex += 1) {
        const namespace = `${input.operatingMode}:${period}:${cohort}:${localIndex}`;
        const basePatienceTicks = deterministicBasePatience(
          input.demandSeed,
          `patience:${namespace}`,
          input.basePatienceTicks,
        );
        groupDrafts.push({
          kind: 'REGULAR',
          period,
          cohort,
          arrivalTick: deterministicTick(
            input.demandSeed,
            `arrival:${namespace}`,
            input.periodTickWindows[period]!,
          ),
          basePatienceTicks,
          hiddenPatienceTicks: Math.max(
            1,
            roundHalfUp(basePatienceTicks * COHORT_PATIENCE_FACTOR[cohort]),
          ),
        });
      }
    }
  }
  groupDrafts.sort(
    (left, right) =>
      left.arrivalTick - right.arrivalTick ||
      stableSeedOrder(
        input.demandSeed,
        `group:${input.operatingMode}:${left.period}:${left.cohort}:${left.hiddenPatienceTicks}`,
      ) -
        stableSeedOrder(
          input.demandSeed,
          `group:${input.operatingMode}:${right.period}:${right.cohort}:${right.hiddenPatienceTicks}`,
        ) ||
      left.period.localeCompare(right.period) ||
      left.cohort.localeCompare(right.cohort),
  );
  const groups = groupDrafts.map((draft, index) => ({
    ...draft,
    groupId: `group:${String(index + 1).padStart(3, '0')}`,
    size: sizes[index]!,
  }));
  const replayEvents: DemandReplayEvent[] = [
    {
      sequence: 0,
      type: 'FIRST_DAY_DEMAND_SCHEDULED',
      subjectId: 'business-day:1',
      details: {
        scenario: input.scenario,
        periodPlan: input.periodPlan,
        operatingMode: input.operatingMode,
        normalDemandGroups: totals.normal,
        weatherAdjustedGroups: totals.weatherAdjusted,
        actualDemandGroups: totals.actual,
        weatherLabel: input.weather.label,
        weatherDemandModifierPercent: input.weather.demandModifierPercent,
      },
    },
    ...groups.map((group, index) => ({
      sequence: index + 1,
      type: 'DEMAND_GROUP_SCHEDULED' as const,
      subjectId: group.groupId,
      details: {
        period: group.period,
        cohort: group.cohort,
        size: group.size,
        arrivalTick: group.arrivalTick,
        basePatienceTicks: group.basePatienceTicks,
        hiddenPatienceTicks: group.hiddenPatienceTicks,
      },
    })),
  ];

  return deepFreeze({
    day: 1,
    scenario: input.scenario,
    periodPlan: input.periodPlan,
    operatingMode: input.operatingMode,
    leaderboardCohortKey: `${input.scenario}|${input.periodPlan}|${input.operatingMode}`,
    demandSeed: input.demandSeed,
    normalDemandGroups: totals.normal,
    weatherAdjustedGroups: totals.weatherAdjusted,
    actualDemandGroups: totals.actual,
    weather: { ...input.weather },
    groups,
    replayEvents,
  });
}

function forecastRange(actual: number, errorRate: number): Readonly<{ min: number; max: number }> {
  return Object.freeze({
    min: Math.max(0, roundHalfUp(actual * (1 - errorRate))),
    max: roundHalfUp(actual * (1 + errorRate)),
  });
}

export function createPreOpeningForecast(
  schedule: DemandSchedule,
  basePatienceTicks: PatienceRange,
): DemandForecast {
  if (
    !Number.isInteger(basePatienceTicks.min) ||
    !Number.isInteger(basePatienceTicks.max) ||
    basePatienceTicks.min <= 0 ||
    basePatienceTicks.max < basePatienceTicks.min
  ) {
    throw new Error('base patience range must contain positive integer ticks');
  }
  const errorRate = FORECAST_ERROR_RATE[schedule.scenario];
  const periods = PERIODS_BY_PLAN[schedule.periodPlan].map((period) => {
    const count = schedule.groups.filter((group) => group.period === period).length;
    const tendencies = [...COHORTS].sort(
      (left, right) =>
        COHORT_DISTRIBUTION[period][right] - COHORT_DISTRIBUTION[period][left] ||
        left.localeCompare(right),
    );
    return {
      period,
      groups: forecastRange(count, errorRate),
      mainCohortTendencies: tendencies,
    };
  });
  const patienceTicks = Object.fromEntries(
    COHORTS.map((cohort) => [
      cohort,
      {
        min: Math.max(1, roundHalfUp(basePatienceTicks.min * COHORT_PATIENCE_FACTOR[cohort])),
        max: Math.max(1, roundHalfUp(basePatienceTicks.max * COHORT_PATIENCE_FACTOR[cohort])),
      },
    ]),
  ) as Record<CustomerCohort, PatienceRange>;
  return deepFreeze({
    day: 1,
    periodPlan: schedule.periodPlan,
    weather: { ...schedule.weather },
    allDayGroups: forecastRange(schedule.actualDemandGroups, errorRate),
    periods,
    patienceTicks,
    disclosure: {
      exactArrivalTimesShown: false,
      individualOrdersShown: false,
      demandSeedShown: false,
      exactPatienceCountdownShown: false,
    },
  });
}

export function discloseDemandReplay(
  schedule: DemandSchedule,
  phase: 'PRE_OPEN' | 'OPERATING' | 'DAY_SETTLED',
): DemandReplayDisclosure {
  if (phase !== 'DAY_SETTLED')
    throw new Error('demand seed is disclosed only after day settlement');
  return deepFreeze({
    day: 1,
    demandSeed: schedule.demandSeed,
    actualDemandGroups: schedule.actualDemandGroups,
    groups: schedule.groups.map((group) => ({ ...group })),
    events: schedule.replayEvents.map((event) => ({
      ...event,
      details: { ...event.details },
    })),
  });
}

export const FIRST_DAY_SPACE_CATALOG_VERSION = 'e02-space-v1' as const;

export type FirstDayFixtureKind = 'SEAT' | 'WALKWAY' | 'WAITING_ZONE';
export type PremisesEquipmentState = 'NONE' | 'BASIC' | 'AGED' | 'REPAIRED';
export type GridPoint = Readonly<{ x: number; y: number }>;
export type FirstDayFixture = Readonly<
  GridPoint & { fixtureId: string; kind: FirstDayFixtureKind }
>;
export type FirstDayLayout = Readonly<{
  width: number;
  height: number;
  servicePoint: GridPoint;
  fixtures: readonly FirstDayFixture[];
}>;
export type FirstDaySpaceLimits = Readonly<{
  catalogVersion: typeof FIRST_DAY_SPACE_CATALOG_VERSION;
  scenario: OpeningScenario;
  width: number;
  height: number;
  usableFloorCells: number;
  maxSeats: number;
  maxWaitingGroups: number;
}>;
export type ConfigurationPhase =
  | 'PRE_OPEN'
  | 'BETWEEN_SERVICE_PERIODS'
  | 'LUNCH'
  | 'OFF_PEAK'
  | 'DINNER';
export type LayoutSnapshot = Readonly<{
  revision: number;
  layoutHash: string;
  scenario: OpeningScenario;
  spaceLimits: FirstDaySpaceLimits;
  layout: FirstDayLayout;
}>;
export type LayoutConfigurationEvent = Readonly<{
  type: 'LAYOUT_CONFIGURED';
  revision: number;
  phase: 'PRE_OPEN' | 'BETWEEN_SERVICE_PERIODS';
  scenario: OpeningScenario;
  spaceCatalogVersion: typeof FIRST_DAY_SPACE_CATALOG_VERSION;
  layoutHash: string;
}>;

export type ThreePeriodDinnerPeakFixture = Readonly<{
  scenario: OpeningScenario;
  peakGroups: number;
  peakPeople: number;
  seatLimit: number;
  rawPeakOverloadRatio: number;
  rawPeakOverloadPercent: number;
}>;

export type FlowIndicators = Readonly<{
  seatCapacity: number;
  waitingCapacity: number;
  walkwayCells: number;
  averageSeatWalkwayDistanceSteps: number;
  maximumSeatWalkwayDistanceSteps: number;
  visibleWaitingAreas: number;
  waitingVisibilityRatio: number;
  seatedGuestPressure: number;
  waitingGroupPressure: number;
  walkwayLoad: number;
  queueDemandRatio: number;
}>;

const firstDaySpaceCatalog = deepFreeze({
  EMPTY_PREMISES: {
    catalogVersion: FIRST_DAY_SPACE_CATALOG_VERSION,
    scenario: 'EMPTY_PREMISES',
    width: 9,
    height: 8,
    usableFloorCells: 72,
    maxSeats: 26,
    maxWaitingGroups: 3,
  },
  DEFAULT_SMALL_SHOP: {
    catalogVersion: FIRST_DAY_SPACE_CATALOG_VERSION,
    scenario: 'DEFAULT_SMALL_SHOP',
    width: 10,
    height: 9,
    usableFloorCells: 90,
    maxSeats: 30,
    maxWaitingGroups: 4,
  },
  TROUBLED_SHOP: {
    catalogVersion: FIRST_DAY_SPACE_CATALOG_VERSION,
    scenario: 'TROUBLED_SHOP',
    width: 8,
    height: 7,
    usableFloorCells: 56,
    maxSeats: 24,
    maxWaitingGroups: 2,
  },
} satisfies Readonly<Record<OpeningScenario, FirstDaySpaceLimits>>);

export function resolveFirstDaySpaceLimits(
  scenario: OpeningScenario,
  equipmentState: PremisesEquipmentState = 'NONE',
): FirstDaySpaceLimits {
  if (!(scenario in firstDaySpaceCatalog)) throw new Error('unknown opening scenario');
  if (!(['NONE', 'BASIC', 'AGED', 'REPAIRED'] as const).includes(equipmentState)) {
    throw new Error('unknown premises equipment state');
  }
  return firstDaySpaceCatalog[scenario];
}

export function calculateThreePeriodDinnerPeakFixture(
  scenario: OpeningScenario,
): ThreePeriodDinnerPeakFixture {
  const limits = resolveFirstDaySpaceLimits(scenario);
  const peakGroups = roundHalfUp(NORMAL_DEMAND_GROUPS[scenario].THREE_PERIODS * 0.5);
  const peakPeople = Math.ceil(peakGroups * 2.25);
  const rawPeakOverloadRatio = roundSix(peakPeople / limits.maxSeats - 1);
  return deepFreeze({
    scenario,
    peakGroups,
    peakPeople,
    seatLimit: limits.maxSeats,
    rawPeakOverloadRatio,
    rawPeakOverloadPercent: Math.round(rawPeakOverloadRatio * 10_000) / 100,
  });
}

export function canEnterFirstDayWaitingQueue(
  scenario: OpeningScenario,
  currentWaitingGroups: number,
): boolean {
  if (!Number.isInteger(currentWaitingGroups) || currentWaitingGroups < 0) {
    throw new Error('current waiting groups must be a non-negative integer');
  }
  return currentWaitingGroups < resolveFirstDaySpaceLimits(scenario).maxWaitingGroups;
}

function pointKey(point: GridPoint): string {
  return `${point.x},${point.y}`;
}

function validatePoint(point: GridPoint, layout: FirstDayLayout, name: string): void {
  if (
    !Number.isInteger(point.x) ||
    !Number.isInteger(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= layout.width ||
    point.y >= layout.height
  ) {
    throw new Error(`${name} must be an in-bounds integer grid point`);
  }
}

function adjacent(point: GridPoint): readonly GridPoint[] {
  return [
    { x: point.x - 1, y: point.y },
    { x: point.x + 1, y: point.y },
    { x: point.x, y: point.y - 1 },
    { x: point.x, y: point.y + 1 },
  ];
}

function staticWalkwayDistances(layout: FirstDayLayout): Map<string, number> {
  const passable = new Set(
    layout.fixtures.filter((fixture) => fixture.kind === 'WALKWAY').map(pointKey),
  );
  passable.add(pointKey(layout.servicePoint));
  const distances = new Map<string, number>([[pointKey(layout.servicePoint), 0]]);
  const queue: GridPoint[] = [layout.servicePoint];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    const nextDistance = distances.get(pointKey(current))! + 1;
    for (const next of adjacent(current)) {
      const key = pointKey(next);
      if (passable.has(key) && !distances.has(key)) {
        distances.set(key, nextDistance);
        queue.push(next);
      }
    }
  }
  return distances;
}

function fixtureDistance(
  fixture: FirstDayFixture,
  distances: ReadonlyMap<string, number>,
): number | null {
  const candidates = adjacent(fixture)
    .map((point) => distances.get(pointKey(point)))
    .filter((distance): distance is number => distance !== undefined);
  return candidates.length === 0 ? null : Math.min(...candidates) + 1;
}

export function validateFirstDayLayout(
  layout: FirstDayLayout,
  scenario: OpeningScenario,
  equipmentState: PremisesEquipmentState = 'NONE',
): void {
  const limits = resolveFirstDaySpaceLimits(scenario, equipmentState);
  if (
    !Number.isInteger(layout.width) ||
    !Number.isInteger(layout.height) ||
    layout.width !== limits.width ||
    layout.height !== limits.height ||
    layout.width * layout.height !== limits.usableFloorCells
  ) {
    throw new Error('layout dimensions must equal the canonical fully usable scenario grid');
  }
  validatePoint(layout.servicePoint, layout, 'service point');
  const ids = new Set<string>();
  const occupied = new Set<string>();
  for (const fixture of layout.fixtures) {
    if (!(['SEAT', 'WALKWAY', 'WAITING_ZONE'] as const).includes(fixture.kind)) {
      throw new Error('first-day layout permits only seats, walkways, and waiting zones');
    }
    if (fixture.fixtureId.trim().length === 0 || ids.has(fixture.fixtureId)) {
      throw new Error('fixture IDs must be non-empty and unique');
    }
    ids.add(fixture.fixtureId);
    validatePoint(fixture, layout, `fixture ${fixture.fixtureId}`);
    const key = pointKey(fixture);
    if (key === pointKey(layout.servicePoint) || occupied.has(key)) {
      throw new Error('fixtures and the service point cannot overlap');
    }
    occupied.add(key);
  }
  const seats = layout.fixtures.filter((fixture) => fixture.kind === 'SEAT');
  const waiting = layout.fixtures.filter((fixture) => fixture.kind === 'WAITING_ZONE');
  if (seats.length > limits.maxSeats || waiting.length > limits.maxWaitingGroups) {
    throw new Error('layout exceeds the opening scenario seat or waiting-group limit');
  }
  const distances = staticWalkwayDistances(layout);
  for (const fixture of [...seats, ...waiting]) {
    if (fixtureDistance(fixture, distances) === null) {
      throw new Error(`${fixture.fixtureId} must connect to the static walkway network`);
    }
  }
}

function canonicalLayout(layout: FirstDayLayout, limits: FirstDaySpaceLimits): string {
  return JSON.stringify({
    spaceCatalogVersion: limits.catalogVersion,
    scenario: limits.scenario,
    width: layout.width,
    height: layout.height,
    servicePoint: layout.servicePoint,
    fixtures: [...layout.fixtures]
      .sort((left, right) => left.fixtureId.localeCompare(right.fixtureId))
      .map(({ fixtureId, kind, x, y }) => ({ fixtureId, kind, x, y })),
  });
}

export function configureFirstDayLayout(
  currentRevision: number,
  proposed: FirstDayLayout,
  scenario: OpeningScenario,
  periodPlan: ServicePeriodPlan,
  phase: ConfigurationPhase,
  equipmentState: PremisesEquipmentState = 'NONE',
): Readonly<{ snapshot: LayoutSnapshot; event: LayoutConfigurationEvent }> {
  if (!Number.isInteger(currentRevision) || currentRevision < 0) {
    throw new Error('current layout revision must be a non-negative integer');
  }
  if (
    phase !== 'PRE_OPEN' &&
    !(phase === 'BETWEEN_SERVICE_PERIODS' && periodPlan === 'THREE_PERIODS')
  ) {
    throw new Error('layout is locked during peak service periods');
  }
  const limits = resolveFirstDaySpaceLimits(scenario, equipmentState);
  validateFirstDayLayout(proposed, scenario, equipmentState);
  const layout = {
    width: proposed.width,
    height: proposed.height,
    servicePoint: { ...proposed.servicePoint },
    fixtures: [...proposed.fixtures]
      .sort((left, right) => left.fixtureId.localeCompare(right.fixtureId))
      .map((fixture) => ({ ...fixture })),
  };
  const revision = currentRevision + 1;
  const layoutHash = createHash('sha256').update(canonicalLayout(layout, limits)).digest('hex');
  return deepFreeze({
    snapshot: { revision, layoutHash, scenario, spaceLimits: limits, layout },
    event: {
      type: 'LAYOUT_CONFIGURED',
      revision,
      phase,
      scenario,
      spaceCatalogVersion: limits.catalogVersion,
      layoutHash,
    },
  });
}

function hasStaticLineOfSight(
  origin: GridPoint,
  target: GridPoint,
  blockers: ReadonlySet<string>,
): boolean {
  if (origin.x !== target.x && origin.y !== target.y) return false;
  const xStep = Math.sign(target.x - origin.x);
  const yStep = Math.sign(target.y - origin.y);
  let cursor = { x: origin.x + xStep, y: origin.y + yStep };
  while (cursor.x !== target.x || cursor.y !== target.y) {
    if (blockers.has(pointKey(cursor))) return false;
    cursor = { x: cursor.x + xStep, y: cursor.y + yStep };
  }
  return true;
}

export function calculateFlowIndicators(
  layout: FirstDayLayout,
  scenario: OpeningScenario,
  state: Readonly<{
    seatedGuests: number;
    waitingGroups: number;
    activeGuests: number;
    demandGroups: number;
  }>,
  equipmentState: PremisesEquipmentState = 'NONE',
): FlowIndicators {
  validateFirstDayLayout(layout, scenario, equipmentState);
  for (const [name, value] of Object.entries(state)) {
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`${name} must be a non-negative integer`);
  }
  if (state.demandGroups <= 0) throw new Error('demand groups must be positive');
  const seats = layout.fixtures.filter((fixture) => fixture.kind === 'SEAT');
  const waiting = layout.fixtures.filter((fixture) => fixture.kind === 'WAITING_ZONE');
  const walkways = layout.fixtures.filter((fixture) => fixture.kind === 'WALKWAY');
  const distances = staticWalkwayDistances(layout);
  const seatDistances = seats.map((seat) => fixtureDistance(seat, distances)!);
  const blockers = new Set(seats.map(pointKey));
  const visibleWaitingAreas = waiting.filter((area) =>
    hasStaticLineOfSight(layout.servicePoint, area, blockers),
  ).length;
  return deepFreeze({
    seatCapacity: seats.length,
    waitingCapacity: waiting.length,
    walkwayCells: walkways.length,
    averageSeatWalkwayDistanceSteps:
      seatDistances.length === 0
        ? 0
        : roundSix(seatDistances.reduce((sum, value) => sum + value, 0) / seatDistances.length),
    maximumSeatWalkwayDistanceSteps: seatDistances.length === 0 ? 0 : Math.max(...seatDistances),
    visibleWaitingAreas,
    waitingVisibilityRatio:
      waiting.length === 0 ? 0 : roundSix(visibleWaitingAreas / waiting.length),
    seatedGuestPressure: roundSix(state.seatedGuests / Math.max(1, seats.length)),
    waitingGroupPressure: roundSix(state.waitingGroups / Math.max(1, waiting.length)),
    walkwayLoad: roundSix(state.activeGuests / Math.max(1, walkways.length)),
    queueDemandRatio: roundSix(state.waitingGroups / state.demandGroups),
  });
}
