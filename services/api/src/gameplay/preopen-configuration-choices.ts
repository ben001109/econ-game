import {
  calculateRecipeBasePrice,
  calculateRecipeReferenceCost,
  calculateSalePrice,
  type CatalogSubstitution,
  type RecipeIngredient,
} from '../domains/inventory-procurement/catalog-menu.js';
import {
  MVP_FIRST_DAY_CATALOG_VERSIONS,
  resolveMvpFirstDayCatalog,
} from '../domains/inventory-procurement/mvp-first-day-catalog.js';
import { createStorageBundleSnapshot } from '../domains/inventory-procurement/inventory.js';
import { deepFreeze } from '../domains/inventory-procurement/shared.js';
import {
  FIRST_DAY_SPACE_CATALOG_VERSION,
  resolveFirstDaySpaceLimits,
  type FirstDayFixtureKind,
  type ServicePeriod,
  type ServicePeriodPlan,
} from '../domains/demand-flow/demand-flow.js';
import type { Money } from '../domains/money/money.js';
import type { OpeningScenario } from '../domains/opening-scenario/catalog.js';
import { MVP_OPENING_VERSIONS } from '../domains/opening-scenario/registry.js';
import {
  createOpeningSnapshot,
  type CompetitiveOperatingMode,
} from '../domains/opening-scenario/snapshot.js';
import { PREOPEN_DAY_ENVELOPE_VERSION } from './preopen-day-contract.js';

const CONFIGURATION_PHASE = 'CONFIGURE_REQUIRED' as const;
const PREOPEN_EQUIPMENT_INSTALLATION_REQUIRED =
  'PREOPEN_EQUIPMENT_INSTALLATION_REQUIRED' as const;
const PREOPEN_CONFIGURATION_AUTHORITY_INVALID =
  'PREOPEN_CONFIGURATION_AUTHORITY_INVALID' as const;
// Matches the first-day persisted bootstrap/pre-open storage entitlement.
// It is intentionally not exposed as a client-selectable version.
const MVP_FIRST_DAY_STORAGE_BUNDLE_VERSION = 'mvp-storage/v1' as const;

const scenarios = new Set<OpeningScenario>([
  'EMPTY_PREMISES',
  'DEFAULT_SMALL_SHOP',
  'TROUBLED_SHOP',
]);
const operatingModes = new Set<CompetitiveOperatingMode>([
  'STRATEGY',
  'LIGHTWEIGHT_REALTIME',
]);
const servicePeriodPlans = new Set<ServicePeriodPlan>(['TWO_PERIODS', 'THREE_PERIODS']);
const fixtureKinds = Object.freeze([
  'SEAT',
  'WALKWAY',
  'WAITING_ZONE',
] as const satisfies readonly FirstDayFixtureKind[]);

const periodsByPlan = Object.freeze({
  TWO_PERIODS: Object.freeze(['LUNCH', 'DINNER'] as const),
  THREE_PERIODS: Object.freeze(['LUNCH', 'OFF_PEAK', 'DINNER'] as const),
} satisfies Readonly<Record<ServicePeriodPlan, readonly ServicePeriod[]>>);

export type PreopenConfigurationChoicesAuthority = Readonly<{
  save: Readonly<{
    id: string;
    expectedVersion: number;
    phase: typeof CONFIGURATION_PHASE;
    scenario: OpeningScenario;
    operatingMode: CompetitiveOperatingMode;
    servicePeriodPlan: ServicePeriodPlan;
    simulationRuleVersion: string;
    settlementCurrency: string;
  }>;
}>;

export type PreopenConfigurationChoices = Readonly<{
  save: Readonly<{
    id: string;
    expectedVersion: number;
    scenario: OpeningScenario;
    operatingMode: CompetitiveOperatingMode;
    servicePeriodPlan: ServicePeriodPlan;
    servicePeriods: readonly ServicePeriod[];
    simulationRuleVersion: string;
  }>;
  businessDay: 1;
  versions: Readonly<{
    preopenSchema: typeof PREOPEN_DAY_ENVELOPE_VERSION;
    openingCatalog: string;
    simulationRule: string;
    currencyMetadata: string;
    catalog: string;
    ingredientCatalog: string;
    recipeCatalog: string;
    substitutionCatalog: string;
    floorSpace: typeof FIRST_DAY_SPACE_CATALOG_VERSION;
  }>;
  menu: Readonly<{
    difficulty: 'STANDARD';
    requiredRecipeCount: 3;
    themeId: 'bistro';
    recipeCards: readonly Readonly<{
      recipeVersionId: string;
      recipeId: string;
      baseQuality: number;
      ingredients: readonly RecipeIngredient[];
      basePrice: Money;
      priceOptions: readonly Readonly<{
        modifierPercent: number;
        salePrice: Money;
      }>[];
      substitutionIds: readonly string[];
    }>[];
    substitutions: readonly Readonly<{
      id: string;
      recipeVersionId: string;
      priority: number;
      qualityDelta: number;
      ingredients: readonly RecipeIngredient[];
    }>[];
  }>;
  procurement: Readonly<{
    settlementCurrency: string;
    spendLimit: Money;
    poolCapacities: Readonly<{ DURABLE: number; PERISHABLE: number }>;
    lockedDay1Quotes: readonly Readonly<{
      ingredientId: string;
      pool: 'DURABLE' | 'PERISHABLE';
      unitPrice: Money;
      priceModifierBps: 0;
    }>[];
  }>;
  floor: Readonly<{
    catalogVersion: typeof FIRST_DAY_SPACE_CATALOG_VERSION;
    width: number;
    height: number;
    usableFloorCells: number;
    maxSeats: number;
    maxWaitingGroups: number;
    allowedFixtureKinds: readonly FirstDayFixtureKind[];
    constraints: Readonly<{
      phase: 'PRE_OPEN';
      exactScenarioDimensionsRequired: true;
      servicePointInBoundsRequired: true;
      servicePointMustNotOverlapFixture: true;
      fixtureIdsMustBeUnique: true;
      fixturesMustBeInBounds: true;
      fixturesMustNotOverlap: true;
      seatsAndWaitingZonesRequireWalkwayConnection: true;
    }>;
  }>;
}>;

export class PreopenConfigurationChoicesError extends Error {
  readonly code:
    | typeof PREOPEN_EQUIPMENT_INSTALLATION_REQUIRED
    | typeof PREOPEN_CONFIGURATION_AUTHORITY_INVALID;

  constructor(
    code:
      | typeof PREOPEN_EQUIPMENT_INSTALLATION_REQUIRED
      | typeof PREOPEN_CONFIGURATION_AUTHORITY_INVALID,
  ) {
    super(code);
    this.name = 'PreopenConfigurationChoicesError';
    this.code = code;
  }
}

function invalidAuthority(): never {
  throw new PreopenConfigurationChoicesError(PREOPEN_CONFIGURATION_AUTHORITY_INVALID);
}

function plainDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalidAuthority();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.keys(descriptors).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    return invalidAuthority();
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) return invalidAuthority();
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return invalidAuthority();
  return value;
}

function nonNegativeSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalidAuthority();
  return value as number;
}

function snapshotAuthority(value: unknown): PreopenConfigurationChoicesAuthority['save'] {
  const root = plainDataRecord(value, ['save']);
  const save = plainDataRecord(root.save, [
    'expectedVersion',
    'id',
    'operatingMode',
    'phase',
    'scenario',
    'servicePeriodPlan',
    'settlementCurrency',
    'simulationRuleVersion',
  ]);
  const scenario = nonEmptyString(save.scenario) as OpeningScenario;
  const operatingMode = nonEmptyString(save.operatingMode) as CompetitiveOperatingMode;
  const servicePeriodPlan = nonEmptyString(save.servicePeriodPlan) as ServicePeriodPlan;
  const phase = nonEmptyString(save.phase);
  const simulationRuleVersion = nonEmptyString(save.simulationRuleVersion);
  const settlementCurrency = nonEmptyString(save.settlementCurrency);
  if (
    !scenarios.has(scenario) ||
    !operatingModes.has(operatingMode) ||
    !servicePeriodPlans.has(servicePeriodPlan) ||
    phase !== CONFIGURATION_PHASE ||
    simulationRuleVersion !== MVP_OPENING_VERSIONS.simulationRuleVersion ||
    (settlementCurrency !== 'TWD' && settlementCurrency !== 'USD')
  ) {
    return invalidAuthority();
  }
  return Object.freeze({
    id: nonEmptyString(save.id),
    expectedVersion: nonNegativeSafeInteger(save.expectedVersion),
    phase,
    scenario,
    operatingMode,
    servicePeriodPlan,
    simulationRuleVersion,
    settlementCurrency,
  });
}

function recipeIngredients(ingredients: readonly RecipeIngredient[]): readonly RecipeIngredient[] {
  return ingredients.map((ingredient) => ({ ...ingredient }));
}

function substitutionProjection(
  substitutions: readonly CatalogSubstitution[],
): PreopenConfigurationChoices['menu']['substitutions'] {
  return substitutions.map((substitution) => ({
    id: substitution.id,
    recipeVersionId: substitution.recipeVersionId,
    priority: substitution.priority,
    qualityDelta: substitution.qualityDelta,
    ingredients: recipeIngredients(substitution.ingredients),
  }));
}

/**
 * Produces a public Day 1 configuration contract from a narrow persisted save
 * authority. It never accepts caller-owned catalog, cash, capacity, seed, or
 * market objects, and performs no persistence or command dispatch.
 */
export function providePreopenConfigurationChoices(
  authority: PreopenConfigurationChoicesAuthority,
): PreopenConfigurationChoices {
  const save = snapshotAuthority(authority);
  if (save.scenario === 'EMPTY_PREMISES') {
    throw new PreopenConfigurationChoicesError(PREOPEN_EQUIPMENT_INSTALLATION_REQUIRED);
  }

  const openingSnapshot = createOpeningSnapshot(
    {
      scenario: save.scenario,
      operatingMode: save.operatingMode,
      currency: save.settlementCurrency,
    },
    MVP_OPENING_VERSIONS,
  );
  if (openingSnapshot.simulationRuleVersion !== save.simulationRuleVersion) {
    return invalidAuthority();
  }
  const storage = createStorageBundleSnapshot(save.scenario, {
    version: MVP_FIRST_DAY_STORAGE_BUNDLE_VERSION,
    kind: save.scenario === 'TROUBLED_SHOP' ? 'AGED' : 'BASIC',
  });
  const catalog = resolveMvpFirstDayCatalog(MVP_FIRST_DAY_CATALOG_VERSIONS, {
    code: openingSnapshot.settlementCurrency.code,
    metadataVersion: openingSnapshot.currencyMetadataVersion,
  });
  const limits = resolveFirstDaySpaceLimits(save.scenario);
  const substitutions = substitutionProjection(catalog.substitutionCatalog);

  const recipeCards = catalog.recipeCatalog.map((recipe) => {
    const basePrice = calculateRecipeBasePrice(
      calculateRecipeReferenceCost(recipe, catalog.ingredientCatalog),
    );
    const priceOptions = Array.from({ length: 21 }, (_, index) => {
      const modifierPercent = index - 10;
      return {
        modifierPercent,
        salePrice: calculateSalePrice(basePrice, modifierPercent),
      };
    });
    return {
      recipeVersionId: recipe.id,
      recipeId: recipe.recipeId,
      baseQuality: recipe.baseQuality,
      ingredients: recipeIngredients(recipe.ingredients),
      basePrice,
      priceOptions,
      substitutionIds: substitutions
        .filter((substitution) => substitution.recipeVersionId === recipe.id)
        .map((substitution) => substitution.id),
    };
  });

  return deepFreeze({
    save: {
      id: save.id,
      expectedVersion: save.expectedVersion,
      scenario: save.scenario,
      operatingMode: save.operatingMode,
      servicePeriodPlan: save.servicePeriodPlan,
      servicePeriods: [...periodsByPlan[save.servicePeriodPlan]],
      simulationRuleVersion: save.simulationRuleVersion,
    },
    businessDay: 1 as const,
    versions: {
      preopenSchema: PREOPEN_DAY_ENVELOPE_VERSION,
      openingCatalog: MVP_OPENING_VERSIONS.openingCatalogVersion,
      simulationRule: MVP_OPENING_VERSIONS.simulationRuleVersion,
      currencyMetadata: MVP_OPENING_VERSIONS.currencyMetadataVersion,
      catalog: catalog.versions.catalog,
      ingredientCatalog: catalog.versions.ingredientCatalog,
      recipeCatalog: catalog.versions.recipeCatalog,
      substitutionCatalog: catalog.versions.substitutionCatalog,
      floorSpace: FIRST_DAY_SPACE_CATALOG_VERSION,
    },
    menu: {
      difficulty: 'STANDARD' as const,
      requiredRecipeCount: 3 as const,
      themeId: 'bistro' as const,
      recipeCards,
      substitutions,
    },
    procurement: {
      settlementCurrency: openingSnapshot.settlementCurrency.code,
      spendLimit: openingSnapshot.settlementCash.amount,
      poolCapacities: { ...storage.capacity },
      lockedDay1Quotes: catalog.ingredientCatalog.map((ingredient) => ({
        ingredientId: ingredient.id,
        pool: ingredient.pool,
        unitPrice: ingredient.referenceUnitPrice,
        priceModifierBps: 0 as const,
      })),
    },
    floor: {
      catalogVersion: limits.catalogVersion,
      width: limits.width,
      height: limits.height,
      usableFloorCells: limits.usableFloorCells,
      maxSeats: limits.maxSeats,
      maxWaitingGroups: limits.maxWaitingGroups,
      allowedFixtureKinds: [...fixtureKinds],
      constraints: {
        phase: 'PRE_OPEN' as const,
        exactScenarioDimensionsRequired: true as const,
        servicePointInBoundsRequired: true as const,
        servicePointMustNotOverlapFixture: true as const,
        fixtureIdsMustBeUnique: true as const,
        fixturesMustBeInBounds: true as const,
        fixturesMustNotOverlap: true as const,
        seatsAndWaitingZonesRequireWalkwayConnection: true as const,
      },
    },
  });
}

export const PREOPEN_CONFIGURATION_CHOICES_ERROR_CODES = Object.freeze({
  PREOPEN_EQUIPMENT_INSTALLATION_REQUIRED,
  PREOPEN_CONFIGURATION_AUTHORITY_INVALID,
});
