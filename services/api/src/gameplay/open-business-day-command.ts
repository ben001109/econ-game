import { createHash } from 'node:crypto';

import { CommandError, type CanonicalCommandValue } from '../commands/command-contract.js';
import type { CommandHandler } from '../commands/command-dispatcher.js';
import {
  createMenuSelection,
  type MenuSelection,
} from '../domains/inventory-procurement/catalog-menu.js';
import {
  MVP_FIRST_DAY_CATALOG_VERSIONS,
  resolveMvpFirstDayCatalog,
} from '../domains/inventory-procurement/mvp-first-day-catalog.js';
import {
  createInventoryProcurementOpeningSnapshot,
  type InventoryProcurementOpeningSnapshot,
} from '../domains/inventory-procurement/opening-snapshot.js';
import {
  createMarketSnapshot,
  type MarketSnapshot,
} from '../domains/inventory-procurement/procurement.js';
import { assertOpeningSnapshotSupported } from '../domains/opening-scenario/snapshot.js';
import {
  configureFirstDayLayout,
  type DemandForecast,
  type DemandSchedule,
  type LayoutSnapshot,
  type PremisesEquipmentState,
} from '../domains/demand-flow/demand-flow.js';
import { MVP_FIRST_DAY_ACCOUNTING_VERSION } from './preopen-day-authority-provider.js';
import {
  PREOPEN_DAY_ENVELOPE_VERSION,
  parseOpenBusinessDayIntent,
} from './preopen-day-contract.js';
import {
  serializeCanonicalPreopenDayPayload,
  type PreopenDayPrivateEnvelope,
} from './preopen-day-plan.js';
import { resolveMvpFirstDayDemandBuilder } from './mvp-first-day-demand-policy.js';
import {
  PrismaOpenBusinessDayRepository,
  type FirstDayOpenAuthority,
} from './prisma-open-business-day-repository.js';

export const OPEN_BUSINESS_DAY = 'OPEN_BUSINESS_DAY' as const;
export const BUSINESS_DAY_OPENED_EVENT_TYPE = 'gameplay.business-day.opened' as const;
export const BUSINESS_DAY_OPENED_EVENT_VERSION = 1 as const;

export function createOpenBusinessDayCommandHandler(): CommandHandler {
  return Object.freeze({
    commandType: OPEN_BUSINESS_DAY,
    async execute({ context, command, currentVersion, persistence }) {
      if (command.commandType !== OPEN_BUSINESS_DAY || command.aggregateId !== context.saveId) {
        throw new CommandError(422, 'OPEN_COMMAND_SCOPE_INVALID');
      }
      let intent;
      try {
        intent = parseOpenBusinessDayIntent(command.payload);
      } catch {
        throw new CommandError(422, 'OPEN_BUSINESS_DAY_INTENT_INVALID');
      }

      const repository = new PrismaOpenBusinessDayRepository(persistence);
      const authority = await repository.loadFirstDayOpenAuthority({
        restaurantId: context.tenantId,
        saveId: context.saveId,
        membershipId: context.membershipId,
        actorId: context.actorId,
      });
      if (
        intent.preopenSnapshotId !== authority.preopenSnapshot.id ||
        intent.preopenSnapshotHash !== authority.preopenSnapshot.snapshotHash
      ) {
        throw new CommandError(422, 'PREOPEN_SNAPSHOT_PIN_MISMATCH');
      }

      let validated;
      try {
        validated = validateCanonicalOpenAuthority(authority);
      } catch (error) {
        if (error instanceof CommandError) throw error;
        throw new CommandError(503, 'PREOPEN_SNAPSHOT_AUTHORITY_INVALID');
      }

      await repository.openFirstDay({
        restaurantId: context.tenantId,
        saveId: context.saveId,
        businessDayId: authority.businessDay.id,
        commandId: command.commandId,
        preopenSnapshotId: authority.preopenSnapshot.id,
        preopenSnapshotHash: authority.preopenSnapshot.snapshotHash,
        privatePayload: authority.preopenSnapshot.payload,
      });

      const aggregateVersion = currentVersion + 1;
      return Object.freeze({
        aggregateVersion,
        result: canonicalValue({
          competitiveSave: { id: context.saveId, version: aggregateVersion },
          businessDay: {
            id: authority.businessDay.id,
            businessDay: 1,
            status: 'OPEN',
            servicePeriodPlan: authority.businessDay.servicePeriodPlan,
            simulationRuleVersion: authority.businessDay.simulationRuleVersion,
            consumedPreopenSnapshotId: authority.preopenSnapshot.id,
            openSnapshotHash: authority.preopenSnapshot.snapshotHash,
          },
          preopenDaySnapshot: {
            id: authority.preopenSnapshot.id,
            revision: 1,
            snapshotSchemaVersion: authority.preopenSnapshot.snapshotSchemaVersion,
            snapshotHash: authority.preopenSnapshot.snapshotHash,
          },
          demandForecast: validated.publicDemandForecast,
        }),
        effects: Object.freeze({
          outbox: Object.freeze([
            Object.freeze({
              kind: 'outbox.event/v1' as const,
              eventId: command.commandId,
              eventSequence: 0,
              eventType: BUSINESS_DAY_OPENED_EVENT_TYPE,
              eventVersion: BUSINESS_DAY_OPENED_EVENT_VERSION,
              payload: Object.freeze({
                schemaVersion: 'gameplay.business-day.opened/v1',
                businessDay: 1,
                businessDayId: authority.businessDay.id,
                preopenSnapshotId: authority.preopenSnapshot.id,
                preopenSnapshotHash: authority.preopenSnapshot.snapshotHash,
                simulationRuleVersion: authority.businessDay.simulationRuleVersion,
              }),
            }),
          ]),
        }),
      });
    },
  });
}

export type ValidatedOpenAuthority = Readonly<{
  privateEnvelope: PreopenDayPrivateEnvelope;
  publicDemandForecast: DemandForecast;
}>;

export function validateCanonicalOpenAuthority(
  authority: FirstDayOpenAuthority,
): ValidatedOpenAuthority {
  const payload = exactRecord(
    authority.preopenSnapshot.payload,
    [
      'accountingEvidence',
      'businessDay',
      'demandForecast',
      'demandSchedule',
      'envelopeVersion',
      'inventoryProcurement',
      'layout',
      'menu',
      'openingSnapshot',
      'operatingMode',
      'preopenSnapshotHash',
      'preopenSnapshotId',
      'saveId',
      'scenario',
      'versions',
    ],
    'pre-open private envelope',
  );
  if (
    payload.envelopeVersion !== PREOPEN_DAY_ENVELOPE_VERSION ||
    authority.preopenSnapshot.snapshotSchemaVersion !== PREOPEN_DAY_ENVELOPE_VERSION ||
    payload.preopenSnapshotId !== authority.preopenSnapshot.id ||
    payload.preopenSnapshotHash !== authority.preopenSnapshot.snapshotHash ||
    payload.saveId !== authority.save.id ||
    payload.businessDay !== 1 ||
    payload.scenario !== authority.save.scenario ||
    payload.operatingMode !== authority.save.operatingMode
  ) {
    throw new Error('pre-open private envelope identity does not match durable authority');
  }
  const recomputedHash = createHash('sha256')
    .update(serializeCanonicalPreopenDayPayload(payload))
    .digest('hex');
  if (recomputedHash !== authority.preopenSnapshot.snapshotHash) {
    throw new Error('pre-open private envelope hash does not match canonical payload');
  }

  assertOpeningSnapshotSupported(authority.save.openingSnapshot);
  if (
    authority.save.openingSnapshot.openingSnapshotHash !== authority.save.openingSnapshotHash ||
    authority.save.openingSnapshot.scenario !== authority.save.scenario ||
    authority.save.openingSnapshot.operatingMode !== authority.save.operatingMode ||
    authority.save.openingSnapshot.simulationRuleVersion !== authority.save.simulationRuleVersion
  ) {
    throw new Error('opening snapshot does not match the competitive save authority');
  }

  const versions = exactRecord(
    payload.versions,
    [
      'accounting',
      'ingredientCatalog',
      'preopenSchema',
      'recipeCatalog',
      'simulationRule',
      'substitutionCatalog',
    ],
    'pre-open versions',
  );
  if (
    versions.preopenSchema !== PREOPEN_DAY_ENVELOPE_VERSION ||
    versions.simulationRule !== authority.save.simulationRuleVersion ||
    versions.ingredientCatalog !== MVP_FIRST_DAY_CATALOG_VERSIONS.ingredientCatalog ||
    versions.recipeCatalog !== MVP_FIRST_DAY_CATALOG_VERSIONS.recipeCatalog ||
    versions.substitutionCatalog !== MVP_FIRST_DAY_CATALOG_VERSIONS.substitutionCatalog ||
    versions.accounting !== MVP_FIRST_DAY_ACCOUNTING_VERSION ||
    authority.preopenSnapshot.simulationRuleVersion !== authority.save.simulationRuleVersion
  ) {
    throw new Error('pre-open versions do not match supported first-day authority');
  }

  const openingReference = exactRecord(
    payload.openingSnapshot,
    ['openingSnapshotHash', 'openingSnapshotId'],
    'opening snapshot reference',
  );
  if (
    openingReference.openingSnapshotId !== `competitive-save:${authority.save.id}:opening` ||
    openingReference.openingSnapshotHash !== authority.save.openingSnapshotHash
  ) {
    throw new Error('pre-open opening snapshot reference is not the durable save snapshot');
  }

  const catalog = resolveMvpFirstDayCatalog(MVP_FIRST_DAY_CATALOG_VERSIONS, {
    code: authority.save.openingSnapshot.settlementCurrency.code,
    metadataVersion: authority.save.openingSnapshot.currencyMetadataVersion,
  });
  const menu = validateMenu(payload.menu, catalog);
  const layout = validateLayout(payload.layout, authority);
  const inventory = validateInventory(payload.inventoryProcurement, authority, catalog, menu);
  validateInventoryPoolAuthority(authority, inventory);
  const demand = validateDemand(
    payload.demandSchedule,
    payload.demandForecast,
    authority,
    menu,
    layout,
  );
  validateAccounting(payload.accountingEvidence, authority);

  return Object.freeze({
    privateEnvelope: payload as unknown as PreopenDayPrivateEnvelope,
    publicDemandForecast: demand.forecast,
  });
}

function validateMenu(
  value: unknown,
  catalog: ReturnType<typeof resolveMvpFirstDayCatalog>,
): MenuSelection {
  const menu = exactRecord(
    value,
    ['businessDay', 'difficulty', 'items', 'lockedFrom', 'lockedUntil', 'themeId'],
    'pre-open menu',
  );
  if (!Array.isArray(menu.items)) throw new Error('pre-open menu items must be an array');
  const items = menu.items.map((item, index) =>
    exactRecord(
      item,
      [
        'basePrice',
        'enabledSubstitutionIds',
        'priceModifierPercent',
        'recipeVersionId',
        'salePrice',
      ],
      `pre-open menu item ${index}`,
    ),
  );
  const enabledSubstitutions = items.flatMap((item) => {
    if (!Array.isArray(item.enabledSubstitutionIds)) {
      throw new Error('menu enabled substitutions must be arrays');
    }
    return item.enabledSubstitutionIds as unknown[];
  });
  if (enabledSubstitutions.some((id) => typeof id !== 'string')) {
    throw new Error('menu substitution identities must be strings');
  }
  const expected = createMenuSelection({
    businessDay: menu.businessDay as number,
    phase: 'PRE_OPEN',
    difficulty: menu.difficulty as MenuSelection['difficulty'],
    themeId: menu.themeId as string,
    recipeVersionIds: items.map((item) => item.recipeVersionId as string),
    priceModifierPercentByRecipe: Object.fromEntries(
      items.map((item) => [item.recipeVersionId as string, item.priceModifierPercent as number]),
    ),
    enabledSubstitutionIds: enabledSubstitutions as string[],
    recipeCatalog: catalog.recipeCatalog,
    ingredientCatalog: catalog.ingredientCatalog,
    substitutionCatalog: catalog.substitutionCatalog,
  });
  if (!canonicalEqual(menu, expected)) {
    throw new Error('pre-open menu is not the canonical controlled catalog selection');
  }
  return expected;
}

function validateLayout(value: unknown, authority: FirstDayOpenAuthority): LayoutSnapshot {
  const layout = exactRecord(
    value,
    ['layout', 'layoutHash', 'revision', 'scenario', 'spaceLimits'],
    'pre-open layout',
  ) as unknown as LayoutSnapshot;
  const expected = configureFirstDayLayout(
    0,
    layout.layout,
    authority.save.scenario,
    authority.save.servicePeriodPlan,
    'PRE_OPEN',
    equipmentStateForScenario(authority.save.scenario),
  ).snapshot;
  if (!canonicalEqual(layout, expected)) {
    throw new Error('pre-open layout is not the canonical first-day revision');
  }
  return expected;
}

function validateInventory(
  value: unknown,
  authority: FirstDayOpenAuthority,
  catalog: ReturnType<typeof resolveMvpFirstDayCatalog>,
  menu: MenuSelection,
): InventoryProcurementOpeningSnapshot {
  const inventory = exactRecord(
    value,
    [
      'capacity',
      'catalogRevisions',
      'market',
      'menu',
      'openingReservations',
      'openingStocks',
      'operatingMode',
      'outstandingContracts',
      'reservedUndelivered',
      'servicePeriodPlan',
      'simulationRuleVersion',
      'snapshotHash',
      'snapshotSchemaVersion',
    ],
    'inventory opening snapshot',
  ) as unknown as InventoryProcurementOpeningSnapshot;
  const expected = createInventoryProcurementOpeningSnapshot({
    snapshotSchemaVersion: inventory.snapshotSchemaVersion,
    simulationRuleVersion: inventory.simulationRuleVersion,
    catalogRevisions: inventory.catalogRevisions,
    servicePeriodPlan: inventory.servicePeriodPlan,
    operatingMode: inventory.operatingMode,
    menu: inventory.menu,
    market: inventory.market,
    capacity: inventory.capacity,
    openingStocks: inventory.openingStocks,
    openingReservations: inventory.openingReservations,
    outstandingContracts: inventory.outstandingContracts,
    reservedUndelivered: inventory.reservedUndelivered,
  });
  if (!canonicalEqual(inventory, expected)) {
    throw new Error('inventory opening snapshot hash or canonical payload is invalid');
  }
  if (!canonicalEqual(inventory.menu, menu)) {
    throw new Error('inventory opening snapshot menu differs from the pre-open menu');
  }
  if (
    inventory.snapshotSchemaVersion !== PREOPEN_DAY_ENVELOPE_VERSION ||
    inventory.simulationRuleVersion !== authority.save.simulationRuleVersion ||
    inventory.operatingMode !== authority.save.operatingMode ||
    inventory.servicePeriodPlan !==
      (authority.save.servicePeriodPlan === 'TWO_PERIODS' ? 'TWO_PERIOD' : 'THREE_PERIOD') ||
    inventory.catalogRevisions.ingredientCatalog !== catalog.versions.ingredientCatalog ||
    inventory.catalogRevisions.recipeCatalog !== catalog.versions.recipeCatalog ||
    inventory.catalogRevisions.substitutionCatalog !== catalog.versions.substitutionCatalog
  ) {
    throw new Error('inventory opening snapshot does not match the save and catalog authority');
  }
  const market = inventory.market as MarketSnapshot;
  if (market.marketSeed === authority.save.demandSeed) {
    throw new Error('market and demand seed authorities must remain independent');
  }
  const expectedMarket = createMarketSnapshot({
    saveId: authority.save.id,
    businessDay: 1,
    marketSeed: market.marketSeed,
    catalogRevision: catalog.versions.ingredientCatalog,
    simulationRuleVersion: authority.save.simulationRuleVersion,
    ingredientCatalog: catalog.ingredientCatalog,
  });
  if (!canonicalEqual(market, expectedMarket)) {
    throw new Error('inventory market snapshot is not canonical');
  }
  return expected;
}

function validateInventoryPoolAuthority(
  authority: FirstDayOpenAuthority,
  inventory: InventoryProcurementOpeningSnapshot,
): void {
  const [first, second] = authority.inventoryPoolAuthorities;
  if (!first || !second) throw new Error('two inventory pool authorities are required');
  if (
    first.revision !== second.revision ||
    first.storageBundleKind !== second.storageBundleKind ||
    first.storageBundleVersion !== second.storageBundleVersion
  ) {
    throw new Error('inventory pool authorities do not describe one storage bundle revision');
  }
  const byPool = new Map(authority.inventoryPoolAuthorities.map((row) => [row.pool, row]));
  const durable = byPool.get('DURABLE')!;
  const perishable = byPool.get('PERISHABLE')!;
  if (
    inventory.capacity.DURABLE !== durable.capacityPoints ||
    inventory.capacity.PERISHABLE !== perishable.capacityPoints
  ) {
    throw new Error('pre-open inventory capacity does not match locked pool authority');
  }

  if (authority.save.scenario === 'EMPTY_PREMISES') {
    if (
      first.storageBundleKind === 'NONE' &&
      durable.capacityPoints === 0 &&
      perishable.capacityPoints === 0
    ) {
      throw new CommandError(422, 'OPEN_STORAGE_NOT_INSTALLED');
    }
    if (
      first.storageBundleKind !== 'BASIC' ||
      durable.capacityPoints !== 280 ||
      perishable.capacityPoints !== 280
    ) {
      throw new Error('EMPTY may open only with an actually persisted BASIC 280/280 bundle');
    }
    return;
  }
  const expected =
    authority.save.scenario === 'DEFAULT_SMALL_SHOP'
      ? { kind: 'BASIC', capacity: 305 }
      : { kind: 'AGED', capacity: 255 };
  if (
    first.storageBundleKind !== expected.kind ||
    durable.capacityPoints !== expected.capacity ||
    perishable.capacityPoints !== expected.capacity
  ) {
    throw new Error('first-day storage authority does not match its opening scenario');
  }
}

function validateDemand(
  scheduleValue: unknown,
  forecastValue: unknown,
  authority: FirstDayOpenAuthority,
  menu: MenuSelection,
  layout: LayoutSnapshot,
): Readonly<{ schedule: DemandSchedule; forecast: DemandForecast }> {
  const schedule = scheduleValue as DemandSchedule;
  const forecast = forecastValue as DemandForecast;
  if (schedule === null || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw new Error('demand schedule must be an object');
  }
  if (forecast === null || typeof forecast !== 'object' || Array.isArray(forecast)) {
    throw new Error('demand forecast must be an object');
  }
  if (schedule.demandSeed !== authority.save.demandSeed) {
    throw new Error('demand schedule seed does not match the save authority');
  }
  const expected = resolveMvpFirstDayDemandBuilder(authority.save.simulationRuleVersion).create({
    businessDay: 1,
    scenario: authority.save.scenario,
    operatingMode: authority.save.operatingMode,
    servicePeriodPlan: authority.save.servicePeriodPlan,
    demandSeed: authority.save.demandSeed,
    simulationRuleVersion: authority.save.simulationRuleVersion,
    activeRecipeVersionIds: menu.items.map((item) => item.recipeVersionId),
    priceModifierPercentByRecipe: Object.fromEntries(
      menu.items.map((item) => [item.recipeVersionId, item.priceModifierPercent]),
    ),
    layout,
  });
  if (
    !canonicalEqual(schedule, expected.schedule) ||
    !canonicalEqual(forecast, expected.forecast)
  ) {
    throw new Error('demand schedule or forecast is not canonical for the persisted authority');
  }
  return expected;
}

function validateAccounting(value: unknown, authority: FirstDayOpenAuthority): void {
  const accounting = exactRecord(
    value,
    ['accountingVersion', 'entries'],
    'pre-open accounting evidence',
  );
  if (accounting.accountingVersion !== MVP_FIRST_DAY_ACCOUNTING_VERSION) {
    throw new Error('unknown first-day accounting evidence version');
  }
  const expected = {
    accountingVersion: MVP_FIRST_DAY_ACCOUNTING_VERSION,
    entries: [
      {
        referenceId: `opening-cash:${authority.save.openingSnapshotHash}`,
        kind: 'OPENING_CASH',
        amountMinorUnits: authority.save.openingSnapshot.settlementCash.amount.minorUnits,
        currency: authority.save.openingSnapshot.settlementCash.amount.currency,
      },
    ],
  };
  if (!canonicalEqual(accounting, expected)) {
    throw new Error('opening accounting evidence does not match the immutable opening snapshot');
  }
}

function equipmentStateForScenario(
  scenario: FirstDayOpenAuthority['save']['scenario'],
): PremisesEquipmentState {
  if (scenario === 'EMPTY_PREMISES') return 'NONE';
  return scenario === 'DEFAULT_SMALL_SHOP' ? 'BASIC' : 'AGED';
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a record`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
  return value as Record<string, unknown>;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  function normalize(nested: unknown): unknown {
    if (Array.isArray(nested)) return nested.map(normalize);
    if (nested !== null && typeof nested === 'object') {
      return Object.fromEntries(
        Object.entries(nested as Record<string, unknown>)
          .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return nested;
  }
  return JSON.stringify(normalize(value));
}

function canonicalValue(value: unknown): CanonicalCommandValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(canonicalValue));
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([, nested]) => nested === undefined)) {
      throw new CommandError(503, 'OPEN_PUBLIC_PROJECTION_INVALID');
    }
    return Object.freeze(
      Object.fromEntries(entries.map(([key, nested]) => [key, canonicalValue(nested)])),
    );
  }
  throw new CommandError(503, 'OPEN_PUBLIC_PROJECTION_INVALID');
}
