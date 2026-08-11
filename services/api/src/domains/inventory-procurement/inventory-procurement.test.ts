import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCatalogContract,
  calculateConversionRateBps,
  calculateRecipeBasePrice,
  calculateRecipeReferenceCost,
  calculateSalePrice,
  createMenuSelection,
  selectDeterministicConversions,
  type CatalogSubstitution,
  type IngredientCatalogItem,
  type RecipeVersion,
} from './catalog-menu.js';
import {
  assertCapacitySupportsNormalDemand,
  assertCanonicalStorageCapacityCatalog,
  assertInventoryCostPoolInvariant,
  assertServiceRepairDoesNotChangeStorageCapacity,
  assertStorageReadyForOpenDay,
  calculateMinimumPoolCapacity,
  completeReservedOrder,
  createEmptyInventory,
  createOpeningInventory,
  createStorageBundleSnapshot,
  deriveCanonicalStorageCapacity,
  receiveInventory,
  reserveRecipeIngredients,
  wastePerishableAtDayEnd,
  STORAGE_CAPACITY_CATALOG,
} from './inventory.js';
import { createInventoryProcurementOpeningSnapshot } from './opening-snapshot.js';
import {
  createMarketSnapshot,
  processContractDeliveries,
  purchaseSpotInventory,
  signSupplierContract,
  terminateSupplierContract,
  type SupplierContract,
} from './procurement.js';
import { createMoney } from '../money/money.js';

const ingredientCatalog: readonly IngredientCatalogItem[] = Object.freeze([
  {
    id: 'rice',
    revision: 'ingredients-v1',
    kind: 'COMMON',
    pool: 'DURABLE',
    referenceUnitPrice: createMoney('TWD', '30'),
    unlockedThemeIds: ['bistro'],
  },
  {
    id: 'sauce',
    revision: 'ingredients-v1',
    kind: 'COMMON',
    pool: 'DURABLE',
    referenceUnitPrice: createMoney('TWD', '10'),
    unlockedThemeIds: ['bistro'],
  },
  {
    id: 'chicken',
    revision: 'ingredients-v1',
    kind: 'COMMON',
    pool: 'PERISHABLE',
    referenceUnitPrice: createMoney('TWD', '50'),
    unlockedThemeIds: ['bistro'],
  },
  {
    id: 'greens',
    revision: 'ingredients-v1',
    kind: 'COMMON',
    pool: 'PERISHABLE',
    referenceUnitPrice: createMoney('TWD', '20'),
    unlockedThemeIds: ['bistro'],
  },
  {
    id: 'herbs',
    revision: 'ingredients-v1',
    kind: 'COMMON',
    pool: 'PERISHABLE',
    referenceUnitPrice: createMoney('TWD', '15'),
    unlockedThemeIds: ['bistro'],
  },
  {
    id: 'truffle',
    revision: 'ingredients-v1',
    kind: 'RARE',
    pool: 'DURABLE',
    referenceUnitPrice: createMoney('TWD', '100'),
    unlockedThemeIds: ['bistro'],
  },
]);

const recipeCatalog: readonly RecipeVersion[] = Object.freeze(
  Array.from({ length: 6 }, (_, index) => ({
    id: `recipe-${index + 1}-v1`,
    recipeId: `recipe-${index + 1}`,
    version: 1,
    catalogRevision: 'recipes-v1',
    themeId: 'bistro',
    baseQuality: 80 + index,
    ingredients:
      index === 4
        ? [
            { ingredientId: 'chicken', quantityPoints: 1 },
            { ingredientId: 'greens', quantityPoints: 1 },
            { ingredientId: 'herbs', quantityPoints: 1 },
          ]
        : index === 5
          ? [
              { ingredientId: 'rice', quantityPoints: 1 },
              { ingredientId: 'sauce', quantityPoints: 1 },
              { ingredientId: 'truffle', quantityPoints: 1 },
            ]
          : [
              { ingredientId: 'rice', quantityPoints: 1 },
              { ingredientId: 'sauce', quantityPoints: 1 },
              { ingredientId: 'chicken', quantityPoints: 1 },
            ],
  })),
);

const substitutionCatalog: readonly CatalogSubstitution[] = Object.freeze([
  {
    id: 'recipe-1-greens',
    catalogRevision: 'substitutions-v1',
    recipeVersionId: 'recipe-1-v1',
    priority: 10,
    qualityDelta: -5,
    ingredients: [
      { ingredientId: 'rice', quantityPoints: 1 },
      { ingredientId: 'sauce', quantityPoints: 1 },
      { ingredientId: 'greens', quantityPoints: 1 },
    ],
  },
]);

function makeMenu(businessDay = 1) {
  return createMenuSelection({
    businessDay,
    phase: 'PRE_OPEN',
    difficulty: 'STANDARD',
    themeId: 'bistro',
    recipeVersionIds: ['recipe-1-v1', 'recipe-2-v1', 'recipe-3-v1'],
    priceModifierPercentByRecipe: {
      'recipe-1-v1': -10,
      'recipe-2-v1': 0,
      'recipe-3-v1': 10,
    },
    enabledSubstitutionIds: ['recipe-1-greens'],
    recipeCatalog,
    ingredientCatalog,
    substitutionCatalog,
  });
}

function makeMarket(businessDay: number) {
  return createMarketSnapshot({
    saveId: 'save-1',
    businessDay,
    marketSeed: 'fixed-market-seed',
    catalogRevision: 'ingredients-v1',
    simulationRuleVersion: 'sim-v1',
    ingredientCatalog,
  });
}

test('controlled recipe catalog and difficulty menu sizes enforce the locked first-day contract', () => {
  assert.doesNotThrow(() =>
    assertCatalogContract(recipeCatalog, ingredientCatalog, substitutionCatalog),
  );
  const menu = makeMenu();
  assert.equal(menu.items.length, 3);
  assert.equal(menu.difficulty, 'STANDARD');
  assert.deepEqual(menu.items[0]?.enabledSubstitutionIds, ['recipe-1-greens']);
  assert.ok(Object.isFrozen(menu));

  assert.throws(
    () =>
      createMenuSelection({
        businessDay: 1,
        phase: 'PRE_OPEN',
        difficulty: 'GUIDED',
        themeId: 'bistro',
        recipeVersionIds: ['recipe-1-v1', 'recipe-2-v1'],
        priceModifierPercentByRecipe: { 'recipe-1-v1': 0, 'recipe-2-v1': 0 },
        enabledSubstitutionIds: [],
        recipeCatalog,
        ingredientCatalog,
        substitutionCatalog,
      }),
    /first business day must use the standard/,
  );
});

test('base price is reference ingredient cost divided by 30% with half-up minor-unit rounding', () => {
  const referenceCost = calculateRecipeReferenceCost(recipeCatalog[0]!, ingredientCatalog);
  assert.equal(referenceCost.minorUnits, '90');
  assert.equal(calculateRecipeBasePrice(referenceCost).minorUnits, '300');
  assert.equal(calculateRecipeBasePrice(createMoney('TWD', '100')).minorUnits, '333');
  assert.equal(calculateSalePrice(createMoney('TWD', '105'), 10).minorUnits, '116');
  assert.throws(() => calculateSalePrice(createMoney('TWD', '100'), 11), /-10 through 10/);
});

test('cohort elasticity and seeded conversion are deterministic and first-day bounded to ±10%', () => {
  assert.equal(calculateConversionRateBps('PRICE_SENSITIVE', 10), 8500);
  assert.equal(calculateConversionRateBps('TIME_SENSITIVE', 10), 9500);
  assert.equal(calculateConversionRateBps('EXPERIENCE_ORIENTED', 10), 9000);
  assert.equal(calculateConversionRateBps('PRICE_SENSITIVE', -10), 11500);
  const candidates = Array.from({ length: 12 }, (_, index) => `candidate-${index + 1}`);
  const reducedSelection = selectDeterministicConversions({
    demandSeed: 'demand-seed',
    businessDay: 1,
    candidateIds: candidates,
    baselineCandidateCount: 10,
    cohort: 'PRICE_SENSITIVE',
    priceModifierPercent: 10,
  });
  assert.equal(reducedSelection.rateBps, 9000);
  assert.equal(reducedSelection.targetCount, 9);
  const selection = selectDeterministicConversions({
    demandSeed: 'demand-seed',
    businessDay: 1,
    candidateIds: candidates,
    baselineCandidateCount: 10,
    cohort: 'PRICE_SENSITIVE',
    priceModifierPercent: -10,
  });
  assert.equal(selection.rateBps, 11000);
  assert.equal(selection.targetCount, 11);
  assert.deepEqual(
    selection,
    selectDeterministicConversions({
      demandSeed: 'demand-seed',
      businessDay: 1,
      candidateIds: candidates,
      baselineCandidateCount: 10,
      cohort: 'PRICE_SENSITIVE',
      priceModifierPercent: -10,
    }),
  );
});

test('capacity contract derives normal-demand upper plus 20% without inventing scenario constants', () => {
  const minimum = calculateMinimumPoolCapacity(10, recipeCatalog, ingredientCatalog);
  assert.deepEqual(minimum, { DURABLE: 36, PERISHABLE: 36 });
  assert.doesNotThrow(() =>
    assertCapacitySupportsNormalDemand({
      capacity: minimum,
      normalDemandUpperPortions: 10,
      recipes: recipeCatalog,
      ingredientCatalog,
    }),
  );
  assert.throws(
    () =>
      assertCapacitySupportsNormalDemand({
        capacity: { DURABLE: 35, PERISHABLE: 36 },
        normalDemandUpperPortions: 10,
        recipes: recipeCatalog,
        ingredientCatalog,
      }),
    /normal demand upper plus 20%/,
  );
  const opening = createEmptyInventory('TWD', minimum);
  assert.deepEqual(opening.stocks, []);
});

test('canonical scenario capacities reproduce the locked E-02 upper-bound derivation exactly', () => {
  assert.doesNotThrow(assertCanonicalStorageCapacityCatalog);
  assert.deepEqual(STORAGE_CAPACITY_CATALOG, {
    EMPTY_PREMISES: { DURABLE: 280, PERISHABLE: 280 },
    DEFAULT_SMALL_SHOP: { DURABLE: 305, PERISHABLE: 305 },
    TROUBLED_SHOP: { DURABLE: 255, PERISHABLE: 255 },
  });
  assert.deepEqual(deriveCanonicalStorageCapacity('EMPTY_PREMISES'), {
    scenario: 'EMPTY_PREMISES',
    twoPeriodGroupUpper: 27,
    threePeriodGroupUpper: 34,
    capacityValidationPeople: 77,
    rawCapacityPoints: 278,
    roundedCapacityPoints: 280,
  });
  assert.deepEqual(deriveCanonicalStorageCapacity('DEFAULT_SMALL_SHOP'), {
    scenario: 'DEFAULT_SMALL_SHOP',
    twoPeriodGroupUpper: 30,
    threePeriodGroupUpper: 37,
    capacityValidationPeople: 84,
    rawCapacityPoints: 303,
    roundedCapacityPoints: 305,
  });
  assert.deepEqual(deriveCanonicalStorageCapacity('TROUBLED_SHOP'), {
    scenario: 'TROUBLED_SHOP',
    twoPeriodGroupUpper: 25,
    threePeriodGroupUpper: 31,
    capacityValidationPeople: 70,
    rawCapacityPoints: 252,
    roundedCapacityPoints: 255,
  });
});

test('empty premises rejects OpenDay before BASIC install and service repair cannot alter storage', () => {
  const uninstalled = createStorageBundleSnapshot('EMPTY_PREMISES', {
    version: 'storage-v1',
    kind: 'NONE',
  });
  assert.deepEqual(uninstalled.capacity, { DURABLE: 0, PERISHABLE: 0 });
  assert.throws(() => assertStorageReadyForOpenDay(uninstalled), /OpenDay requires/);
  assert.deepEqual(createOpeningInventory('EMPTY_PREMISES', uninstalled, 'TWD').stocks, []);

  const basic = createStorageBundleSnapshot('EMPTY_PREMISES', {
    version: 'storage-v1',
    kind: 'BASIC',
  });
  assert.doesNotThrow(() => assertStorageReadyForOpenDay(basic));
  assert.deepEqual(basic.capacity, { DURABLE: 280, PERISHABLE: 280 });
  assert.doesNotThrow(() => assertServiceRepairDoesNotChangeStorageCapacity(basic, basic));
  assert.throws(
    () =>
      assertServiceRepairDoesNotChangeStorageCapacity(basic, {
        ...basic,
        capacity: { DURABLE: 285, PERISHABLE: 280 },
      }),
    /service repair cannot change/,
  );

  const aged = createStorageBundleSnapshot('TROUBLED_SHOP', {
    version: 'storage-v1',
    kind: 'AGED',
  });
  assert.deepEqual(aged.capacity, { DURABLE: 255, PERISHABLE: 255 });
});

test('reservation is atomic, uses catalog substitution priority, and consumes only on completion', () => {
  let inventory = createEmptyInventory('TWD', { DURABLE: 100, PERISHABLE: 100 });
  for (const [ingredientId, quantityPoints, totalCost] of [
    ['rice', 2, '20'],
    ['sauce', 2, '10'],
    ['greens', 1, '9'],
  ] as const) {
    inventory = receiveInventory(inventory, ingredientCatalog, {
      transactionId: `receive-${ingredientId}`,
      referenceId: 'purchase-1',
      ingredientId,
      quantityPoints,
      totalCost: createMoney('TWD', totalCost),
    });
  }
  const result = reserveRecipeIngredients(inventory, {
    transactionId: 'reserve-1',
    orderId: 'order-1',
    servings: 1,
    recipe: recipeCatalog[0]!,
    enabledSubstitutions: substitutionCatalog,
  });
  assert.equal(result.status, 'RESERVED');
  if (result.status !== 'RESERVED') return;
  assert.equal(result.reservation.substitutionId, 'recipe-1-greens');
  assert.equal(
    result.inventory.stocks.find((stock) => stock.ingredientId === 'greens')?.onHandPoints,
    1,
  );
  assert.equal(
    result.inventory.stocks.find((stock) => stock.ingredientId === 'greens')?.reservedPoints,
    1,
  );
  const completed = completeReservedOrder(result.inventory, 'consume-1', 'order-1');
  assert.equal(completed.cogs.minorUnits, '24');
  assert.equal(
    completed.inventory.stocks.find((stock) => stock.ingredientId === 'greens')?.onHandPoints,
    0,
  );
  assertInventoryCostPoolInvariant(completed.inventory);

  const soldOut = reserveRecipeIngredients(completed.inventory, {
    transactionId: 'reserve-2',
    orderId: 'order-2',
    servings: 1,
    recipe: recipeCatalog[0]!,
    enabledSubstitutions: substitutionCatalog,
  });
  assert.equal(soldOut.status, 'SOLD_OUT');
  assert.strictEqual(soldOut.inventory, completed.inventory);
});

test('one main dish per patron multiplies every atomic ingredient reservation by servings', () => {
  let inventory = createEmptyInventory('TWD', { DURABLE: 100, PERISHABLE: 100 });
  for (const ingredient of recipeCatalog[0]!.ingredients) {
    inventory = receiveInventory(inventory, ingredientCatalog, {
      transactionId: `group-receipt-${ingredient.ingredientId}`,
      referenceId: 'group-purchase',
      ingredientId: ingredient.ingredientId,
      quantityPoints: 4,
      totalCost: createMoney('TWD', '40'),
    });
  }
  const reserved = reserveRecipeIngredients(inventory, {
    transactionId: 'group-reserve',
    orderId: 'group-order',
    servings: 4,
    recipe: recipeCatalog[0]!,
    enabledSubstitutions: [],
  });
  assert.equal(reserved.status, 'RESERVED');
  if (reserved.status !== 'RESERVED') return;
  assert.equal(reserved.reservation.servings, 4);
  assert.ok(
    reserved.reservation.ingredients.every((ingredient) => ingredient.quantityPoints === 4),
  );
  const completed = completeReservedOrder(reserved.inventory, 'group-consume', 'group-order');
  assert.equal(completed.cogs.minorUnits, '120');
  assert.ok(completed.inventory.stocks.every((stock) => stock.onHandPoints === 0));
});

test('moving weighted cost allocation preserves residual and perishable day-end waste', () => {
  let inventory = createEmptyInventory('TWD', { DURABLE: 100, PERISHABLE: 100 });
  inventory = receiveInventory(inventory, ingredientCatalog, {
    transactionId: 'rice-a',
    referenceId: 'spot-a',
    ingredientId: 'rice',
    quantityPoints: 3,
    totalCost: createMoney('TWD', '10'),
  });
  inventory = receiveInventory(inventory, ingredientCatalog, {
    transactionId: 'rice-b',
    referenceId: 'spot-b',
    ingredientId: 'rice',
    quantityPoints: 2,
    totalCost: createMoney('TWD', '11'),
  });
  inventory = receiveInventory(inventory, ingredientCatalog, {
    transactionId: 'greens-a',
    referenceId: 'spot-c',
    ingredientId: 'greens',
    quantityPoints: 2,
    totalCost: createMoney('TWD', '9'),
  });
  const rice = inventory.stocks.find((stock) => stock.ingredientId === 'rice')!;
  assert.equal(rice.onHandPoints, 5);
  assert.equal(rice.costPool.minorUnits, '21');

  const wasted = wastePerishableAtDayEnd(inventory, 'waste-day-1', 1);
  assert.equal(wasted.wasteExpense.minorUnits, '9');
  assert.equal(
    wasted.inventory.stocks.find((stock) => stock.ingredientId === 'greens')?.onHandPoints,
    0,
  );
  assert.equal(
    wasted.inventory.stocks.find((stock) => stock.ingredientId === 'rice')?.costPool.minorUnits,
    '21',
  );
  assertInventoryCostPoolInvariant(wasted.inventory);
});

test('the final consumed quantities absorb every moving-average rounding residual', () => {
  let inventory = createEmptyInventory('TWD', { DURABLE: 100, PERISHABLE: 100 });
  for (const [ingredientId, totalCost] of [
    ['rice', '21'],
    ['sauce', '11'],
    ['chicken', '13'],
  ] as const) {
    inventory = receiveInventory(inventory, ingredientCatalog, {
      transactionId: `residual-receipt-${ingredientId}`,
      referenceId: 'residual-purchase',
      ingredientId,
      quantityPoints: 5,
      totalCost: createMoney('TWD', totalCost),
    });
  }
  let totalCogs = 0n;
  for (let index = 1; index <= 5; index += 1) {
    const reserved = reserveRecipeIngredients(inventory, {
      transactionId: `residual-reserve-${index}`,
      orderId: `residual-order-${index}`,
      servings: 1,
      recipe: recipeCatalog[0]!,
      enabledSubstitutions: [],
    });
    assert.equal(reserved.status, 'RESERVED');
    if (reserved.status !== 'RESERVED') return;
    const completed = completeReservedOrder(
      reserved.inventory,
      `residual-consume-${index}`,
      `residual-order-${index}`,
    );
    totalCogs += BigInt(completed.cogs.minorUnits);
    inventory = completed.inventory;
  }
  assert.equal(totalCogs, 45n);
  assert.ok(
    inventory.stocks.every(
      (stock) => stock.onHandPoints === 0 && stock.costPool.minorUnits === '0',
    ),
  );
  assertInventoryCostPoolInvariant(inventory);
});

test('market day one uses reference prices and later quotes are seeded, bounded, and replayable', () => {
  const firstDay = makeMarket(1);
  assert.ok(firstDay.quotes.every((quote) => quote.priceModifierBps === 0));
  assert.ok(
    firstDay.quotes.every(
      (quote) => quote.unitPrice.minorUnits === quote.referenceUnitPrice.minorUnits,
    ),
  );
  const dayTwo = makeMarket(2);
  assert.deepEqual(dayTwo, makeMarket(2));
  assert.ok(
    dayTwo.quotes.every(
      (quote) => quote.priceModifierBps >= -1000 && quote.priceModifierBps <= 1000,
    ),
  );
  assert.equal(dayTwo.tickIdentity, 'save-1:2:SUPPLY_PRICE');
});

test('spot procurement is cash-to-inventory and emits only an E-05 input on payment shortfall', () => {
  const inventory = createEmptyInventory('TWD', { DURABLE: 100, PERISHABLE: 100 });
  const purchased = purchaseSpotInventory(inventory, ingredientCatalog, {
    transactionId: 'spot-tx-1',
    purchaseId: 'spot-1',
    businessDay: 1,
    phase: 'BEFORE_OPENING_AFTER_CONTRACTS',
    themeId: 'bistro',
    ingredientId: 'rice',
    quantityPoints: 5,
    cashAvailable: createMoney('TWD', '200'),
    marketSnapshot: makeMarket(1),
  });
  assert.equal(purchased.status, 'PURCHASED');
  if (purchased.status !== 'PURCHASED') return;
  assert.equal(purchased.payment.minorUnits, '150');
  assert.equal(purchased.remainingCash.minorUnits, '50');
  assert.equal(purchased.inventory.stocks[0]?.onHandPoints, 5);

  const shortfall = purchaseSpotInventory(inventory, ingredientCatalog, {
    transactionId: 'spot-tx-2',
    purchaseId: 'spot-2',
    businessDay: 1,
    phase: 'BEFORE_OPENING_AFTER_CONTRACTS',
    themeId: 'bistro',
    ingredientId: 'rice',
    quantityPoints: 5,
    cashAvailable: createMoney('TWD', '149'),
    marketSnapshot: makeMarket(1),
  });
  assert.equal(shortfall.status, 'PAYMENT_SHORTFALL');
  if (shortfall.status !== 'PAYMENT_SHORTFALL') return;
  assert.strictEqual(shortfall.inventory, inventory);
  assert.equal(shortfall.e05Input.shortfallMinorUnits, '1');
});

test('take-or-pay reserves all future capacity, delivers before opening, and limits active contracts', () => {
  const openingInventory = createEmptyInventory('TWD', { DURABLE: 100, PERISHABLE: 100 });
  const first = signSupplierContract(openingInventory, [], ingredientCatalog, {
    transactionId: 'contract-reserve-1',
    contractId: 'contract-1',
    signedAfterCompletedBusinessDay: 1,
    phase: 'BETWEEN_BUSINESS_DAYS',
    themeId: 'bistro',
    ingredientId: 'rice',
    dailyQuantityPoints: 5,
    signingDayMarketSnapshot: makeMarket(1),
  });
  assert.equal(first.contract.termCompletedBusinessDays, 3);
  assert.equal(first.inventory.reservedUndelivered[0]?.quantityPoints, 15);
  const second = signSupplierContract(first.inventory, first.contracts, ingredientCatalog, {
    transactionId: 'contract-reserve-2',
    contractId: 'contract-2',
    signedAfterCompletedBusinessDay: 1,
    phase: 'BETWEEN_BUSINESS_DAYS',
    themeId: 'bistro',
    ingredientId: 'sauce',
    dailyQuantityPoints: 5,
    signingDayMarketSnapshot: makeMarket(1),
  });
  assert.throws(
    () =>
      signSupplierContract(second.inventory, second.contracts, ingredientCatalog, {
        transactionId: 'contract-reserve-3',
        contractId: 'contract-3',
        signedAfterCompletedBusinessDay: 1,
        phase: 'BETWEEN_BUSINESS_DAYS',
        themeId: 'bistro',
        ingredientId: 'chicken',
        dailyQuantityPoints: 5,
        signingDayMarketSnapshot: makeMarket(1),
      }),
    /at most two active/,
  );

  const delivered = processContractDeliveries(first.inventory, first.contracts, ingredientCatalog, {
    transactionId: 'delivery-day-2',
    businessDay: 2,
    phase: 'BEFORE_OPENING',
    cashAvailable: createMoney('TWD', '200'),
  });
  assert.equal(delivered.status, 'DELIVERED_PAID');
  if (delivered.status !== 'DELIVERED_PAID') return;
  assert.equal(delivered.payment.minorUnits, '150');
  assert.equal(delivered.inventory.stocks[0]?.onHandPoints, 5);
  assert.equal(delivered.inventory.reservedUndelivered[0]?.quantityPoints, 10);
  assert.equal(
    (delivered.inventory.stocks[0]?.onHandPoints ?? 0) +
      (delivered.inventory.reservedUndelivered[0]?.quantityPoints ?? 0),
    15,
  );
  assert.equal(delivered.contracts[0]?.obligations[0]?.status, 'DELIVERED_PAID');
});

test('each pool allows exact occupancy and rejects spot procurement one point above capacity', () => {
  const exactInventory = createEmptyInventory('TWD', { DURABLE: 15, PERISHABLE: 15 });
  const signed = signSupplierContract(exactInventory, [], ingredientCatalog, {
    transactionId: 'exact-capacity-contract',
    contractId: 'exact-contract',
    signedAfterCompletedBusinessDay: 1,
    phase: 'BETWEEN_BUSINESS_DAYS',
    themeId: 'bistro',
    ingredientId: 'rice',
    dailyQuantityPoints: 5,
    signingDayMarketSnapshot: makeMarket(1),
  });
  assert.equal(signed.inventory.reservedUndelivered[0]?.quantityPoints, 15);
  assert.throws(
    () =>
      purchaseSpotInventory(signed.inventory, ingredientCatalog, {
        transactionId: 'one-over-capacity',
        purchaseId: 'one-over-capacity',
        businessDay: 1,
        phase: 'BEFORE_OPENING_AFTER_CONTRACTS',
        themeId: 'bistro',
        ingredientId: 'rice',
        quantityPoints: 1,
        cashAvailable: createMoney('TWD', '1000'),
        marketSnapshot: makeMarket(1),
      }),
    /exceeds capacity/,
  );
  assert.equal(signed.inventory.stocks.length, 0);
  assert.equal(signed.inventory.reservedUndelivered[0]?.quantityPoints, 15);
});

test('contract payment shortfall is atomic and early termination charges 25% of remaining value', () => {
  const openingInventory = createEmptyInventory('TWD', { DURABLE: 100, PERISHABLE: 100 });
  const signed = signSupplierContract(openingInventory, [], ingredientCatalog, {
    transactionId: 'reserve-contract',
    contractId: 'contract-1',
    signedAfterCompletedBusinessDay: 1,
    phase: 'BETWEEN_BUSINESS_DAYS',
    themeId: 'bistro',
    ingredientId: 'rice',
    dailyQuantityPoints: 5,
    signingDayMarketSnapshot: makeMarket(1),
  });
  const shortfall = processContractDeliveries(
    signed.inventory,
    signed.contracts,
    ingredientCatalog,
    {
      transactionId: 'delivery-failed',
      businessDay: 2,
      phase: 'BEFORE_OPENING',
      cashAvailable: createMoney('TWD', '149'),
    },
  );
  assert.equal(shortfall.status, 'PAYMENT_SHORTFALL');
  if (shortfall.status !== 'PAYMENT_SHORTFALL') return;
  assert.strictEqual(shortfall.inventory, signed.inventory);
  assert.strictEqual(shortfall.contracts, signed.contracts);
  assert.equal(shortfall.e05Input.source, 'CONTRACT_DELIVERY');
  assert.throws(
    () =>
      processContractDeliveries(signed.inventory, signed.contracts, ingredientCatalog, {
        transactionId: 'skip-unpaid-day',
        businessDay: 3,
        phase: 'BEFORE_OPENING',
        cashAvailable: createMoney('TWD', '1000'),
      }),
    /overdue contract obligation requires E-05/,
  );
  assert.throws(
    () =>
      terminateSupplierContract(signed.inventory, signed.contracts, {
        transactionId: 'terminate-with-unpaid-due',
        contractId: 'contract-1',
        afterCompletedBusinessDay: 2,
        phase: 'BETWEEN_BUSINESS_DAYS',
        cashAvailable: createMoney('TWD', '1000'),
      }),
    /due contract obligations require E-05/,
  );

  const delivered = processContractDeliveries(
    signed.inventory,
    signed.contracts,
    ingredientCatalog,
    {
      transactionId: 'delivery-paid',
      businessDay: 2,
      phase: 'BEFORE_OPENING',
      cashAvailable: createMoney('TWD', '1000'),
    },
  );
  assert.equal(delivered.status, 'DELIVERED_PAID');
  if (delivered.status !== 'DELIVERED_PAID') return;
  const terminated = terminateSupplierContract(delivered.inventory, delivered.contracts, {
    transactionId: 'terminate-contract',
    contractId: 'contract-1',
    afterCompletedBusinessDay: 2,
    phase: 'BETWEEN_BUSINESS_DAYS',
    cashAvailable: createMoney('TWD', '100'),
  });
  assert.equal(terminated.status, 'TERMINATED');
  if (terminated.status !== 'TERMINATED') return;
  assert.equal(terminated.terminationFee.minorUnits, '75');
  assert.equal(terminated.inventory.reservedUndelivered.length, 0);
  assert.equal(terminated.contracts[0]?.status, 'TERMINATED');
});

test('opening snapshot freezes replay-critical menu, market, inventory cost pools, and obligations', () => {
  const inventory = createEmptyInventory('TWD', { DURABLE: 36, PERISHABLE: 12 });
  const payload = {
    snapshotSchemaVersion: 'e03-opening-v1',
    simulationRuleVersion: 'sim-v1',
    catalogRevisions: {
      ingredientCatalog: 'ingredients-v1',
      recipeCatalog: 'recipes-v1',
      substitutionCatalog: 'substitutions-v1',
    },
    servicePeriodPlan: 'TWO_PERIOD' as const,
    operatingMode: 'STRATEGY' as const,
    menu: makeMenu(),
    market: makeMarket(1),
    capacity: inventory.capacity,
    openingStocks: inventory.stocks,
    openingReservations: inventory.orderReservations,
    outstandingContracts: [] as readonly SupplierContract[],
    reservedUndelivered: inventory.reservedUndelivered,
  };
  const snapshot = createInventoryProcurementOpeningSnapshot(payload);
  assert.equal(snapshot.snapshotHash.length, 64);
  assert.equal(
    snapshot.snapshotHash,
    createInventoryProcurementOpeningSnapshot(payload).snapshotHash,
  );
  assert.ok(Object.isFrozen(snapshot.menu.items));

  const signed = signSupplierContract(inventory, [], ingredientCatalog, {
    transactionId: 'snapshot-contract-reservation',
    contractId: 'snapshot-contract',
    signedAfterCompletedBusinessDay: 1,
    phase: 'BETWEEN_BUSINESS_DAYS',
    themeId: 'bistro',
    ingredientId: 'rice',
    dailyQuantityPoints: 5,
    signingDayMarketSnapshot: makeMarket(1),
  });
  const withContract = createInventoryProcurementOpeningSnapshot({
    ...payload,
    menu: makeMenu(2),
    market: makeMarket(2),
    openingStocks: signed.inventory.stocks,
    outstandingContracts: signed.contracts,
    reservedUndelivered: signed.inventory.reservedUndelivered,
  });
  assert.equal(withContract.outstandingContracts[0]?.obligations.length, 3);
  assert.equal(withContract.reservedUndelivered[0]?.quantityPoints, 15);
});
