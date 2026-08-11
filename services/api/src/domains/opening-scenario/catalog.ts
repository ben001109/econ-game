type DisplayMoneyRange = Readonly<{ min: string; max: string }>;

type EquipmentDefinition = Readonly<{
  assetKey: 'equipment:opening-bundle:1';
  condition: 'BASIC' | 'AGED';
  originalCostDisplay: string;
  accumulatedDepreciationDisplay: string;
  bookValueDisplay: string;
  residualValueDisplay: string;
  usefulLifeCompletedBusinessDays: 120;
  depreciatedCompletedBusinessDays: number;
  remainingCompletedBusinessDays: number;
  depreciationPerCompletedBusinessDayDisplay: string;
  capacityMultiplier: '1.00' | '0.85';
  qualityModifier: 0 | -10;
}>;

type NpcContractDefinition = Readonly<{
  npcKey: string;
  contractKey: string;
  role: 'KITCHEN' | 'CASHIER';
  capability: 'MEDIUM';
  morale: 'NORMAL' | 'LOW';
  salaryDisplay: string;
}>;

type OpeningScenarioDefinition = Readonly<{
  premisesKey: string;
  startingCashDisplay: string;
  dailyRentDisplay: string;
  leaseDepositDisplay: string;
  startingReputation: 30 | 50;
  matureRevenueTargetDisplay: string;
  firstTenCompletedDaysProfitRangeDisplay: DisplayMoneyRange;
  postRepairProfitRangeDisplay: DisplayMoneyRange | null;
  equipment: EquipmentDefinition | null;
  npcContracts: readonly NpcContractDefinition[];
  loanPrincipalDisplay: string;
  installmentPrincipalDisplay: string | null;
  planningAllocations: readonly Readonly<{
    allocationKey: string;
    purpose: 'BASIC_EQUIPMENT' | 'INITIAL_INVENTORY';
    amountDisplay: string;
  }>[];
}>;

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export const openingScenarioCatalog = deepFreeze({
  EMPTY_PREMISES: {
    premisesKey: 'premises:empty-premises:opening',
    startingCashDisplay: '32000',
    dailyRentDisplay: '900',
    leaseDepositDisplay: '1800',
    startingReputation: 50,
    matureRevenueTargetDisplay: '4200',
    firstTenCompletedDaysProfitRangeDisplay: { min: '-300', max: '550' },
    postRepairProfitRangeDisplay: null,
    equipment: null,
    npcContracts: [],
    loanPrincipalDisplay: '0',
    installmentPrincipalDisplay: null,
    planningAllocations: [
      {
        allocationKey: 'planning:basic-equipment',
        purpose: 'BASIC_EQUIPMENT',
        amountDisplay: '15000',
      },
      {
        allocationKey: 'planning:initial-inventory',
        purpose: 'INITIAL_INVENTORY',
        amountDisplay: '3200',
      },
    ],
  },
  DEFAULT_SMALL_SHOP: {
    premisesKey: 'premises:default-small-shop:opening',
    startingCashDisplay: '12000',
    dailyRentDisplay: '1000',
    leaseDepositDisplay: '2000',
    startingReputation: 50,
    matureRevenueTargetDisplay: '5000',
    firstTenCompletedDaysProfitRangeDisplay: { min: '100', max: '400' },
    postRepairProfitRangeDisplay: null,
    equipment: {
      assetKey: 'equipment:opening-bundle:1',
      condition: 'BASIC',
      originalCostDisplay: '32000',
      accumulatedDepreciationDisplay: '4000',
      bookValueDisplay: '28000',
      residualValueDisplay: '8000',
      usefulLifeCompletedBusinessDays: 120,
      depreciatedCompletedBusinessDays: 20,
      remainingCompletedBusinessDays: 100,
      depreciationPerCompletedBusinessDayDisplay: '200',
      capacityMultiplier: '1.00',
      qualityModifier: 0,
    },
    npcContracts: [
      {
        npcKey: 'npc:cashier:1',
        contractKey: 'npc-contract:cashier:1',
        role: 'CASHIER',
        capability: 'MEDIUM',
        morale: 'NORMAL',
        salaryDisplay: '550',
      },
      {
        npcKey: 'npc:kitchen:1',
        contractKey: 'npc-contract:kitchen:1',
        role: 'KITCHEN',
        capability: 'MEDIUM',
        morale: 'NORMAL',
        salaryDisplay: '650',
      },
    ],
    loanPrincipalDisplay: '35000',
    installmentPrincipalDisplay: '1750',
    planningAllocations: [],
  },
  TROUBLED_SHOP: {
    premisesKey: 'premises:troubled-shop:opening',
    startingCashDisplay: '8000',
    dailyRentDisplay: '700',
    leaseDepositDisplay: '1400',
    startingReputation: 30,
    matureRevenueTargetDisplay: '4100',
    firstTenCompletedDaysProfitRangeDisplay: { min: '-350', max: '250' },
    postRepairProfitRangeDisplay: { min: '250', max: '650' },
    equipment: {
      assetKey: 'equipment:opening-bundle:1',
      condition: 'AGED',
      originalCostDisplay: '40000',
      accumulatedDepreciationDisplay: '15000',
      bookValueDisplay: '25000',
      residualValueDisplay: '4000',
      usefulLifeCompletedBusinessDays: 120,
      depreciatedCompletedBusinessDays: 50,
      remainingCompletedBusinessDays: 70,
      depreciationPerCompletedBusinessDayDisplay: '300',
      capacityMultiplier: '0.85',
      qualityModifier: -10,
    },
    npcContracts: [
      {
        npcKey: 'npc:cashier:1',
        contractKey: 'npc-contract:cashier:1',
        role: 'CASHIER',
        capability: 'MEDIUM',
        morale: 'LOW',
        salaryDisplay: '650',
      },
      {
        npcKey: 'npc:kitchen:1',
        contractKey: 'npc-contract:kitchen:1',
        role: 'KITCHEN',
        capability: 'MEDIUM',
        morale: 'LOW',
        salaryDisplay: '750',
      },
    ],
    loanPrincipalDisplay: '55000',
    installmentPrincipalDisplay: '2750',
    planningAllocations: [],
  },
} satisfies Record<string, OpeningScenarioDefinition>);

export type OpeningScenario = keyof typeof openingScenarioCatalog;
