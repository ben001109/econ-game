import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateSalePrice } from '../domains/inventory-procurement/catalog-menu.js';
import { MVP_FIRST_DAY_CATALOG_VERSIONS } from '../domains/inventory-procurement/mvp-first-day-catalog.js';
import { FIRST_DAY_SPACE_CATALOG_VERSION } from '../domains/demand-flow/demand-flow.js';
import { MVP_OPENING_VERSIONS } from '../domains/opening-scenario/registry.js';
import { PREOPEN_DAY_ENVELOPE_VERSION } from './preopen-day-contract.js';
import {
  PREOPEN_CONFIGURATION_CHOICES_ERROR_CODES,
  PreopenConfigurationChoicesError,
  providePreopenConfigurationChoices,
  type PreopenConfigurationChoicesAuthority,
} from './preopen-configuration-choices.js';

function authority(
  overrides: Partial<PreopenConfigurationChoicesAuthority['save']> = {},
): PreopenConfigurationChoicesAuthority {
  return {
    save: {
      id: 'save-1',
      expectedVersion: 4,
      phase: 'CONFIGURE_REQUIRED',
      scenario: 'DEFAULT_SMALL_SHOP',
      operatingMode: 'STRATEGY',
      servicePeriodPlan: 'TWO_PERIODS',
      simulationRuleVersion: MVP_OPENING_VERSIONS.simulationRuleVersion,
      settlementCurrency: 'TWD',
      ...overrides,
    },
  };
}

function assertRecursivelyFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertRecursivelyFrozen(nested);
}

test('provides fixed first-day choices from scalar persisted authority only', () => {
  const choices = providePreopenConfigurationChoices(authority());

  assert.deepEqual(choices.save, {
    id: 'save-1',
    expectedVersion: 4,
    scenario: 'DEFAULT_SMALL_SHOP',
    operatingMode: 'STRATEGY',
    servicePeriodPlan: 'TWO_PERIODS',
    servicePeriods: ['LUNCH', 'DINNER'],
    simulationRuleVersion: MVP_OPENING_VERSIONS.simulationRuleVersion,
  });
  assert.equal(choices.businessDay, 1);
  assert.deepEqual(choices.versions, {
    preopenSchema: PREOPEN_DAY_ENVELOPE_VERSION,
    openingCatalog: MVP_OPENING_VERSIONS.openingCatalogVersion,
    simulationRule: MVP_OPENING_VERSIONS.simulationRuleVersion,
    currencyMetadata: MVP_OPENING_VERSIONS.currencyMetadataVersion,
    catalog: MVP_FIRST_DAY_CATALOG_VERSIONS.catalog,
    ingredientCatalog: MVP_FIRST_DAY_CATALOG_VERSIONS.ingredientCatalog,
    recipeCatalog: MVP_FIRST_DAY_CATALOG_VERSIONS.recipeCatalog,
    substitutionCatalog: MVP_FIRST_DAY_CATALOG_VERSIONS.substitutionCatalog,
    floorSpace: FIRST_DAY_SPACE_CATALOG_VERSION,
  });
  assert.equal(choices.menu.difficulty, 'STANDARD');
  assert.equal(choices.menu.requiredRecipeCount, 3);
  assert.equal(choices.menu.recipeCards.length, 6);
  assert.deepEqual(choices.procurement.poolCapacities, { DURABLE: 305, PERISHABLE: 305 });
  assert.equal(choices.procurement.spendLimit.currency, 'TWD');
  assert.deepEqual(choices.floor, {
    catalogVersion: FIRST_DAY_SPACE_CATALOG_VERSION,
    width: 10,
    height: 9,
    usableFloorCells: 90,
    maxSeats: 30,
    maxWaitingGroups: 4,
    allowedFixtureKinds: ['SEAT', 'WALKWAY', 'WAITING_ZONE'],
    constraints: {
      phase: 'PRE_OPEN',
      exactScenarioDimensionsRequired: true,
      servicePointInBoundsRequired: true,
      servicePointMustNotOverlapFixture: true,
      fixtureIdsMustBeUnique: true,
      fixturesMustBeInBounds: true,
      fixturesMustNotOverlap: true,
      seatsAndWaitingZonesRequireWalkwayConnection: true,
    },
  });
});

test('every canonical bistro card has exactly the server-calculated -10 through +10 price options', () => {
  const choices = providePreopenConfigurationChoices(authority());
  for (const card of choices.menu.recipeCards) {
    assert.deepEqual(
      card.priceOptions.map((option) => option.modifierPercent),
      Array.from({ length: 21 }, (_, index) => index - 10),
    );
    for (const option of card.priceOptions) {
      assert.deepEqual(
        option.salePrice,
        calculateSalePrice(card.basePrice, option.modifierPercent),
      );
    }
  }
  assert.deepEqual(
    choices.procurement.lockedDay1Quotes.map((quote) => quote.priceModifierBps),
    [0, 0, 0, 0, 0, 0],
  );
});

test('choices are deeply frozen and exclude private simulation, identity, and accounting fields', () => {
  const choices = providePreopenConfigurationChoices(authority());
  assertRecursivelyFrozen(choices);
  const visible = JSON.stringify(choices);
  for (const forbidden of [
    'seed',
    'arrivalTick',
    'patience',
    'preopenSnapshotHash',
    'openingSnapshot',
    'accounting',
    'membership',
    'restaurant',
    'player',
    'transactionId',
    'spotPurchaseId',
  ]) {
    assert.equal(visible.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});

test('rejects accessor-based client authority instead of evaluating a TOCTOU getter', () => {
  const poisoned = {} as { readonly save: unknown };
  Object.defineProperty(poisoned, 'save', {
    enumerable: true,
    get() {
      throw new Error('getter must not run');
    },
  });
  assert.throws(
    () => providePreopenConfigurationChoices(poisoned as PreopenConfigurationChoicesAuthority),
    (error: unknown) =>
      error instanceof PreopenConfigurationChoicesError &&
      error.code ===
        PREOPEN_CONFIGURATION_CHOICES_ERROR_CODES.PREOPEN_CONFIGURATION_AUTHORITY_INVALID,
  );

  const nested = authority();
  Object.defineProperty(nested.save, 'expectedVersion', {
    enumerable: true,
    get() {
      throw new Error('nested getter must not run');
    },
  });
  assert.throws(() => providePreopenConfigurationChoices(nested));
});

test('fails closed outside CONFIGURE_REQUIRED and requires EMPTY equipment installation', () => {
  assert.throws(
    () =>
      providePreopenConfigurationChoices(
        authority({ phase: 'OPEN_REQUIRED' as 'CONFIGURE_REQUIRED' }),
      ),
    (error: unknown) =>
      error instanceof PreopenConfigurationChoicesError &&
      error.code ===
        PREOPEN_CONFIGURATION_CHOICES_ERROR_CODES.PREOPEN_CONFIGURATION_AUTHORITY_INVALID,
  );
  assert.throws(
    () => providePreopenConfigurationChoices(authority({ scenario: 'EMPTY_PREMISES' })),
    (error: unknown) =>
      error instanceof PreopenConfigurationChoicesError &&
      error.code ===
        PREOPEN_CONFIGURATION_CHOICES_ERROR_CODES.PREOPEN_EQUIPMENT_INSTALLATION_REQUIRED,
  );
});
