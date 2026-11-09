import {
  MVP_FIRST_DAY_CATALOG_VERSIONS,
  resolveMvpFirstDayCatalog,
} from '../domains/inventory-procurement/mvp-first-day-catalog.js';
import {
  createOpeningInventory,
  createStorageBundleSnapshot,
  type StorageBundleSnapshot,
} from '../domains/inventory-procurement/inventory.js';
import { createMarketSnapshot } from '../domains/inventory-procurement/procurement.js';
import { deepFreeze } from '../domains/inventory-procurement/shared.js';
import type { OpeningScenario } from '../domains/opening-scenario/catalog.js';
import {
  assertOpeningSnapshotSupported,
  createOpeningSnapshot,
  type CompetitiveOperatingMode,
  type OpeningSnapshot,
} from '../domains/opening-scenario/snapshot.js';
import type {
  PremisesEquipmentState,
  ServicePeriodPlan,
} from '../domains/demand-flow/demand-flow.js';
import { PREOPEN_DAY_ENVELOPE_VERSION } from './preopen-day-contract.js';
import { resolveMvpFirstDayDemandBuilder } from './mvp-first-day-demand-policy.js';
import type { PreopenDayServerArtifacts } from './preopen-day-plan.js';

export const MVP_FIRST_DAY_MARKET_SEED_VERSION = 'market-seed/v1' as const;
export const MVP_FIRST_DAY_ACCOUNTING_VERSION = 'mvp-first-day-accounting/v1' as const;

export type PersistedCompetitiveSavePreopenAuthority = Readonly<{
  id: string;
  scenario: OpeningScenario;
  operatingMode: CompetitiveOperatingMode;
  servicePeriodPlan: ServicePeriodPlan;
  demandSeed: string;
  simulationRuleVersion: string;
  settlementCurrency: string;
  openingSnapshot: OpeningSnapshot;
  openingSnapshotHash: string;
}>;

export type PersistedMarketSeedAuthority = Readonly<{
  saveId: string;
  seed: string;
  seedVersion: string;
}>;

export type PersistedInventoryPoolAuthority = Readonly<{
  saveId: string;
  pool: 'DURABLE' | 'PERISHABLE';
  revision: number;
  capacityPoints: number;
  storageBundleVersion: string;
  storageBundleKind: StorageBundleSnapshot['kind'];
}>;

export type PreopenSpotPurchaseIdFactory = Readonly<{
  create: (
    input: Readonly<{
      commandId: string;
      preopenSnapshotId: string;
      saveId: string;
      businessDay: 1;
      ingredientId: string;
    }>,
  ) => Readonly<{ transactionId: string; purchaseId: string }>;
}>;

export type CanonicalFirstDayPreopenAuthorityInput = Readonly<{
  command: Readonly<{
    commandId: string;
    preopenSnapshotId: string;
    businessDay: 1;
    currentLayoutRevision: number;
  }>;
  save: PersistedCompetitiveSavePreopenAuthority;
  marketSeedAuthority: PersistedMarketSeedAuthority;
  inventoryPoolAuthorities: readonly PersistedInventoryPoolAuthority[];
  spotPurchaseIdFactory: PreopenSpotPurchaseIdFactory;
}>;

const scenarios = new Set<OpeningScenario>([
  'EMPTY_PREMISES',
  'DEFAULT_SMALL_SHOP',
  'TROUBLED_SHOP',
]);
const operatingModes = new Set<CompetitiveOperatingMode>(['STRATEGY', 'LIGHTWEIGHT_REALTIME']);
const servicePeriodPlans = new Set<ServicePeriodPlan>(['TWO_PERIODS', 'THREE_PERIODS']);
const initialStorageBundleByScenario = Object.freeze({
  EMPTY_PREMISES: Object.freeze({
    kind: 'NONE' as const,
    capacity: Object.freeze({ DURABLE: 0, PERISHABLE: 0 }),
  }),
  DEFAULT_SMALL_SHOP: Object.freeze({
    kind: 'BASIC' as const,
    capacity: Object.freeze({ DURABLE: 305, PERISHABLE: 305 }),
  }),
  TROUBLED_SHOP: Object.freeze({
    kind: 'AGED' as const,
    capacity: Object.freeze({ DURABLE: 255, PERISHABLE: 255 }),
  }),
} satisfies Readonly<
  Record<
    OpeningScenario,
    Readonly<{
      kind: Exclude<StorageBundleSnapshot['kind'], 'VERSIONED_UPGRADE'>;
      capacity: Readonly<{ DURABLE: number; PERISHABLE: number }>;
    }>
  >
>);

function assertExactKeys(value: unknown, expected: readonly string[], name: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a server-owned record`);
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${name} contains unknown or missing authority fields`);
  }
}

function assertNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty server-owned identity`);
  }
}

function assertNonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function assertSaveAuthority(save: PersistedCompetitiveSavePreopenAuthority): OpeningSnapshot {
  assertExactKeys(
    save,
    [
      'demandSeed',
      'id',
      'openingSnapshot',
      'openingSnapshotHash',
      'operatingMode',
      'scenario',
      'servicePeriodPlan',
      'settlementCurrency',
      'simulationRuleVersion',
    ],
    'competitive save authority',
  );
  assertNonEmpty(save.id, 'save id');
  assertNonEmpty(save.demandSeed, 'demand seed');
  assertNonEmpty(save.simulationRuleVersion, 'simulation rule version');
  if (!scenarios.has(save.scenario)) throw new Error('unknown opening scenario authority');
  if (!operatingModes.has(save.operatingMode)) throw new Error('unknown operating mode authority');
  if (!servicePeriodPlans.has(save.servicePeriodPlan)) {
    throw new Error('unknown service period plan authority');
  }
  if (!/^[A-Z]{3}$/.test(save.settlementCurrency)) {
    throw new Error('settlement currency authority must be an ISO currency code');
  }
  if (!/^[a-f0-9]{64}$/.test(save.openingSnapshotHash)) {
    throw new Error('opening snapshot authority hash must be a SHA-256 digest');
  }
  assertOpeningSnapshotSupported(save.openingSnapshot);
  if (
    save.openingSnapshotHash !== save.openingSnapshot.openingSnapshotHash ||
    save.scenario !== save.openingSnapshot.scenario ||
    save.operatingMode !== save.openingSnapshot.operatingMode ||
    save.simulationRuleVersion !== save.openingSnapshot.simulationRuleVersion ||
    save.settlementCurrency !== save.openingSnapshot.settlementCurrency.code ||
    save.settlementCurrency !== save.openingSnapshot.settlementCash.amount.currency
  ) {
    throw new Error('opening snapshot does not match the persisted save authority');
  }
  const canonical = createOpeningSnapshot(
    {
      scenario: save.scenario,
      operatingMode: save.operatingMode,
      currency: save.settlementCurrency,
    },
    {
      snapshotSchemaVersion: save.openingSnapshot.snapshotSchemaVersion,
      openingCatalogVersion: save.openingSnapshot.openingCatalogVersion,
      currencyMetadataVersion: save.openingSnapshot.currencyMetadataVersion,
      simulationRuleVersion: save.openingSnapshot.simulationRuleVersion,
    },
  );
  if (canonical.openingSnapshotHash !== save.openingSnapshotHash) {
    throw new Error('opening snapshot payload is not the canonical E01 registry snapshot');
  }
  return canonical;
}

function equipmentState(snapshot: OpeningSnapshot): PremisesEquipmentState {
  if (snapshot.equipmentBundles.length === 0) return 'NONE';
  if (snapshot.equipmentBundles.length !== 1) {
    throw new Error('opening snapshot must contain at most one canonical equipment bundle');
  }
  return snapshot.equipmentBundles[0]!.condition;
}

function resolvePoolAuthority(
  save: PersistedCompetitiveSavePreopenAuthority,
  rows: readonly PersistedInventoryPoolAuthority[],
): Readonly<{
  revision: number;
  bundle: StorageBundleSnapshot;
}> {
  if (!Array.isArray(rows) || rows.length !== 2) {
    throw new Error('pre-open authority requires exactly two inventory pool rows');
  }
  for (const row of rows) {
    assertExactKeys(
      row,
      ['capacityPoints', 'pool', 'revision', 'saveId', 'storageBundleKind', 'storageBundleVersion'],
      'inventory pool authority',
    );
    if (row.saveId !== save.id) throw new Error('inventory pool authority belongs to another save');
    if (row.pool !== 'DURABLE' && row.pool !== 'PERISHABLE') {
      throw new Error('unknown inventory pool authority');
    }
    if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
      throw new Error('inventory pool revision must be a positive safe integer');
    }
    assertNonNegativeInteger(row.capacityPoints, `${row.pool} capacity`);
    assertNonEmpty(row.storageBundleVersion, 'storage bundle version');
  }
  const byPool = new Map(rows.map((row) => [row.pool, row]));
  if (byPool.size !== 2 || !byPool.has('DURABLE') || !byPool.has('PERISHABLE')) {
    throw new Error('inventory authority must contain DURABLE and PERISHABLE exactly once');
  }
  const durable = byPool.get('DURABLE')!;
  const perishable = byPool.get('PERISHABLE')!;
  if (
    durable.revision !== perishable.revision ||
    durable.storageBundleVersion !== perishable.storageBundleVersion ||
    durable.storageBundleKind !== perishable.storageBundleKind
  ) {
    throw new Error('inventory pool rows must share revision and storage bundle authority');
  }
  const capacity = {
    DURABLE: durable.capacityPoints,
    PERISHABLE: perishable.capacityPoints,
  };
  const expected = initialStorageBundleByScenario[save.scenario];
  if (
    durable.storageBundleKind !== expected.kind ||
    capacity.DURABLE !== expected.capacity.DURABLE ||
    capacity.PERISHABLE !== expected.capacity.PERISHABLE
  ) {
    throw new Error(
      'first-day inventory authority must match the canonical initial storage bundle',
    );
  }
  const bundle = createStorageBundleSnapshot(save.scenario, {
    version: durable.storageBundleVersion,
    kind: expected.kind,
  });
  if (
    bundle.capacity.DURABLE !== capacity.DURABLE ||
    bundle.capacity.PERISHABLE !== capacity.PERISHABLE
  ) {
    throw new Error('inventory pool capacity does not match its canonical storage bundle');
  }
  return deepFreeze({ revision: durable.revision, bundle });
}

/**
 * Builds first-day pre-open artifacts exclusively from trusted persisted
 * authority plus its versioned server demand policy. It is pure and performs
 * no reads, persistence, routing, or command dispatch.
 */
export function provideCanonicalFirstDayPreopenArtifacts(
  input: CanonicalFirstDayPreopenAuthorityInput,
): PreopenDayServerArtifacts {
  assertExactKeys(
    input,
    ['command', 'inventoryPoolAuthorities', 'marketSeedAuthority', 'save', 'spotPurchaseIdFactory'],
    'pre-open authority input',
  );
  assertExactKeys(
    input.command,
    ['businessDay', 'commandId', 'currentLayoutRevision', 'preopenSnapshotId'],
    'pre-open command authority',
  );
  assertNonEmpty(input.command.commandId, 'pre-open command id');
  assertNonEmpty(input.command.preopenSnapshotId, 'pre-open snapshot id');
  if (input.command.businessDay !== 1) {
    throw new Error('canonical opening authority can only compose the first business day');
  }
  assertNonNegativeInteger(input.command.currentLayoutRevision, 'layout revision');
  if (typeof input.spotPurchaseIdFactory?.create !== 'function') {
    throw new Error('server-owned spot-purchase ID factory is required');
  }

  const openingSnapshot = assertSaveAuthority(input.save);
  const commandId = input.command.commandId;
  const preopenSnapshotId = input.command.preopenSnapshotId;
  const businessDay = input.command.businessDay;
  const currentLayoutRevision = input.command.currentLayoutRevision;
  const saveId = input.save.id;
  const scenario = input.save.scenario;
  const operatingMode = input.save.operatingMode;
  const servicePeriodPlan = input.save.servicePeriodPlan;
  const demandSeed = input.save.demandSeed;
  const simulationRuleVersion = input.save.simulationRuleVersion;
  const openingSnapshotHash = input.save.openingSnapshotHash;
  const demandBuilder = resolveMvpFirstDayDemandBuilder(simulationRuleVersion);
  const createSpotPurchaseIds = input.spotPurchaseIdFactory.create;
  assertExactKeys(
    input.marketSeedAuthority,
    ['saveId', 'seed', 'seedVersion'],
    'market seed authority',
  );
  if (input.marketSeedAuthority.saveId !== input.save.id) {
    throw new Error('market seed authority belongs to another save');
  }
  assertNonEmpty(input.marketSeedAuthority.seed, 'market seed');
  if (input.marketSeedAuthority.seed === input.save.demandSeed) {
    throw new Error('market seed must be independently generated from the demand seed');
  }
  if (input.marketSeedAuthority.seedVersion !== MVP_FIRST_DAY_MARKET_SEED_VERSION) {
    throw new Error('unknown market seed version; replay cannot fall back to latest');
  }

  const poolAuthority = resolvePoolAuthority(input.save, input.inventoryPoolAuthorities);
  const catalog = resolveMvpFirstDayCatalog(MVP_FIRST_DAY_CATALOG_VERSIONS, {
    code: openingSnapshot.settlementCurrency.code,
    metadataVersion: openingSnapshot.currencyMetadataVersion,
  });
  const inventory = createOpeningInventory(
    input.save.scenario,
    poolAuthority.bundle,
    openingSnapshot.settlementCurrency.code,
  );
  const marketSnapshot = createMarketSnapshot({
    saveId,
    businessDay,
    marketSeed: input.marketSeedAuthority.seed,
    catalogRevision: catalog.versions.ingredientCatalog,
    simulationRuleVersion,
    ingredientCatalog: catalog.ingredientCatalog,
  });
  const accountingEvidence = deepFreeze({
    accountingVersion: MVP_FIRST_DAY_ACCOUNTING_VERSION,
    entries: [
      {
        referenceId: `opening-cash:${openingSnapshotHash}`,
        kind: 'OPENING_CASH',
        amountMinorUnits: openingSnapshot.settlementCash.amount.minorUnits,
        currency: openingSnapshot.settlementCash.amount.currency,
      },
    ],
  });

  return deepFreeze({
    preopenSnapshotId,
    saveId,
    businessDay,
    scenario,
    operatingMode,
    demandSeed,
    menuDifficulty: 'STANDARD',
    servicePeriodPlan,
    equipmentState: equipmentState(openingSnapshot),
    versions: {
      preopenSchema: PREOPEN_DAY_ENVELOPE_VERSION,
      simulationRule: simulationRuleVersion,
      ingredientCatalog: catalog.versions.ingredientCatalog,
      recipeCatalog: catalog.versions.recipeCatalog,
      substitutionCatalog: catalog.versions.substitutionCatalog,
      accounting: MVP_FIRST_DAY_ACCOUNTING_VERSION,
    },
    openingSnapshot: {
      openingSnapshotId: `competitive-save:${saveId}:opening`,
      openingSnapshotHash,
    },
    e01: {
      recipeCatalog: catalog.recipeCatalog,
      ingredientCatalog: catalog.ingredientCatalog,
      substitutionCatalog: catalog.substitutionCatalog,
      openingInventory: inventory,
      marketSnapshot,
      openingReservations: inventory.orderReservations,
      outstandingContracts: [],
      reservedUndelivered: inventory.reservedUndelivered,
      cashAvailable: openingSnapshot.settlementCash.amount,
      spotPurchaseIdsForIngredient: (ingredientId) =>
        createSpotPurchaseIds({
          commandId,
          preopenSnapshotId,
          saveId,
          businessDay,
          ingredientId,
        }),
    },
    e02: { currentLayoutRevision },
    demand: demandBuilder,
    accountingEvidence,
  });
}
