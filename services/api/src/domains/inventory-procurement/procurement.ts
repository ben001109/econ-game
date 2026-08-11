import type { IngredientCatalogItem } from './catalog-menu.js';
import {
  receiveInventory,
  releaseFutureContractCapacity,
  reserveFutureContractCapacity,
  type InventoryState,
} from './inventory.js';
import {
  assertPositiveSafeInteger,
  assertSameCurrency,
  compareStableKey,
  deepFreeze,
  moneyFromMinorUnits,
  moneyMinorUnits,
  roundHalfUpRatio,
  stableBucket,
} from './shared.js';
import type { Money } from '../money/money.js';

export type MarketQuote = Readonly<{
  ingredientId: string;
  referenceUnitPrice: Money;
  priceModifierBps: number;
  unitPrice: Money;
}>;

export type MarketSnapshot = Readonly<{
  saveId: string;
  businessDay: number;
  tickIdentity: string;
  marketSeed: string;
  catalogRevision: string;
  simulationRuleVersion: string;
  status: 'LOCKED_UNTIL_DAY_END';
  quotes: readonly MarketQuote[];
}>;

export type CreateMarketSnapshotInput = Readonly<{
  saveId: string;
  businessDay: number;
  marketSeed: string;
  catalogRevision: string;
  simulationRuleVersion: string;
  ingredientCatalog: readonly IngredientCatalogItem[];
}>;

export function createMarketSnapshot(input: CreateMarketSnapshotInput): MarketSnapshot {
  assertPositiveSafeInteger(input.businessDay, 'business day');
  if (
    !input.saveId ||
    !input.marketSeed ||
    !input.catalogRevision ||
    !input.simulationRuleVersion
  ) {
    throw new Error('market snapshot requires save, seed, catalog, and simulation rule identities');
  }
  const currencies = new Set(
    input.ingredientCatalog.map((ingredient) => ingredient.referenceUnitPrice.currency),
  );
  if (currencies.size !== 1) {
    throw new Error('market snapshot ingredients must use one settlement currency');
  }
  if (
    new Set(input.ingredientCatalog.map((ingredient) => ingredient.id)).size !==
    input.ingredientCatalog.length
  ) {
    throw new Error('market snapshot ingredient ids must be unique');
  }
  if (
    input.ingredientCatalog.some(
      (ingredient) => moneyMinorUnits(ingredient.referenceUnitPrice) === 0n,
    )
  ) {
    throw new Error('market snapshot reference prices must be positive');
  }
  const quotes = input.ingredientCatalog
    .map((ingredient) => {
      const priceModifierBps =
        input.businessDay === 1
          ? 0
          : stableBucket(
              input.marketSeed,
              `${input.saveId}:${input.businessDay}:${ingredient.id}`,
              2001,
            ) - 1000;
      const factor = BigInt(10_000 + priceModifierBps);
      return {
        ingredientId: ingredient.id,
        referenceUnitPrice: ingredient.referenceUnitPrice,
        priceModifierBps,
        unitPrice: moneyFromMinorUnits(
          ingredient.referenceUnitPrice.currency,
          roundHalfUpRatio(moneyMinorUnits(ingredient.referenceUnitPrice) * factor, 10_000n),
        ),
      };
    })
    .sort((left, right) => compareStableKey(left.ingredientId, right.ingredientId));
  return deepFreeze({
    saveId: input.saveId,
    businessDay: input.businessDay,
    tickIdentity: `${input.saveId}:${input.businessDay}:SUPPLY_PRICE`,
    marketSeed: input.marketSeed,
    catalogRevision: input.catalogRevision,
    simulationRuleVersion: input.simulationRuleVersion,
    status: 'LOCKED_UNTIL_DAY_END',
    quotes,
  });
}

export type PaymentShortfallInput = Readonly<{
  kind: 'PAYMENT_SHORTFALL';
  source: 'SPOT_PURCHASE' | 'CONTRACT_DELIVERY' | 'CONTRACT_TERMINATION';
  referenceId: string;
  businessDay: number;
  currency: string;
  requiredMinorUnits: string;
  availableMinorUnits: string;
  shortfallMinorUnits: string;
}>;

function createShortfall(
  source: PaymentShortfallInput['source'],
  referenceId: string,
  businessDay: number,
  required: Money,
  available: Money,
): PaymentShortfallInput {
  assertSameCurrency(required, available);
  const requiredMinor = moneyMinorUnits(required);
  const availableMinor = moneyMinorUnits(available);
  return deepFreeze({
    kind: 'PAYMENT_SHORTFALL',
    source,
    referenceId,
    businessDay,
    currency: required.currency,
    requiredMinorUnits: requiredMinor.toString(),
    availableMinorUnits: availableMinor.toString(),
    shortfallMinorUnits: (requiredMinor - availableMinor).toString(),
  });
}

export type SpotPurchaseInput = Readonly<{
  transactionId: string;
  purchaseId: string;
  businessDay: number;
  phase: 'BEFORE_OPENING_AFTER_CONTRACTS';
  themeId: string;
  ingredientId: string;
  quantityPoints: number;
  cashAvailable: Money;
  marketSnapshot: MarketSnapshot;
}>;

export type SpotPurchaseResult =
  | Readonly<{
      status: 'PURCHASED';
      inventory: InventoryState;
      payment: Money;
      remainingCash: Money;
    }>
  | Readonly<{
      status: 'PAYMENT_SHORTFALL';
      inventory: InventoryState;
      e05Input: PaymentShortfallInput;
    }>;

export function purchaseSpotInventory(
  inventory: InventoryState,
  ingredientCatalog: readonly IngredientCatalogItem[],
  input: SpotPurchaseInput,
): SpotPurchaseResult {
  assertPositiveSafeInteger(input.businessDay, 'business day');
  if (input.phase !== 'BEFORE_OPENING_AFTER_CONTRACTS') {
    throw new Error('spot purchasing runs before opening after contract deliveries');
  }
  assertPositiveSafeInteger(input.quantityPoints, 'spot purchase quantity');
  if (input.marketSnapshot.businessDay !== input.businessDay) {
    throw new Error('spot purchase must use the locked snapshot for its business day');
  }
  const ingredient = ingredientCatalog.find((entry) => entry.id === input.ingredientId);
  if (!ingredient || !ingredient.unlockedThemeIds.includes(input.themeId)) {
    throw new Error('spot purchase is limited to the unlocked theme catalog');
  }
  const quote = input.marketSnapshot.quotes.find(
    (entry) => entry.ingredientId === input.ingredientId,
  );
  if (!quote) throw new Error('locked market snapshot does not contain the ingredient');
  if (input.cashAvailable.currency !== inventory.currency)
    throw new Error('cash currency mismatch');
  const payment = moneyFromMinorUnits(
    inventory.currency,
    moneyMinorUnits(quote.unitPrice) * BigInt(input.quantityPoints),
  );
  if (moneyMinorUnits(input.cashAvailable) < moneyMinorUnits(payment)) {
    return deepFreeze({
      status: 'PAYMENT_SHORTFALL',
      inventory,
      e05Input: createShortfall(
        'SPOT_PURCHASE',
        input.purchaseId,
        input.businessDay,
        payment,
        input.cashAvailable,
      ),
    });
  }
  const nextInventory = receiveInventory(inventory, ingredientCatalog, {
    transactionId: input.transactionId,
    referenceId: input.purchaseId,
    ingredientId: input.ingredientId,
    quantityPoints: input.quantityPoints,
    totalCost: payment,
  });
  return deepFreeze({
    status: 'PURCHASED',
    inventory: nextInventory,
    payment,
    remainingCash: moneyFromMinorUnits(
      inventory.currency,
      moneyMinorUnits(input.cashAvailable) - moneyMinorUnits(payment),
    ),
  });
}

export type ContractObligation = Readonly<{
  businessDay: number;
  quantityPoints: number;
  status: 'PENDING' | 'DELIVERED_PAID' | 'TERMINATED';
}>;

export type SupplierContract = Readonly<{
  id: string;
  ingredientId: string;
  signedAfterCompletedBusinessDay: number;
  unitPrice: Money;
  dailyQuantityPoints: number;
  termCompletedBusinessDays: 3;
  status: 'ACTIVE' | 'COMPLETED' | 'TERMINATED';
  obligations: readonly ContractObligation[];
}>;

export type SignSupplierContractInput = Readonly<{
  transactionId: string;
  contractId: string;
  signedAfterCompletedBusinessDay: number;
  phase: 'BETWEEN_BUSINESS_DAYS';
  themeId: string;
  ingredientId: string;
  dailyQuantityPoints: number;
  signingDayMarketSnapshot: MarketSnapshot;
}>;

export type SignSupplierContractResult = Readonly<{
  inventory: InventoryState;
  contracts: readonly SupplierContract[];
  contract: SupplierContract;
}>;

function isContractOpen(contract: SupplierContract): boolean {
  return contract.status === 'ACTIVE';
}

export function signSupplierContract(
  inventory: InventoryState,
  contracts: readonly SupplierContract[],
  ingredientCatalog: readonly IngredientCatalogItem[],
  input: SignSupplierContractInput,
): SignSupplierContractResult {
  assertPositiveSafeInteger(input.signedAfterCompletedBusinessDay, 'signed completed business day');
  if (input.phase !== 'BETWEEN_BUSINESS_DAYS') {
    throw new Error('supplier contracts can only be signed between business days');
  }
  if (input.signedAfterCompletedBusinessDay < 1) {
    throw new Error('supplier contracts can only be signed after the first day settles');
  }
  if (input.signingDayMarketSnapshot.businessDay !== input.signedAfterCompletedBusinessDay) {
    throw new Error('contract fixed price must come from the signing-day market snapshot');
  }
  if (contracts.some((contract) => contract.id === input.contractId)) {
    throw new Error('supplier contract id must be unique');
  }
  if (contracts.filter(isContractOpen).length >= 2) {
    throw new Error('a restaurant may have at most two active supplier contracts');
  }
  if (input.dailyQuantityPoints % 5 !== 0 || input.dailyQuantityPoints <= 0) {
    throw new Error('take-or-pay daily quantity must use positive five-point steps');
  }
  assertPositiveSafeInteger(input.dailyQuantityPoints * 3, 'total contract quantity');
  const quote = input.signingDayMarketSnapshot.quotes.find(
    (entry) => entry.ingredientId === input.ingredientId,
  );
  if (!quote) throw new Error('contract ingredient is absent from the signing-day market');
  if (quote.unitPrice.currency !== inventory.currency) {
    throw new Error('supplier contract price currency must match inventory');
  }
  const ingredient = findCatalogIngredient(ingredientCatalog, input.ingredientId);
  if (!ingredient.unlockedThemeIds.includes(input.themeId)) {
    throw new Error('supplier contract ingredient must belong to the unlocked theme catalog');
  }
  const obligations = [1, 2, 3].map((offset) => ({
    businessDay: input.signedAfterCompletedBusinessDay + offset,
    quantityPoints: input.dailyQuantityPoints,
    status: 'PENDING' as const,
  }));
  const contract: SupplierContract = deepFreeze({
    id: input.contractId,
    ingredientId: input.ingredientId,
    signedAfterCompletedBusinessDay: input.signedAfterCompletedBusinessDay,
    unitPrice: quote.unitPrice,
    dailyQuantityPoints: input.dailyQuantityPoints,
    termCompletedBusinessDays: 3,
    status: 'ACTIVE',
    obligations,
  });
  const nextInventory = reserveFutureContractCapacity(
    inventory,
    input.transactionId,
    contract.id,
    contract.ingredientId,
    input.dailyQuantityPoints * 3,
    ingredientCatalog,
  );
  return deepFreeze({
    inventory: nextInventory,
    contracts: [...contracts, contract].sort((left, right) => compareStableKey(left.id, right.id)),
    contract,
  });
}

function findCatalogIngredient(
  catalog: readonly IngredientCatalogItem[],
  ingredientId: string,
): IngredientCatalogItem {
  const ingredient = catalog.find((entry) => entry.id === ingredientId);
  if (!ingredient) throw new Error('supplier contract references unknown ingredient');
  return ingredient;
}

export type ProcessContractDeliveryInput = Readonly<{
  transactionId: string;
  businessDay: number;
  phase: 'BEFORE_OPENING';
  cashAvailable: Money;
}>;

export type ProcessContractDeliveryResult =
  | Readonly<{
      status: 'DELIVERED_PAID';
      inventory: InventoryState;
      contracts: readonly SupplierContract[];
      payment: Money;
      remainingCash: Money;
    }>
  | Readonly<{
      status: 'PAYMENT_SHORTFALL';
      inventory: InventoryState;
      contracts: readonly SupplierContract[];
      e05Input: PaymentShortfallInput;
    }>;

export function processContractDeliveries(
  inventory: InventoryState,
  contracts: readonly SupplierContract[],
  ingredientCatalog: readonly IngredientCatalogItem[],
  input: ProcessContractDeliveryInput,
): ProcessContractDeliveryResult {
  assertPositiveSafeInteger(input.businessDay, 'business day');
  if (input.phase !== 'BEFORE_OPENING') {
    throw new Error('contract delivery and payment must run before opening');
  }
  if (input.cashAvailable.currency !== inventory.currency)
    throw new Error('cash currency mismatch');
  if (
    contracts.some((contract) =>
      contract.obligations.some(
        (obligation) =>
          obligation.status === 'PENDING' && obligation.businessDay < input.businessDay,
      ),
    )
  ) {
    throw new Error('an overdue contract obligation requires E-05 resolution before opening');
  }
  const due = contracts
    .filter((contract) => contract.status === 'ACTIVE')
    .flatMap((contract) =>
      contract.obligations
        .filter(
          (obligation) =>
            obligation.businessDay === input.businessDay && obligation.status === 'PENDING',
        )
        .map((obligation) => ({ contract, obligation })),
    )
    .sort((left, right) => compareStableKey(left.contract.id, right.contract.id));
  const requiredMinor = due.reduce(
    (sum, entry) =>
      sum + moneyMinorUnits(entry.contract.unitPrice) * BigInt(entry.obligation.quantityPoints),
    0n,
  );
  const payment = moneyFromMinorUnits(inventory.currency, requiredMinor);
  if (moneyMinorUnits(input.cashAvailable) < requiredMinor) {
    return deepFreeze({
      status: 'PAYMENT_SHORTFALL',
      inventory,
      contracts,
      e05Input: createShortfall(
        'CONTRACT_DELIVERY',
        due.map((entry) => entry.contract.id).join(','),
        input.businessDay,
        payment,
        input.cashAvailable,
      ),
    });
  }

  let nextInventory = inventory;
  let nextContracts = [...contracts];
  for (const { contract, obligation } of due) {
    nextInventory = releaseFutureContractCapacity(
      nextInventory,
      `${input.transactionId}:capacity:${contract.id}`,
      contract.id,
      obligation.quantityPoints,
    );
    const deliveryCost = moneyFromMinorUnits(
      inventory.currency,
      moneyMinorUnits(contract.unitPrice) * BigInt(obligation.quantityPoints),
    );
    nextInventory = receiveInventory(nextInventory, ingredientCatalog, {
      transactionId: `${input.transactionId}:receipt:${contract.id}`,
      referenceId: contract.id,
      ingredientId: contract.ingredientId,
      quantityPoints: obligation.quantityPoints,
      totalCost: deliveryCost,
    });
    nextContracts = nextContracts.map((entry) => {
      if (entry.id !== contract.id) return entry;
      const obligations = entry.obligations.map((candidate) =>
        candidate.businessDay === obligation.businessDay && candidate.status === 'PENDING'
          ? { ...candidate, status: 'DELIVERED_PAID' as const }
          : candidate,
      );
      return {
        ...entry,
        obligations,
        status: obligations.every((candidate) => candidate.status === 'DELIVERED_PAID')
          ? ('COMPLETED' as const)
          : entry.status,
      };
    });
  }
  return deepFreeze({
    status: 'DELIVERED_PAID',
    inventory: nextInventory,
    contracts: nextContracts,
    payment,
    remainingCash: moneyFromMinorUnits(
      inventory.currency,
      moneyMinorUnits(input.cashAvailable) - requiredMinor,
    ),
  });
}

export type TerminateSupplierContractInput = Readonly<{
  transactionId: string;
  contractId: string;
  afterCompletedBusinessDay: number;
  phase: 'BETWEEN_BUSINESS_DAYS';
  cashAvailable: Money;
}>;

export type TerminateSupplierContractResult =
  | Readonly<{
      status: 'TERMINATED';
      inventory: InventoryState;
      contracts: readonly SupplierContract[];
      terminationFee: Money;
      remainingCash: Money;
    }>
  | Readonly<{
      status: 'PAYMENT_SHORTFALL';
      inventory: InventoryState;
      contracts: readonly SupplierContract[];
      e05Input: PaymentShortfallInput;
    }>;

export function terminateSupplierContract(
  inventory: InventoryState,
  contracts: readonly SupplierContract[],
  input: TerminateSupplierContractInput,
): TerminateSupplierContractResult {
  assertPositiveSafeInteger(input.afterCompletedBusinessDay, 'completed business day');
  if (input.phase !== 'BETWEEN_BUSINESS_DAYS') {
    throw new Error('supplier contracts can only terminate between business days');
  }
  const contract = contracts.find((entry) => entry.id === input.contractId);
  if (!contract || contract.status !== 'ACTIVE') {
    throw new Error('only an active supplier contract can be terminated');
  }
  if (
    contract.obligations.some(
      (obligation) =>
        obligation.status === 'PENDING' &&
        obligation.businessDay <= input.afterCompletedBusinessDay,
    )
  ) {
    throw new Error('due contract obligations require E-05 resolution before termination');
  }
  if (input.cashAvailable.currency !== inventory.currency)
    throw new Error('cash currency mismatch');
  const remaining = contract.obligations.filter(
    (obligation) =>
      obligation.status === 'PENDING' && obligation.businessDay > input.afterCompletedBusinessDay,
  );
  if (remaining.length === 0) throw new Error('contract has no remaining future commitment');
  const remainingQuantity = remaining.reduce(
    (sum, obligation) => sum + obligation.quantityPoints,
    0,
  );
  const remainingValue = moneyMinorUnits(contract.unitPrice) * BigInt(remainingQuantity);
  const terminationFee = moneyFromMinorUnits(
    inventory.currency,
    roundHalfUpRatio(remainingValue * 25n, 100n),
  );
  if (moneyMinorUnits(input.cashAvailable) < moneyMinorUnits(terminationFee)) {
    return deepFreeze({
      status: 'PAYMENT_SHORTFALL',
      inventory,
      contracts,
      e05Input: createShortfall(
        'CONTRACT_TERMINATION',
        contract.id,
        input.afterCompletedBusinessDay,
        terminationFee,
        input.cashAvailable,
      ),
    });
  }
  const nextInventory = releaseFutureContractCapacity(
    inventory,
    input.transactionId,
    contract.id,
    remainingQuantity,
  );
  const nextContracts = contracts.map((entry) =>
    entry.id === contract.id
      ? {
          ...entry,
          status: 'TERMINATED' as const,
          obligations: entry.obligations.map((obligation) =>
            obligation.status === 'PENDING' &&
            obligation.businessDay > input.afterCompletedBusinessDay
              ? { ...obligation, status: 'TERMINATED' as const }
              : obligation,
          ),
        }
      : entry,
  );
  return deepFreeze({
    status: 'TERMINATED',
    inventory: nextInventory,
    contracts: nextContracts,
    terminationFee,
    remainingCash: moneyFromMinorUnits(
      inventory.currency,
      moneyMinorUnits(input.cashAvailable) - moneyMinorUnits(terminationFee),
    ),
  });
}
