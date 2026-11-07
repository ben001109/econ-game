import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMenuSelection,
  type CatalogSubstitution,
  type IngredientCatalogItem,
  type RecipeVersion,
} from '../domains/inventory-procurement/catalog-menu.js';
import {
  createFirstDayDemandSchedule,
  createPreOpeningForecast,
} from '../domains/demand-flow/demand-flow.js';
import { createEmptyInventory } from '../domains/inventory-procurement/inventory.js';
import { createMarketSnapshot } from '../domains/inventory-procurement/procurement.js';
import { createMoney } from '../domains/money/money.js';
import {
  parseConfigurePreopenDayIntent,
  parseOpenBusinessDayIntent,
} from './preopen-day-contract.js';
import {
  createPreopenDayPlan,
  serializeCanonicalPreopenDayPayload,
  type PreopenDayServerArtifacts,
} from './preopen-day-plan.js';

const ingredients: readonly IngredientCatalogItem[] = [
  {
    id: 'rice',
    revision: 'i1',
    kind: 'COMMON',
    pool: 'DURABLE',
    referenceUnitPrice: createMoney('TWD', '10'),
    unlockedThemeIds: ['bistro'],
  },
  {
    id: 'sauce',
    revision: 'i1',
    kind: 'COMMON',
    pool: 'DURABLE',
    referenceUnitPrice: createMoney('TWD', '10'),
    unlockedThemeIds: ['bistro'],
  },
  {
    id: 'chicken',
    revision: 'i1',
    kind: 'COMMON',
    pool: 'PERISHABLE',
    referenceUnitPrice: createMoney('TWD', '20'),
    unlockedThemeIds: ['bistro'],
  },
];
const recipes: readonly RecipeVersion[] = Array.from({ length: 6 }, (_, index) => ({
  id: `r${index + 1}:v1`,
  recipeId: `r${index + 1}`,
  version: 1,
  catalogRevision: 'r1',
  themeId: 'bistro',
  baseQuality: 80,
  ingredients: [
    { ingredientId: 'rice', quantityPoints: 1 },
    { ingredientId: 'sauce', quantityPoints: 1 },
    { ingredientId: 'chicken', quantityPoints: 1 },
  ],
}));
const substitutions: readonly CatalogSubstitution[] = [];

function configureIntent() {
  return parseConfigurePreopenDayIntent({
    menuChoice: {
      themeId: 'bistro',
      recipeVersionIds: ['r3:v1', 'r1:v1', 'r2:v1'],
      priceModifierPercentByRecipe: { 'r3:v1': 1, 'r1:v1': 0, 'r2:v1': -1 },
      enabledSubstitutionIds: [],
    },
    floorPlan: {
      width: 10,
      height: 9,
      servicePoint: { x: 0, y: 0 },
      fixtures: [
        { fixtureId: 'walkway-1', kind: 'WALKWAY', x: 1, y: 0 },
        { fixtureId: 'seat-1', kind: 'SEAT', x: 2, y: 0 },
        { fixtureId: 'waiting-1', kind: 'WAITING_ZONE', x: 1, y: 1 },
      ],
    },
    spotPurchaseDeltas: [{ ingredientId: 'rice', quantityPoints: 2 }],
  });
}

function artifacts(overrides: Partial<PreopenDayServerArtifacts> = {}): PreopenDayServerArtifacts {
  const marketSnapshot = createMarketSnapshot({
    saveId: 'save-1',
    businessDay: 1,
    marketSeed: 'server-market-seed',
    catalogRevision: 'i1',
    simulationRuleVersion: 'rules-1',
    ingredientCatalog: ingredients,
  });
  return {
    preopenSnapshotId: 'preopen-1',
    saveId: 'save-1',
    businessDay: 1,
    scenario: 'DEFAULT_SMALL_SHOP',
    operatingMode: 'STRATEGY',
    demandSeed: 'server-demand-seed',
    menuDifficulty: 'STANDARD',
    servicePeriodPlan: 'TWO_PERIODS',
    equipmentState: 'BASIC',
    versions: {
      preopenSchema: 'p0-preopen-day/v1',
      simulationRule: 'rules-1',
      ingredientCatalog: 'i1',
      recipeCatalog: 'r1',
      substitutionCatalog: 's1',
      accounting: 'accounting-1',
    },
    openingSnapshot: { openingSnapshotId: 'opening-1', openingSnapshotHash: 'a'.repeat(64) },
    e01: {
      recipeCatalog: recipes,
      ingredientCatalog: ingredients,
      substitutionCatalog: substitutions,
      openingInventory: createEmptyInventory('TWD', { DURABLE: 30, PERISHABLE: 30 }),
      marketSnapshot,
      openingReservations: [],
      outstandingContracts: [],
      reservedUndelivered: [],
      cashAvailable: createMoney('TWD', '1000'),
      spotPurchaseIdsForIngredient: (id) => ({
        transactionId: `tx:${id}`,
        purchaseId: `purchase:${id}`,
      }),
    },
    e02: { currentLayoutRevision: 0 },
    demand: {
      create: ({
        scenario,
        operatingMode,
        businessDay,
        activeRecipeVersionIds,
        priceModifierPercentByRecipe,
      }) => {
        assert.deepEqual(activeRecipeVersionIds, ['r1:v1', 'r2:v1', 'r3:v1']);
        assert.deepEqual(priceModifierPercentByRecipe, {
          'r1:v1': 0,
          'r2:v1': -1,
          'r3:v1': 1,
        });
        const schedule = createFirstDayDemandSchedule({
          scenario,
          operatingMode,
          periodPlan: 'TWO_PERIODS',
          demandSeed: 'server-demand-seed',
          weather: { label: 'CLEAR', demandModifierPercent: 0 },
          activeRecipeVersionIds,
          priceModifierPercentByRecipe,
          basePatienceTicks: { min: 8, max: 12 },
          periodTickWindows: { LUNCH: { start: 0, end: 9 }, DINNER: { start: 10, end: 19 } },
        });
        assert.equal(businessDay, 1);
        return { schedule, forecast: createPreOpeningForecast(schedule, { min: 8, max: 12 }) };
      },
    },
    accountingEvidence: {
      accountingVersion: 'accounting-1',
      entries: [
        {
          referenceId: 'opening-cash',
          kind: 'OPENING_CASH',
          amountMinorUnits: '1000',
          currency: 'TWD',
        },
      ],
    },
    ...overrides,
  };
}

test('configure parser rejects authority fields, invalid prices, duplicate IDs, and coordinates', () => {
  const raw = {
    menuChoice: {
      themeId: 'bistro',
      recipeVersionIds: ['r1:v1'],
      priceModifierPercentByRecipe: { 'r1:v1': 0 },
      enabledSubstitutionIds: [],
    },
    floorPlan: { width: 1, height: 1, servicePoint: { x: 0, y: 0 }, fixtures: [] },
    spotPurchaseDeltas: [],
  };
  assert.throws(
    () => parseConfigurePreopenDayIntent({ ...raw, seed: 'forged' }),
    /unknown or missing/,
  );
  assert.throws(
    () =>
      parseConfigurePreopenDayIntent({
        ...raw,
        menuChoice: { ...raw.menuChoice, priceModifierPercentByRecipe: { 'r1:v1': 11 } },
      }),
    /price/,
  );
  assert.throws(
    () =>
      parseConfigurePreopenDayIntent({
        ...raw,
        menuChoice: {
          ...raw.menuChoice,
          recipeVersionIds: ['r1:v1', 'r1:v1'],
          priceModifierPercentByRecipe: { 'r1:v1': 0 },
        },
      }),
    /duplicates/,
  );
  assert.throws(
    () =>
      parseConfigurePreopenDayIntent({
        ...raw,
        floorPlan: { ...raw.floorPlan, servicePoint: { x: 1, y: 0 } },
      }),
    /inside/,
  );
  assert.throws(
    () =>
      parseConfigurePreopenDayIntent({
        ...raw,
        spotPurchaseDeltas: [{ ingredientId: 'rice', quantityPoints: 0 }],
      }),
    /quantityPoints/,
  );
});

test('open parser accepts only the stale snapshot pin', () => {
  assert.deepEqual(
    parseOpenBusinessDayIntent({
      preopenSnapshotId: 'preopen-1',
      preopenSnapshotHash: 'b'.repeat(64),
    }),
    {
      preopenSnapshotId: 'preopen-1',
      preopenSnapshotHash: 'b'.repeat(64),
    },
  );
  assert.throws(
    () =>
      parseOpenBusinessDayIntent({
        preopenSnapshotId: 'preopen-1',
        preopenSnapshotHash: 'b'.repeat(64),
        businessDay: 2,
      }),
    /unknown or missing/,
  );
});

test('factory composes a deterministic private hash while redacting client-visible output', () => {
  const first = createPreopenDayPlan(configureIntent(), artifacts());
  const second = createPreopenDayPlan(configureIntent(), artifacts());
  assert.equal(
    first.privateEnvelope.preopenSnapshotHash,
    second.privateEnvelope.preopenSnapshotHash,
  );
  assert.equal(JSON.stringify(first.privateEnvelope), JSON.stringify(second.privateEnvelope));
  assert.equal(
    first.privateEnvelope.inventoryProcurement.openingStocks.find(
      (stock) => stock.ingredientId === 'rice',
    )?.onHandPoints,
    2,
  );
  const visible = JSON.stringify(first.publicProjection);
  for (const hidden of [
    'server-demand-seed',
    'server-market-seed',
    'arrivalTick',
    'hiddenPatienceTicks',
    'demandSchedule',
    'inventoryProcurement',
    'openingStocks',
    'accountingEvidence',
    'recipePreferenceOrder',
    'primaryRecipeVersionId',
  ]) {
    assert.equal(visible.includes(hidden), false, `${hidden} must not be public`);
  }
  assert.equal(first.publicProjection.demandForecast.periods.length, 2);
  assert.deepEqual(
    first.publicProjection.demandForecast.allDayGroups,
    first.privateEnvelope.demandForecast.allDayGroups,
  );
  assert.deepEqual(
    first.publicProjection.demandForecast.periods.map((period) => period.groups),
    first.privateEnvelope.demandForecast.periods.map((period) => period.groups),
  );
  assert.deepEqual(
    first.publicProjection.demandForecast.patienceTicks,
    first.privateEnvelope.demandForecast.patienceTicks,
  );
  assert.equal(
    first.publicProjection.demandForecast.periods.every(
      (period) =>
        typeof period.groups.min === 'number' &&
        typeof period.groups.max === 'number' &&
        !Array.isArray(period.groups),
    ),
    true,
  );
  assert.equal('groups' in first.publicProjection.demandForecast, false);
  assert.equal('demandSeed' in first.publicProjection.demandForecast, false);
  assert.equal(first.publicProjection.menu.items[0]?.recipeVersionId, 'r1:v1');
  const canonicalPrivatePayload = serializeCanonicalPreopenDayPayload({
    ...first.privateEnvelope,
    timestamp: 'not-hashed',
    createdAt: 'not-hashed',
  });
  for (const excluded of ['preopenSnapshotHash', 'timestamp', 'createdAt']) {
    assert.equal(
      canonicalPrivatePayload.includes(excluded),
      false,
      `${excluded} must not be hashed`,
    );
  }
});

test('factory fails closed when a required server version artifact is missing', () => {
  const bad = artifacts({ versions: { ...artifacts().versions, recipeCatalog: '' } });
  assert.throws(
    () => createPreopenDayPlan(configureIntent(), bad),
    /missing required version artifact: recipeCatalog/,
  );
});

test('factory fails closed when catalogs, market, or accounting contradict claimed versions', () => {
  const base = artifacts();
  assert.throws(
    () =>
      createPreopenDayPlan(
        configureIntent(),
        {
          ...base,
          e01: {
            ...base.e01,
            ingredientCatalog: base.e01.ingredientCatalog.map((ingredient, index) =>
              index === 0 ? { ...ingredient, revision: 'i2' } : ingredient,
            ),
          },
        },
      ),
    /ingredient catalog entries must match/,
  );
  assert.throws(
    () =>
      createPreopenDayPlan(
        configureIntent(),
        {
          ...base,
          e01: {
            ...base.e01,
            recipeCatalog: base.e01.recipeCatalog.map((recipe, index) =>
              index === 0 ? { ...recipe, catalogRevision: 'r2' } : recipe,
            ),
          },
        },
      ),
    /recipe catalog entries must match/,
  );
  assert.throws(
    () =>
      createPreopenDayPlan(
        configureIntent(),
        {
          ...base,
          e01: {
            ...base.e01,
            marketSnapshot: { ...base.e01.marketSnapshot, simulationRuleVersion: 'rules-2' },
          },
        },
      ),
    /market snapshot must match/,
  );
  assert.throws(
    () =>
      createPreopenDayPlan(
        configureIntent(),
        {
          ...base,
          accountingEvidence: {
            ...base.accountingEvidence,
            entries: base.accountingEvidence.entries.map((entry) => ({
              ...entry,
              amountMinorUnits: '999',
            })),
          },
        },
      ),
    /accounting evidence must reconcile/,
  );
});
