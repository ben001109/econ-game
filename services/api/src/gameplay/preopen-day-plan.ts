import { createHash } from 'node:crypto';

import {
  assertCatalogContract,
  createMenuSelection,
  type CatalogSubstitution,
  type IngredientCatalogItem,
  type MenuDifficulty,
  type RecipeVersion,
} from '../domains/inventory-procurement/catalog-menu.js';
import {
  createInventoryProcurementOpeningSnapshot,
  type InventoryProcurementOpeningSnapshot,
} from '../domains/inventory-procurement/opening-snapshot.js';
import type { InventoryState } from '../domains/inventory-procurement/inventory.js';
import {
  createMarketSnapshot,
  purchaseSpotInventory,
  type MarketSnapshot,
  type SupplierContract,
} from '../domains/inventory-procurement/procurement.js';
import type { Money } from '../domains/money/money.js';
import type { OpeningScenario } from '../domains/opening-scenario/catalog.js';
import type { CompetitiveOperatingMode } from '../domains/opening-scenario/snapshot.js';
import {
  configureFirstDayLayout,
  type DemandForecast,
  type DemandSchedule,
  type LayoutSnapshot,
  type PremisesEquipmentState,
  type ServicePeriodPlan,
} from '../domains/demand-flow/demand-flow.js';
import {
  PREOPEN_DAY_ENVELOPE_VERSION,
  type ConfigurePreopenDayIntent,
} from './preopen-day-contract.js';

type CanonicalScalar = string | number | boolean | null;
export interface CanonicalObject {
  readonly [key: string]: CanonicalValue;
}
export type CanonicalValue = CanonicalScalar | readonly CanonicalValue[] | CanonicalObject;

export type PreopenDayAccountingEvidence = Readonly<{
  accountingVersion: string;
  entries: readonly Readonly<{
    referenceId: string;
    kind: string;
    amountMinorUnits: string;
    currency: string;
  }>[];
}>;

/**
 * E03's public types only construct a first-day schedule.  The durable day
 * state needed to choose later-day seeds, weather, tick windows, and patience
 * is intentionally not available in this pure module, so that bridge remains
 * a narrow server-owned dependency.
 */
export type PreopenDemandBuilder = Readonly<{
  create: (
    input: Readonly<{
      businessDay: number;
      scenario: OpeningScenario;
      operatingMode: CompetitiveOperatingMode;
      servicePeriodPlan: ServicePeriodPlan;
      demandSeed: string;
      simulationRuleVersion: string;
      activeRecipeVersionIds: readonly string[];
      priceModifierPercentByRecipe: Readonly<Record<string, number>>;
      layout: LayoutSnapshot;
    }>,
  ) => Readonly<{ schedule: DemandSchedule; forecast: DemandForecast }>;
}>;

export type PreopenDayServerArtifacts = Readonly<{
  preopenSnapshotId: string;
  saveId: string;
  businessDay: number;
  scenario: OpeningScenario;
  operatingMode: CompetitiveOperatingMode;
  demandSeed: string;
  menuDifficulty: MenuDifficulty;
  servicePeriodPlan: ServicePeriodPlan;
  equipmentState: PremisesEquipmentState;
  versions: Readonly<{
    preopenSchema: string;
    simulationRule: string;
    ingredientCatalog: string;
    recipeCatalog: string;
    substitutionCatalog: string;
    accounting: string;
  }>;
  openingSnapshot: Readonly<{ openingSnapshotId: string; openingSnapshotHash: string }>;
  e01: Readonly<{
    recipeCatalog: readonly RecipeVersion[];
    ingredientCatalog: readonly IngredientCatalogItem[];
    substitutionCatalog: readonly CatalogSubstitution[];
    openingInventory: InventoryState;
    marketSnapshot: MarketSnapshot;
    openingReservations: InventoryState['orderReservations'];
    outstandingContracts: readonly SupplierContract[];
    reservedUndelivered: InventoryState['reservedUndelivered'];
    cashAvailable: Money;
    spotPurchaseIdsForIngredient: (ingredientId: string) => Readonly<{
      transactionId: string;
      purchaseId: string;
    }>;
  }>;
  e02: Readonly<{ currentLayoutRevision: number }>;
  demand: PreopenDemandBuilder;
  accountingEvidence: PreopenDayAccountingEvidence;
}>;

export type PreopenDayPrivateEnvelope = Readonly<{
  envelopeVersion: typeof PREOPEN_DAY_ENVELOPE_VERSION;
  preopenSnapshotId: string;
  saveId: string;
  businessDay: number;
  scenario: OpeningScenario;
  operatingMode: CompetitiveOperatingMode;
  versions: PreopenDayServerArtifacts['versions'];
  openingSnapshot: PreopenDayServerArtifacts['openingSnapshot'];
  menu: ReturnType<typeof createMenuSelection>;
  layout: LayoutSnapshot;
  inventoryProcurement: InventoryProcurementOpeningSnapshot;
  demandSchedule: DemandSchedule;
  demandForecast: DemandForecast;
  accountingEvidence: PreopenDayAccountingEvidence;
  preopenSnapshotHash: string;
}>;

export type PreopenDayPublicProjection = Readonly<{
  envelopeVersion: typeof PREOPEN_DAY_ENVELOPE_VERSION;
  preopenSnapshotId: string;
  preopenSnapshotHash: string;
  businessDay: number;
  menu: Readonly<{
    themeId: string;
    items: readonly Readonly<{
      recipeVersionId: string;
      priceModifierPercent: number;
      basePrice: Money;
      salePrice: Money;
      enabledSubstitutionIds: readonly string[];
    }>[];
  }>;
  floorPlan: Readonly<{ revision: number; layoutHash: string; layout: LayoutSnapshot['layout'] }>;
  demandForecast: Readonly<{
    day: number;
    periodPlan: DemandForecast['periodPlan'];
    weather: DemandForecast['weather'];
    allDayGroups: DemandForecast['allDayGroups'];
    periods: readonly Readonly<{
      period: DemandForecast['periods'][number]['period'];
      groups: DemandForecast['periods'][number]['groups'];
      mainCohortTendencies: DemandForecast['periods'][number]['mainCohortTendencies'];
    }>[];
    patienceTicks: DemandForecast['patienceTicks'];
    disclosure: DemandForecast['disclosure'];
  }>;
}>;

export type PreopenDayPlan = Readonly<{
  privateEnvelope: PreopenDayPrivateEnvelope;
  publicProjection: PreopenDayPublicProjection;
}>;

const excludedCanonicalKeys = new Set([
  'createdAt',
  'issuedAt',
  'preopenSnapshotHash',
  'timestamp',
  'timestampMs',
  'updatedAt',
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !excludedCanonicalKeys.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

/** Stable hash bytes intentionally exclude timestamps and the envelope's self hash. */
export function serializeCanonicalPreopenDayPayload(payload: object): string {
  return JSON.stringify(canonicalize(payload));
}

function canonicalHash(payload: object): string {
  return createHash('sha256').update(serializeCanonicalPreopenDayPayload(payload)).digest('hex');
}

function assertVersionArtifacts(artifacts: PreopenDayServerArtifacts): void {
  for (const [name, value] of Object.entries(artifacts.versions)) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`missing required version artifact: ${name}`);
    }
  }
  if (artifacts.versions.preopenSchema !== PREOPEN_DAY_ENVELOPE_VERSION) {
    throw new Error('pre-open schema version artifact does not match this envelope');
  }
  for (const [name, value] of Object.entries({
    preopenSnapshotId: artifacts.preopenSnapshotId,
    saveId: artifacts.saveId,
    openingSnapshotId: artifacts.openingSnapshot.openingSnapshotId,
    openingSnapshotHash: artifacts.openingSnapshot.openingSnapshotHash,
    accountingVersion: artifacts.accountingEvidence.accountingVersion,
  })) {
    if (!value || value.trim().length === 0)
      throw new Error(`missing server-owned artifact: ${name}`);
  }
  if (!/^[a-f0-9]{64}$/.test(artifacts.openingSnapshot.openingSnapshotHash)) {
    throw new Error('openingSnapshotHash must be a SHA-256 hex digest');
  }
  if (artifacts.accountingEvidence.accountingVersion !== artifacts.versions.accounting) {
    throw new Error('accounting evidence version must match the server-owned version artifact');
  }
  assertCatalogContract(
    artifacts.e01.recipeCatalog,
    artifacts.e01.ingredientCatalog,
    artifacts.e01.substitutionCatalog,
  );
  if (
    artifacts.e01.ingredientCatalog.some(
      (ingredient) => ingredient.revision !== artifacts.versions.ingredientCatalog,
    )
  ) {
    throw new Error('ingredient catalog entries must match the claimed catalog revision');
  }
  if (
    artifacts.e01.recipeCatalog.some(
      (recipe) => recipe.catalogRevision !== artifacts.versions.recipeCatalog,
    )
  ) {
    throw new Error('recipe catalog entries must match the claimed catalog revision');
  }
  if (
    artifacts.e01.substitutionCatalog.some(
      (substitution) =>
        substitution.catalogRevision !== artifacts.versions.substitutionCatalog,
    )
  ) {
    throw new Error('substitution catalog entries must match the claimed catalog revision');
  }
  const catalogCurrencies = new Set(
    artifacts.e01.ingredientCatalog.map((ingredient) => ingredient.referenceUnitPrice.currency),
  );
  if (
    catalogCurrencies.size !== 1 ||
    !catalogCurrencies.has(artifacts.e01.cashAvailable.currency) ||
    artifacts.e01.openingInventory.currency !== artifacts.e01.cashAvailable.currency
  ) {
    throw new Error('catalog, inventory, and cash must use one settlement currency');
  }
  const expectedMarket = createMarketSnapshot({
    saveId: artifacts.saveId,
    businessDay: artifacts.businessDay,
    marketSeed: artifacts.e01.marketSnapshot.marketSeed,
    catalogRevision: artifacts.versions.ingredientCatalog,
    simulationRuleVersion: artifacts.versions.simulationRule,
    ingredientCatalog: artifacts.e01.ingredientCatalog,
  });
  if (JSON.stringify(expectedMarket) !== JSON.stringify(artifacts.e01.marketSnapshot)) {
    throw new Error('market snapshot must match the canonical catalog, rule, save, day, and seed');
  }
  if (!artifacts.demandSeed.trim()) {
    throw new Error('missing server-owned artifact: demandSeed');
  }
  const openingCashEntries = artifacts.accountingEvidence.entries.filter(
    (entry) => entry.kind === 'OPENING_CASH',
  );
  if (
    openingCashEntries.length !== 1 ||
    openingCashEntries[0]!.currency !== artifacts.e01.cashAvailable.currency ||
    openingCashEntries[0]!.amountMinorUnits !== artifacts.e01.cashAvailable.minorUnits ||
    artifacts.accountingEvidence.entries.some(
      (entry) =>
        !entry.referenceId.trim() ||
        !entry.kind.trim() ||
        entry.currency !== artifacts.e01.cashAvailable.currency ||
        !/^(?:0|[1-9]\d*)$/.test(entry.amountMinorUnits),
    )
  ) {
    throw new Error('accounting evidence must reconcile to the opening settlement cash');
  }
  if (!Number.isSafeInteger(artifacts.businessDay) || artifacts.businessDay <= 0) {
    throw new Error('business day must be a positive server-owned integer');
  }
}

function publicForecast(forecast: DemandForecast): PreopenDayPublicProjection['demandForecast'] {
  return Object.freeze({
    day: forecast.day,
    periodPlan: forecast.periodPlan,
    weather: { ...forecast.weather },
    allDayGroups: { ...forecast.allDayGroups },
    periods: Object.freeze(
      forecast.periods.map((period) =>
        Object.freeze({
          period: period.period,
          groups: { ...period.groups },
          mainCohortTendencies: Object.freeze([...period.mainCohortTendencies]),
        }),
      ),
    ),
    patienceTicks: Object.freeze(
      Object.fromEntries(
        Object.entries(forecast.patienceTicks).map(([cohort, range]) => [cohort, { ...range }]),
      ),
    ) as DemandForecast['patienceTicks'],
    disclosure: { ...forecast.disclosure },
  });
}

function servicePeriodPlanForInventory(plan: ServicePeriodPlan): 'TWO_PERIOD' | 'THREE_PERIOD' {
  return plan === 'TWO_PERIODS' ? 'TWO_PERIOD' : 'THREE_PERIOD';
}

/** Pure CONFIGURE_PREOPEN_DAY composition; it does not persist or open a day. */
export function createPreopenDayPlan(
  intent: ConfigurePreopenDayIntent,
  artifacts: PreopenDayServerArtifacts,
): PreopenDayPlan {
  assertVersionArtifacts(artifacts);
  const menu = createMenuSelection({
    businessDay: artifacts.businessDay,
    phase: 'PRE_OPEN',
    difficulty: artifacts.menuDifficulty,
    themeId: intent.menuChoice.themeId,
    recipeVersionIds: [...intent.menuChoice.recipeVersionIds].sort(),
    priceModifierPercentByRecipe: Object.fromEntries(
      Object.entries(intent.menuChoice.priceModifierPercentByRecipe).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    enabledSubstitutionIds: [...intent.menuChoice.enabledSubstitutionIds].sort(),
    recipeCatalog: artifacts.e01.recipeCatalog,
    ingredientCatalog: artifacts.e01.ingredientCatalog,
    substitutionCatalog: artifacts.e01.substitutionCatalog,
  });
  const configuredLayout = configureFirstDayLayout(
    artifacts.e02.currentLayoutRevision,
    intent.floorPlan,
    artifacts.scenario,
    artifacts.servicePeriodPlan,
    'PRE_OPEN',
    artifacts.equipmentState,
  ).snapshot;
  let inventory = artifacts.e01.openingInventory;
  let cashAvailable = artifacts.e01.cashAvailable;
  for (const delta of [...intent.spotPurchaseDeltas].sort((left, right) =>
    left.ingredientId.localeCompare(right.ingredientId),
  )) {
    const purchaseIds = artifacts.e01.spotPurchaseIdsForIngredient(delta.ingredientId);
    if (
      !purchaseIds.transactionId.trim() ||
      !purchaseIds.purchaseId.trim() ||
      purchaseIds.transactionId === purchaseIds.purchaseId
    ) {
      throw new Error('spot purchase ID factory must return distinct non-empty identities');
    }
    const result = purchaseSpotInventory(inventory, artifacts.e01.ingredientCatalog, {
      transactionId: purchaseIds.transactionId,
      purchaseId: purchaseIds.purchaseId,
      businessDay: artifacts.businessDay,
      phase: 'BEFORE_OPENING_AFTER_CONTRACTS',
      themeId: menu.themeId,
      ingredientId: delta.ingredientId,
      quantityPoints: delta.quantityPoints,
      cashAvailable,
      marketSnapshot: artifacts.e01.marketSnapshot,
    });
    if (result.status !== 'PURCHASED') {
      throw new Error(`spot purchase cannot be funded for ingredient ${delta.ingredientId}`);
    }
    inventory = result.inventory;
    cashAvailable = result.remainingCash;
  }
  const inventoryProcurement = createInventoryProcurementOpeningSnapshot({
    snapshotSchemaVersion: artifacts.versions.preopenSchema,
    simulationRuleVersion: artifacts.versions.simulationRule,
    catalogRevisions: {
      ingredientCatalog: artifacts.versions.ingredientCatalog,
      recipeCatalog: artifacts.versions.recipeCatalog,
      substitutionCatalog: artifacts.versions.substitutionCatalog,
    },
    servicePeriodPlan: servicePeriodPlanForInventory(artifacts.servicePeriodPlan),
    operatingMode: artifacts.operatingMode,
    menu,
    market: artifacts.e01.marketSnapshot,
    capacity: inventory.capacity,
    openingStocks: inventory.stocks,
    openingReservations: artifacts.e01.openingReservations,
    outstandingContracts: artifacts.e01.outstandingContracts,
    reservedUndelivered: artifacts.e01.reservedUndelivered,
  });
  const demand = artifacts.demand.create({
    businessDay: artifacts.businessDay,
    scenario: artifacts.scenario,
    operatingMode: artifacts.operatingMode,
    servicePeriodPlan: artifacts.servicePeriodPlan,
    demandSeed: artifacts.demandSeed,
    simulationRuleVersion: artifacts.versions.simulationRule,
    activeRecipeVersionIds: Object.freeze(menu.items.map((item) => item.recipeVersionId)),
    priceModifierPercentByRecipe: Object.freeze(
      Object.fromEntries(
        menu.items.map((item) => [item.recipeVersionId, item.priceModifierPercent]),
      ),
    ),
    layout: configuredLayout,
  });
  if (
    demand.schedule.day !== artifacts.businessDay ||
    demand.forecast.day !== artifacts.businessDay ||
    demand.schedule.scenario !== artifacts.scenario ||
    demand.schedule.operatingMode !== artifacts.operatingMode ||
    demand.schedule.periodPlan !== artifacts.servicePeriodPlan ||
    demand.forecast.periodPlan !== artifacts.servicePeriodPlan ||
    demand.schedule.demandSeed !== artifacts.demandSeed
  ) {
    throw new Error('server-owned demand artifacts must match the save authority');
  }
  const privatePayload = {
    envelopeVersion: PREOPEN_DAY_ENVELOPE_VERSION,
    preopenSnapshotId: artifacts.preopenSnapshotId,
    saveId: artifacts.saveId,
    businessDay: artifacts.businessDay,
    scenario: artifacts.scenario,
    operatingMode: artifacts.operatingMode,
    versions: artifacts.versions,
    openingSnapshot: artifacts.openingSnapshot,
    menu,
    layout: configuredLayout,
    inventoryProcurement,
    demandSchedule: demand.schedule,
    demandForecast: demand.forecast,
    accountingEvidence: artifacts.accountingEvidence,
  };
  const privateEnvelope = Object.freeze({
    ...privatePayload,
    preopenSnapshotHash: canonicalHash(privatePayload),
  }) as PreopenDayPrivateEnvelope;
  const publicProjection: PreopenDayPublicProjection = Object.freeze({
    envelopeVersion: PREOPEN_DAY_ENVELOPE_VERSION,
    preopenSnapshotId: privateEnvelope.preopenSnapshotId,
    preopenSnapshotHash: privateEnvelope.preopenSnapshotHash,
    businessDay: privateEnvelope.businessDay,
    menu: Object.freeze({
      themeId: menu.themeId,
      items: Object.freeze(
        menu.items.map((item) =>
          Object.freeze({
            ...item,
            enabledSubstitutionIds: Object.freeze([...item.enabledSubstitutionIds]),
          }),
        ),
      ),
    }),
    floorPlan: Object.freeze({
      revision: configuredLayout.revision,
      layoutHash: configuredLayout.layoutHash,
      layout: configuredLayout.layout,
    }),
    demandForecast: publicForecast(demand.forecast),
  });
  return Object.freeze({ privateEnvelope, publicProjection });
}
