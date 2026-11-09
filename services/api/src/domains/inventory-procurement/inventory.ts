import type {
  CatalogSubstitution,
  IngredientCatalogItem,
  InventoryPool,
  RecipeIngredient,
  RecipeVersion,
} from './catalog-menu.js';
import {
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
  assertSameCurrency,
  compareStableKey,
  deepFreeze,
  moneyFromMinorUnits,
  moneyMinorUnits,
  roundHalfUpRatio,
} from './shared.js';
import type { Money } from '../money/money.js';
import type { OpeningScenario } from '../opening-scenario/catalog.js';

export type InventoryCapacity = Readonly<Record<InventoryPool, number>>;

export const STORAGE_CAPACITY_CATALOG: Readonly<Record<OpeningScenario, InventoryCapacity>> =
  deepFreeze({
    EMPTY_PREMISES: { DURABLE: 280, PERISHABLE: 280 },
    DEFAULT_SMALL_SHOP: { DURABLE: 305, PERISHABLE: 305 },
    TROUBLED_SHOP: { DURABLE: 255, PERISHABLE: 255 },
  });

const CAPACITY_DERIVATION: Readonly<
  Record<
    OpeningScenario,
    Readonly<{
      baseGroups: Readonly<{ TWO_PERIOD: number; THREE_PERIOD: number }>;
      forecastErrorBps: number;
    }>
  >
> = deepFreeze({
  EMPTY_PREMISES: {
    baseGroups: { TWO_PERIOD: 20, THREE_PERIOD: 25 },
    forecastErrorBps: 1500,
  },
  DEFAULT_SMALL_SHOP: {
    baseGroups: { TWO_PERIOD: 24, THREE_PERIOD: 30 },
    forecastErrorBps: 500,
  },
  TROUBLED_SHOP: {
    baseGroups: { TWO_PERIOD: 19, THREE_PERIOD: 24 },
    forecastErrorBps: 1000,
  },
});

export type StorageCapacityDerivation = Readonly<{
  scenario: OpeningScenario;
  twoPeriodGroupUpper: number;
  threePeriodGroupUpper: number;
  capacityValidationPeople: number;
  rawCapacityPoints: number;
  roundedCapacityPoints: number;
}>;

function ceilRatio(numerator: bigint, denominator: bigint): number {
  return Number((numerator + denominator - 1n) / denominator);
}

function roundUpToFive(value: number): number {
  return Math.ceil(value / 5) * 5;
}

export function deriveCanonicalStorageCapacity(
  scenario: OpeningScenario,
): StorageCapacityDerivation {
  const definition = CAPACITY_DERIVATION[scenario];
  const groupUpper = (baseGroups: number) =>
    ceilRatio(
      BigInt(baseGroups) * BigInt(10_000 + definition.forecastErrorBps) * 10_500n * 11_000n,
      10_000n ** 3n,
    );
  const twoPeriodGroupUpper = groupUpper(definition.baseGroups.TWO_PERIOD);
  const threePeriodGroupUpper = groupUpper(definition.baseGroups.THREE_PERIOD);
  const capacityValidationPeople = ceilRatio(BigInt(threePeriodGroupUpper) * 225n, 100n);
  const rawCapacityPoints = ceilRatio(BigInt(capacityValidationPeople) * 3n * 120n, 100n);
  return deepFreeze({
    scenario,
    twoPeriodGroupUpper,
    threePeriodGroupUpper,
    capacityValidationPeople,
    rawCapacityPoints,
    roundedCapacityPoints: roundUpToFive(rawCapacityPoints),
  });
}

export type StorageBundleSnapshot = Readonly<{
  version: string;
  kind: 'NONE' | 'BASIC' | 'AGED' | 'VERSIONED_UPGRADE';
  capacity: InventoryCapacity;
}>;

export function createStorageBundleSnapshot(
  scenario: OpeningScenario,
  input: Readonly<{
    version: string;
    kind: StorageBundleSnapshot['kind'];
    upgradedCapacity?: InventoryCapacity;
  }>,
): StorageBundleSnapshot {
  if (!input.version) throw new Error('storage bundle snapshot requires a version');
  if (scenario === 'EMPTY_PREMISES' && input.kind === 'NONE') {
    if (input.upgradedCapacity !== undefined) {
      throw new Error('uninstalled storage cannot declare upgraded capacity');
    }
    return deepFreeze({
      version: input.version,
      kind: 'NONE',
      capacity: { DURABLE: 0, PERISHABLE: 0 },
    });
  }
  if (input.kind === 'VERSIONED_UPGRADE') {
    if (!input.upgradedCapacity) throw new Error('versioned upgrade requires explicit capacity');
    for (const pool of ['DURABLE', 'PERISHABLE'] as const) {
      assertPositiveSafeInteger(input.upgradedCapacity[pool], `${pool} upgraded capacity`);
      if (input.upgradedCapacity[pool] % 5 !== 0) {
        throw new Error('versioned storage upgrade capacity must use five-point steps');
      }
    }
    return deepFreeze({
      version: input.version,
      kind: input.kind,
      capacity: { ...input.upgradedCapacity },
    });
  }
  const requiredKind = scenario === 'TROUBLED_SHOP' ? 'AGED' : 'BASIC';
  if (input.kind !== requiredKind || input.upgradedCapacity !== undefined) {
    throw new Error('opening storage bundle kind must match the canonical scenario entitlement');
  }
  return deepFreeze({
    version: input.version,
    kind: input.kind,
    capacity: { ...STORAGE_CAPACITY_CATALOG[scenario] },
  });
}

export function assertStorageReadyForOpenDay(bundle: StorageBundleSnapshot): void {
  if (bundle.kind === 'NONE' || bundle.capacity.DURABLE === 0 || bundle.capacity.PERISHABLE === 0) {
    throw new Error('OpenDay requires an installed storage bundle with both inventory pools');
  }
}

export function assertCanonicalStorageCapacityCatalog(): void {
  for (const scenario of ['EMPTY_PREMISES', 'DEFAULT_SMALL_SHOP', 'TROUBLED_SHOP'] as const) {
    const derived = deriveCanonicalStorageCapacity(scenario);
    const locked = STORAGE_CAPACITY_CATALOG[scenario];
    if (
      locked.DURABLE !== derived.roundedCapacityPoints ||
      locked.PERISHABLE !== derived.roundedCapacityPoints
    ) {
      throw new Error('storage capacity catalog does not match the canonical derivation');
    }
  }
}

export function assertServiceRepairDoesNotChangeStorageCapacity(
  before: StorageBundleSnapshot,
  after: StorageBundleSnapshot,
): void {
  if (
    before.version !== after.version ||
    before.kind !== after.kind ||
    before.capacity.DURABLE !== after.capacity.DURABLE ||
    before.capacity.PERISHABLE !== after.capacity.PERISHABLE
  ) {
    throw new Error('service repair cannot change the versioned storage bundle snapshot');
  }
}

export function createOpeningInventory(
  scenario: OpeningScenario,
  bundle: StorageBundleSnapshot,
  currency: string,
): InventoryState {
  if (bundle.kind !== 'VERSIONED_UPGRADE') {
    const expectedKind =
      scenario === 'EMPTY_PREMISES' && bundle.kind === 'NONE'
        ? 'NONE'
        : scenario === 'TROUBLED_SHOP'
          ? 'AGED'
          : 'BASIC';
    if (bundle.kind !== expectedKind) {
      throw new Error('opening inventory storage kind must match its scenario entitlement');
    }
    const expected =
      scenario === 'EMPTY_PREMISES' && bundle.kind === 'NONE'
        ? { DURABLE: 0, PERISHABLE: 0 }
        : STORAGE_CAPACITY_CATALOG[scenario];
    if (
      bundle.capacity.DURABLE !== expected.DURABLE ||
      bundle.capacity.PERISHABLE !== expected.PERISHABLE
    ) {
      throw new Error('opening inventory capacity must match its scenario storage entitlement');
    }
  }
  return createEmptyInventory(currency, bundle.capacity);
}

export type InventoryStock = Readonly<{
  ingredientId: string;
  pool: InventoryPool;
  onHandPoints: number;
  reservedPoints: number;
  costPool: Money;
}>;

export type IngredientReservation = Readonly<{
  ingredientId: string;
  quantityPoints: number;
}>;

export type OrderIngredientReservation = Readonly<{
  orderId: string;
  recipeVersionId: string;
  servings: number;
  substitutionId: string | null;
  qualityDelta: number;
  ingredients: readonly IngredientReservation[];
}>;

export type ReservedUndeliveredContractQuantity = Readonly<{
  contractId: string;
  ingredientId: string;
  pool: InventoryPool;
  quantityPoints: number;
}>;

export type InventoryTransactionType =
  | 'RECEIPT'
  | 'ORDER_RESERVED'
  | 'ORDER_COMPLETED'
  | 'PERISHABLE_WASTE'
  | 'FUTURE_CONTRACT_CAPACITY_RESERVED'
  | 'FUTURE_CONTRACT_CAPACITY_RELEASED';

export type InventoryTransaction = Readonly<{
  sequence: number;
  transactionId: string;
  type: InventoryTransactionType;
  ingredientId: string;
  quantityPoints: number;
  amount: Money;
  referenceId: string;
}>;

export type InventoryState = Readonly<{
  currency: string;
  capacity: InventoryCapacity;
  stocks: readonly InventoryStock[];
  orderReservations: readonly OrderIngredientReservation[];
  reservedUndelivered: readonly ReservedUndeliveredContractQuantity[];
  transactions: readonly InventoryTransaction[];
}>;

function findIngredient(
  catalog: readonly IngredientCatalogItem[],
  ingredientId: string,
): IngredientCatalogItem {
  const ingredient = catalog.find((entry) => entry.id === ingredientId);
  if (!ingredient) throw new Error('inventory mutation references an unknown ingredient');
  return ingredient;
}

function poolUsage(state: InventoryState, pool: InventoryPool): number {
  const physical = state.stocks
    .filter((stock) => stock.pool === pool)
    .reduce((sum, stock) => sum + stock.onHandPoints, 0);
  const future = state.reservedUndelivered
    .filter((reservation) => reservation.pool === pool)
    .reduce((sum, reservation) => sum + reservation.quantityPoints, 0);
  return physical + future;
}

function assertCapacity(state: InventoryState): void {
  for (const pool of ['DURABLE', 'PERISHABLE'] as const) {
    if (poolUsage(state, pool) > state.capacity[pool]) {
      throw new Error(`${pool} inventory plus undelivered contract quantity exceeds capacity`);
    }
  }
}

function appendTransactions(
  state: InventoryState,
  transactions: readonly Omit<InventoryTransaction, 'sequence'>[],
): readonly InventoryTransaction[] {
  return [
    ...state.transactions,
    ...transactions.map((transaction, index) => ({
      ...transaction,
      sequence: state.transactions.length + index + 1,
    })),
  ];
}

function assertMutationIdentityUnused(state: InventoryState, transactionId: string): void {
  if (!transactionId) throw new Error('inventory transaction id is required');
  if (state.transactions.some((transaction) => transaction.transactionId === transactionId)) {
    throw new Error('inventory transaction id has already been applied');
  }
}

function replaceStock(
  stocks: readonly InventoryStock[],
  next: InventoryStock,
): readonly InventoryStock[] {
  return [...stocks.filter((stock) => stock.ingredientId !== next.ingredientId), next].sort(
    (left, right) => compareStableKey(left.ingredientId, right.ingredientId),
  );
}

export function createEmptyInventory(
  currency: string,
  capacity: InventoryCapacity,
): InventoryState {
  moneyFromMinorUnits(currency, 0n);
  assertNonNegativeSafeInteger(capacity.DURABLE, 'durable capacity');
  assertNonNegativeSafeInteger(capacity.PERISHABLE, 'perishable capacity');
  return deepFreeze({
    currency,
    capacity: { ...capacity },
    stocks: [],
    orderReservations: [],
    reservedUndelivered: [],
    transactions: [],
  });
}

export type CapacityContractInput = Readonly<{
  capacity: InventoryCapacity;
  normalDemandUpperPortions: number;
  recipes: readonly RecipeVersion[];
  ingredientCatalog: readonly IngredientCatalogItem[];
}>;

export function calculateMinimumPoolCapacity(
  normalDemandUpperPortions: number,
  recipes: readonly RecipeVersion[],
  ingredientCatalog: readonly IngredientCatalogItem[],
): InventoryCapacity {
  assertPositiveSafeInteger(normalDemandUpperPortions, 'normal demand upper portions');
  if (recipes.length === 0)
    throw new Error('capacity validation requires at least one legal recipe');
  const ingredientById = new Map(
    ingredientCatalog.map((ingredient) => [ingredient.id, ingredient]),
  );
  const maximumPerPortion: Record<InventoryPool, number> = { DURABLE: 0, PERISHABLE: 0 };
  for (const recipe of recipes) {
    const recipePoolPoints: Record<InventoryPool, number> = { DURABLE: 0, PERISHABLE: 0 };
    for (const requirement of recipe.ingredients) {
      assertPositiveSafeInteger(requirement.quantityPoints, 'capacity recipe ingredient quantity');
      const ingredient = ingredientById.get(requirement.ingredientId);
      if (!ingredient) throw new Error('capacity validation recipe references unknown ingredient');
      recipePoolPoints[ingredient.pool] += requirement.quantityPoints;
    }
    maximumPerPortion.DURABLE = Math.max(maximumPerPortion.DURABLE, recipePoolPoints.DURABLE);
    maximumPerPortion.PERISHABLE = Math.max(
      maximumPerPortion.PERISHABLE,
      recipePoolPoints.PERISHABLE,
    );
  }
  return deepFreeze({
    DURABLE: Math.ceil(maximumPerPortion.DURABLE * normalDemandUpperPortions * 1.2),
    PERISHABLE: Math.ceil(maximumPerPortion.PERISHABLE * normalDemandUpperPortions * 1.2),
  });
}

export function assertCapacitySupportsNormalDemand(input: CapacityContractInput): void {
  const minimum = calculateMinimumPoolCapacity(
    input.normalDemandUpperPortions,
    input.recipes,
    input.ingredientCatalog,
  );
  if (input.capacity.DURABLE < minimum.DURABLE || input.capacity.PERISHABLE < minimum.PERISHABLE) {
    throw new Error(
      'initial capacity must cover every legal recipe at normal demand upper plus 20%',
    );
  }
}

export type ReceiveInventoryInput = Readonly<{
  transactionId: string;
  referenceId: string;
  ingredientId: string;
  quantityPoints: number;
  totalCost: Money;
}>;

export function receiveInventory(
  state: InventoryState,
  ingredientCatalog: readonly IngredientCatalogItem[],
  input: ReceiveInventoryInput,
): InventoryState {
  assertMutationIdentityUnused(state, input.transactionId);
  if (!input.referenceId) throw new Error('inventory receipt reference id is required');
  assertPositiveSafeInteger(input.quantityPoints, 'receipt quantity');
  if (input.totalCost.currency !== state.currency) throw new Error('receipt currency mismatch');
  moneyMinorUnits(input.totalCost, 'receipt cost');
  const ingredient = findIngredient(ingredientCatalog, input.ingredientId);
  const existing = state.stocks.find((stock) => stock.ingredientId === input.ingredientId);
  const nextStock: InventoryStock = {
    ingredientId: input.ingredientId,
    pool: ingredient.pool,
    onHandPoints: (existing?.onHandPoints ?? 0) + input.quantityPoints,
    reservedPoints: existing?.reservedPoints ?? 0,
    costPool: moneyFromMinorUnits(
      state.currency,
      (existing ? moneyMinorUnits(existing.costPool) : 0n) + moneyMinorUnits(input.totalCost),
    ),
  };
  const next = deepFreeze({
    ...state,
    stocks: replaceStock(state.stocks, nextStock),
    transactions: appendTransactions(state, [
      {
        transactionId: input.transactionId,
        type: 'RECEIPT',
        ingredientId: input.ingredientId,
        quantityPoints: input.quantityPoints,
        amount: input.totalCost,
        referenceId: input.referenceId,
      },
    ]),
  });
  assertCapacity(next);
  return next;
}

function canReserve(state: InventoryState, requirements: readonly RecipeIngredient[]): boolean {
  return requirements.every((requirement) => {
    const stock = state.stocks.find((entry) => entry.ingredientId === requirement.ingredientId);
    return (
      stock !== undefined && stock.onHandPoints - stock.reservedPoints >= requirement.quantityPoints
    );
  });
}

export type ReserveRecipeInput = Readonly<{
  transactionId: string;
  orderId: string;
  servings: number;
  recipe: RecipeVersion;
  enabledSubstitutions: readonly CatalogSubstitution[];
}>;

export type ReserveRecipeResult =
  | Readonly<{
      status: 'RESERVED';
      inventory: InventoryState;
      reservation: OrderIngredientReservation;
    }>
  | Readonly<{ status: 'SOLD_OUT'; inventory: InventoryState }>;

export function reserveRecipeIngredients(
  state: InventoryState,
  input: ReserveRecipeInput,
): ReserveRecipeResult {
  if (state.orderReservations.some((reservation) => reservation.orderId === input.orderId)) {
    throw new Error('order already has an ingredient reservation');
  }
  assertPositiveSafeInteger(input.servings, 'order servings');
  const forAllServings = (ingredients: readonly RecipeIngredient[]) =>
    ingredients.map((ingredient) => {
      const quantityPoints = ingredient.quantityPoints * input.servings;
      assertPositiveSafeInteger(quantityPoints, 'all-servings ingredient quantity');
      return { ...ingredient, quantityPoints };
    });
  const candidates = [
    {
      substitutionId: null,
      qualityDelta: 0,
      priority: -1,
      ingredients: forAllServings(input.recipe.ingredients),
    },
    ...input.enabledSubstitutions
      .filter((substitution) => substitution.recipeVersionId === input.recipe.id)
      .sort((left, right) => left.priority - right.priority || compareStableKey(left.id, right.id))
      .map((substitution) => ({
        substitutionId: substitution.id,
        qualityDelta: substitution.qualityDelta,
        priority: substitution.priority,
        ingredients: forAllServings(substitution.ingredients),
      })),
  ];
  const selected = candidates.find((candidate) => canReserve(state, candidate.ingredients));
  if (!selected) return deepFreeze({ status: 'SOLD_OUT', inventory: state });
  assertMutationIdentityUnused(state, input.transactionId);

  const reservation: OrderIngredientReservation = {
    orderId: input.orderId,
    recipeVersionId: input.recipe.id,
    servings: input.servings,
    substitutionId: selected.substitutionId,
    qualityDelta: selected.qualityDelta,
    ingredients: selected.ingredients.map((ingredient) => ({ ...ingredient })),
  };
  let stocks = state.stocks;
  for (const requirement of selected.ingredients) {
    const stock = stocks.find((entry) => entry.ingredientId === requirement.ingredientId)!;
    stocks = replaceStock(stocks, {
      ...stock,
      reservedPoints: stock.reservedPoints + requirement.quantityPoints,
    });
  }
  const zero = moneyFromMinorUnits(state.currency, 0n);
  return deepFreeze({
    status: 'RESERVED',
    reservation,
    inventory: {
      ...state,
      stocks,
      orderReservations: [...state.orderReservations, reservation].sort((left, right) =>
        compareStableKey(left.orderId, right.orderId),
      ),
      transactions: appendTransactions(
        state,
        selected.ingredients.map((ingredient) => ({
          transactionId: input.transactionId,
          type: 'ORDER_RESERVED' as const,
          ingredientId: ingredient.ingredientId,
          quantityPoints: ingredient.quantityPoints,
          amount: zero,
          referenceId: input.orderId,
        })),
      ),
    },
  });
}

function allocateCost(stock: InventoryStock, quantityPoints: number): bigint {
  if (quantityPoints === stock.onHandPoints) return moneyMinorUnits(stock.costPool);
  return roundHalfUpRatio(
    moneyMinorUnits(stock.costPool) * BigInt(quantityPoints),
    BigInt(stock.onHandPoints),
  );
}

export type CompleteOrderResult = Readonly<{
  inventory: InventoryState;
  cogs: Money;
  consumed: readonly Readonly<{
    ingredientId: string;
    quantityPoints: number;
    cost: Money;
  }>[];
}>;

export function completeReservedOrder(
  state: InventoryState,
  transactionId: string,
  orderId: string,
): CompleteOrderResult {
  assertMutationIdentityUnused(state, transactionId);
  const reservation = state.orderReservations.find((entry) => entry.orderId === orderId);
  if (!reservation) throw new Error('order does not have an ingredient reservation');
  let stocks = state.stocks;
  const consumed: { ingredientId: string; quantityPoints: number; cost: Money }[] = [];
  for (const requirement of reservation.ingredients) {
    const stock = stocks.find((entry) => entry.ingredientId === requirement.ingredientId);
    if (
      !stock ||
      stock.onHandPoints < requirement.quantityPoints ||
      stock.reservedPoints < requirement.quantityPoints
    ) {
      throw new Error('reserved inventory invariant was violated');
    }
    const allocated = allocateCost(stock, requirement.quantityPoints);
    const remainingQuantity = stock.onHandPoints - requirement.quantityPoints;
    const remainingCost = moneyMinorUnits(stock.costPool) - allocated;
    stocks = replaceStock(stocks, {
      ...stock,
      onHandPoints: remainingQuantity,
      reservedPoints: stock.reservedPoints - requirement.quantityPoints,
      costPool: moneyFromMinorUnits(state.currency, remainingQuantity === 0 ? 0n : remainingCost),
    });
    consumed.push({
      ingredientId: requirement.ingredientId,
      quantityPoints: requirement.quantityPoints,
      cost: moneyFromMinorUnits(state.currency, allocated),
    });
  }
  const cogs = moneyFromMinorUnits(
    state.currency,
    consumed.reduce((sum, item) => sum + moneyMinorUnits(item.cost), 0n),
  );
  const next: InventoryState = deepFreeze({
    ...state,
    stocks,
    orderReservations: state.orderReservations.filter((entry) => entry.orderId !== orderId),
    transactions: appendTransactions(
      state,
      consumed.map((item) => ({
        transactionId,
        type: 'ORDER_COMPLETED' as const,
        ingredientId: item.ingredientId,
        quantityPoints: item.quantityPoints,
        amount: item.cost,
        referenceId: orderId,
      })),
    ),
  });
  return deepFreeze({ inventory: next, cogs, consumed });
}

export type DayEndWasteResult = Readonly<{
  inventory: InventoryState;
  wasteExpense: Money;
  wasted: readonly Readonly<{
    ingredientId: string;
    quantityPoints: number;
    cost: Money;
  }>[];
}>;

export function wastePerishableAtDayEnd(
  state: InventoryState,
  transactionId: string,
  businessDay: number,
): DayEndWasteResult {
  assertPositiveSafeInteger(businessDay, 'business day');
  if (
    state.orderReservations.length > 0 ||
    state.stocks.some((stock) => stock.reservedPoints > 0)
  ) {
    throw new Error('day end cannot waste inventory while an order reservation remains');
  }
  const wasted = state.stocks
    .filter((stock) => stock.pool === 'PERISHABLE' && stock.onHandPoints > 0)
    .map((stock) => ({
      ingredientId: stock.ingredientId,
      quantityPoints: stock.onHandPoints,
      cost: stock.costPool,
    }));
  if (wasted.length > 0) assertMutationIdentityUnused(state, transactionId);
  let stocks = state.stocks;
  for (const item of wasted) {
    const stock = stocks.find((entry) => entry.ingredientId === item.ingredientId)!;
    stocks = replaceStock(stocks, {
      ...stock,
      onHandPoints: 0,
      reservedPoints: 0,
      costPool: moneyFromMinorUnits(state.currency, 0n),
    });
  }
  const expense = moneyFromMinorUnits(
    state.currency,
    wasted.reduce((sum, item) => sum + moneyMinorUnits(item.cost), 0n),
  );
  return deepFreeze({
    inventory: {
      ...state,
      stocks,
      transactions: appendTransactions(
        state,
        wasted.map((item) => ({
          transactionId,
          type: 'PERISHABLE_WASTE' as const,
          ingredientId: item.ingredientId,
          quantityPoints: item.quantityPoints,
          amount: item.cost,
          referenceId: `business-day:${businessDay}`,
        })),
      ),
    },
    wasteExpense: expense,
    wasted,
  });
}

export function reserveFutureContractCapacity(
  state: InventoryState,
  transactionId: string,
  contractId: string,
  ingredientId: string,
  quantityPoints: number,
  ingredientCatalog: readonly IngredientCatalogItem[],
): InventoryState {
  assertMutationIdentityUnused(state, transactionId);
  assertPositiveSafeInteger(quantityPoints, 'future contract quantity');
  if (state.reservedUndelivered.some((entry) => entry.contractId === contractId)) {
    throw new Error('contract capacity is already reserved');
  }
  const ingredient = findIngredient(ingredientCatalog, ingredientId);
  const reservation: ReservedUndeliveredContractQuantity = {
    contractId,
    ingredientId,
    pool: ingredient.pool,
    quantityPoints,
  };
  const zero = moneyFromMinorUnits(state.currency, 0n);
  const next: InventoryState = deepFreeze({
    ...state,
    reservedUndelivered: [...state.reservedUndelivered, reservation].sort((left, right) =>
      compareStableKey(left.contractId, right.contractId),
    ),
    transactions: appendTransactions(state, [
      {
        transactionId,
        type: 'FUTURE_CONTRACT_CAPACITY_RESERVED',
        ingredientId,
        quantityPoints,
        amount: zero,
        referenceId: contractId,
      },
    ]),
  });
  assertCapacity(next);
  return next;
}

export function releaseFutureContractCapacity(
  state: InventoryState,
  transactionId: string,
  contractId: string,
  quantityPoints: number,
): InventoryState {
  assertMutationIdentityUnused(state, transactionId);
  assertPositiveSafeInteger(quantityPoints, 'released future contract quantity');
  const existing = state.reservedUndelivered.find((entry) => entry.contractId === contractId);
  if (!existing || existing.quantityPoints < quantityPoints) {
    throw new Error('cannot release more future contract capacity than reserved');
  }
  const remaining = existing.quantityPoints - quantityPoints;
  const nextReservations = state.reservedUndelivered
    .filter((entry) => entry.contractId !== contractId)
    .concat(remaining === 0 ? [] : [{ ...existing, quantityPoints: remaining }]);
  return deepFreeze({
    ...state,
    reservedUndelivered: nextReservations.sort((left, right) =>
      compareStableKey(left.contractId, right.contractId),
    ),
    transactions: appendTransactions(state, [
      {
        transactionId,
        type: 'FUTURE_CONTRACT_CAPACITY_RELEASED',
        ingredientId: existing.ingredientId,
        quantityPoints,
        amount: moneyFromMinorUnits(state.currency, 0n),
        referenceId: contractId,
      },
    ]),
  });
}

export function assertInventoryCostPoolInvariant(state: InventoryState): void {
  for (const stock of state.stocks) {
    assertNonNegativeSafeInteger(stock.onHandPoints, 'stock on hand');
    assertNonNegativeSafeInteger(stock.reservedPoints, 'stock reserved');
    if (stock.reservedPoints > stock.onHandPoints) {
      throw new Error('reserved inventory cannot exceed on hand');
    }
    if (stock.costPool.currency !== state.currency) throw new Error('stock currency mismatch');
    const cost = moneyMinorUnits(stock.costPool);
    if (stock.onHandPoints === 0 && cost !== 0n) {
      throw new Error('empty stock must not retain a cost-pool residual');
    }
  }
  for (const transaction of state.transactions) {
    assertSameCurrency(transaction.amount, moneyFromMinorUnits(state.currency, 0n));
  }
  const ingredientIds = new Set([
    ...state.stocks.map((stock) => stock.ingredientId),
    ...state.transactions.map((transaction) => transaction.ingredientId),
  ]);
  for (const ingredientId of ingredientIds) {
    const transactions = state.transactions.filter(
      (transaction) => transaction.ingredientId === ingredientId,
    );
    const receivedQuantity = transactions
      .filter((transaction) => transaction.type === 'RECEIPT')
      .reduce((sum, transaction) => sum + transaction.quantityPoints, 0);
    const releasedQuantity = transactions
      .filter(
        (transaction) =>
          transaction.type === 'ORDER_COMPLETED' || transaction.type === 'PERISHABLE_WASTE',
      )
      .reduce((sum, transaction) => sum + transaction.quantityPoints, 0);
    const receivedCost = transactions
      .filter((transaction) => transaction.type === 'RECEIPT')
      .reduce((sum, transaction) => sum + moneyMinorUnits(transaction.amount), 0n);
    const releasedCost = transactions
      .filter(
        (transaction) =>
          transaction.type === 'ORDER_COMPLETED' || transaction.type === 'PERISHABLE_WASTE',
      )
      .reduce((sum, transaction) => sum + moneyMinorUnits(transaction.amount), 0n);
    const stock = state.stocks.find((entry) => entry.ingredientId === ingredientId);
    if ((stock?.onHandPoints ?? 0) !== receivedQuantity - releasedQuantity) {
      throw new Error('inventory transaction quantities do not reconcile to on hand');
    }
    if ((stock ? moneyMinorUnits(stock.costPool) : 0n) !== receivedCost - releasedCost) {
      throw new Error('inventory transaction costs do not reconcile to the moving cost pool');
    }
  }
  assertCapacity(state);
}
