import { createHash } from 'node:crypto';

import {
  calculateBasisPointAmountRoundHalfUp,
  createMoneyFromDisplayInteger,
  type CurrencyMetadata,
  type Money,
} from '../money/money.js';
import { openingScenarioCatalog, type OpeningScenario } from './catalog.js';
import { resolveOpeningRegistry, type OpeningVersionSelection } from './registry.js';

export type CompetitiveOperatingMode = 'STRATEGY' | 'LIGHTWEIGHT_REALTIME';
export type ReputationDimension = 'QUALITY' | 'SPEED' | 'PRICE' | 'FAIRNESS' | 'VIBE';

type MoneyRange = Readonly<{ min: Money; max: Money }>;

export type EquipmentSnapshot = Readonly<{
  assetKey: 'equipment:opening-bundle:1';
  category: 'KITCHEN_FRONT_BUNDLE';
  condition: 'BASIC' | 'AGED';
  originalCost: Money;
  accumulatedDepreciation: Money;
  bookValue: Money;
  residualValue: Money;
  depreciationMethod: 'STRAIGHT_LINE_COMPLETED_DAY';
  usefulLifeCompletedBusinessDays: 120;
  depreciatedCompletedBusinessDays: number;
  remainingCompletedBusinessDays: number;
  depreciationPerCompletedBusinessDay: Money;
  depreciationTiming: 'DAY_END_AFTER_COMPLETED_BUSINESS_DAY';
  cashImpact: 'NON_CASH';
  capacityMultiplier: '1.00' | '0.85';
  qualityModifier: 0 | -10;
  termsVersion: string;
}>;

export type NpcContractSnapshot = Readonly<{
  contractKey: string;
  npcKey: string;
  role: 'KITCHEN' | 'CASHIER';
  capability: 'MEDIUM';
  morale: 'NORMAL' | 'LOW';
  salary: Money;
  salaryUnit: 'PER_COMPLETED_SCHEDULED_DAY';
  shiftCoverage: 'ALL_LOCKED_SERVICE_PERIODS';
  effectiveCompletedBusinessDay: 1;
  endCompletedBusinessDay: 30;
  bonusType: 'NONE';
  bonusAmount: Money;
  profitShareBps: 0;
  termsVersion: string;
}>;

export type LoanInstallmentSnapshot = Readonly<{
  sequence: number;
  dueCompletedBusinessDay: number;
  principal: Money;
  interest: Money;
  total: Money;
  status: 'SCHEDULED';
}>;

export type OpeningLoanSnapshot = Readonly<{
  liabilityKey: 'loan:opening:1';
  currency: string;
  openingPrincipal: Money;
  openingBalance: Money;
  annualInterestBps: 0;
  repaymentModel: 'EQUAL_PRINCIPAL';
  installmentCount: 20;
  lateFeePolicy: Readonly<{
    basisPoints: 500;
    base: 'UNPAID_INSTALLMENT';
    rounding: 'ROUND_HALF_UP_MINOR_UNITS';
    chargedOncePerInstallment: true;
    compounds: false;
  }>;
  firstMissGracePolicy: Readonly<{
    eligibleMissedDueCount: 1;
    graceCompletedBusinessDays: 1;
    lateFeeRecordedOnMissedDueDay: true;
    additionalFeeDuringGrace: false;
  }>;
  installments: readonly LoanInstallmentSnapshot[];
  termsVersion: string;
}>;

export type OpeningSnapshotPayload = Readonly<{
  snapshotSchemaVersion: string;
  openingCatalogVersion: string;
  currencyMetadataVersion: string;
  simulationRuleVersion: string;
  scenario: OpeningScenario;
  operatingMode: CompetitiveOperatingMode;
  settlementCurrency: Readonly<{ code: string; minorUnitExponent: number }>;
  settlementCash: Readonly<{ assetKey: 'cash:settlement'; amount: Money }>;
  leaseDeposit: Readonly<{
    assetKey: 'lease-deposit:opening';
    status: 'HELD';
    amount: Money;
    interestBps: 0;
    refundableAtTermEnd: true;
    permittedOffsets: readonly ['CONFIRMED_DAMAGE', 'CONFIRMED_UNPAID_RENT'];
  }>;
  equipmentBundles: readonly EquipmentSnapshot[];
  openingInventory: readonly never[];
  planningAllocations: readonly Readonly<{
    allocationKey: string;
    purpose: 'BASIC_EQUIPMENT' | 'INITIAL_INVENTORY';
    amount: Money;
    accountingTreatment: 'PLANNING_ONLY_NO_ASSET_OR_LEDGER_MOVEMENT';
  }>[];
  npcContracts: readonly NpcContractSnapshot[];
  reputation: Readonly<{
    dimensions: Readonly<Record<ReputationDimension, number>>;
    overall: number;
    overallRounding: 'ROUND_HALF_UP';
  }>;
  lease: Readonly<{
    leaseKey: 'lease:opening:1';
    premisesKey: string;
    effectiveCompletedBusinessDay: 1;
    endCompletedBusinessDay: 30;
    termCompletedBusinessDays: 30;
    dailyRent: Money;
    rentDueTiming: 'DAY_END_EACH_COMPLETED_BUSINESS_DAY';
    rentAdjustmentWithinTerm: 'PROHIBITED';
    renewalRentIncreaseCapBps: 1000;
    renewalNoticeCompletedBusinessDays: 5;
    renewalRequiresPlayerConfirmation: true;
    termsVersion: string;
  }>;
  loans: readonly OpeningLoanSnapshot[];
  economicTargets: Readonly<{
    matureRevenue: Money;
    firstTenCompletedDaysProfitRange: MoneyRange;
    postRepairProfitRange: MoneyRange | null;
  }>;
}>;

export type OpeningSnapshot = Readonly<OpeningSnapshotPayload & { openingSnapshotHash: string }>;

export type CreateOpeningSnapshotInput = Readonly<{
  scenario: string;
  operatingMode: string;
  currency: string;
}>;

const operatingModes = new Set<CompetitiveOperatingMode>(['STRATEGY', 'LIGHTWEIGHT_REALTIME']);

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function compareCanonicalKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertExactInputKeys(input: CreateOpeningSnapshotInput): void {
  const expected = ['currency', 'operatingMode', 'scenario'];
  const actual = Object.keys(input as object).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(
      'opening input accepts only scenario, operatingMode, and currency; versions and exponent are server-owned',
    );
  }
}

function isOpeningScenario(value: string): value is OpeningScenario {
  return Object.hasOwn(openingScenarioCatalog, value);
}

function money(metadata: CurrencyMetadata, displayInteger: string): Money {
  return createMoneyFromDisplayInteger(metadata, displayInteger);
}

function moneyRange(
  metadata: CurrencyMetadata,
  range: Readonly<{ min: string; max: string }>,
): MoneyRange {
  return {
    min: money(metadata, range.min),
    max: money(metadata, range.max),
  };
}

function moneyMinor(moneyValue: Money): bigint {
  return BigInt(moneyValue.minorUnits);
}

export function assertEquipmentContract(equipment: EquipmentSnapshot): void {
  const originalCost = moneyMinor(equipment.originalCost);
  const accumulated = moneyMinor(equipment.accumulatedDepreciation);
  const bookValue = moneyMinor(equipment.bookValue);
  const residual = moneyMinor(equipment.residualValue);
  const perDay = moneyMinor(equipment.depreciationPerCompletedBusinessDay);

  if (bookValue !== originalCost - accumulated) {
    throw new Error('equipment book value must equal original cost minus accumulated depreciation');
  }
  if (accumulated > originalCost - residual || bookValue < residual) {
    throw new Error('equipment depreciation cannot reduce book value below residual value');
  }
  if (
    equipment.depreciatedCompletedBusinessDays + equipment.remainingCompletedBusinessDays !==
    equipment.usefulLifeCompletedBusinessDays
  ) {
    throw new Error('equipment completed-day life arithmetic is inconsistent');
  }
  if (perDay * BigInt(equipment.usefulLifeCompletedBusinessDays) !== originalCost - residual) {
    throw new Error('equipment straight-line depreciation amount is inconsistent');
  }
  if (perDay * BigInt(equipment.depreciatedCompletedBusinessDays) !== accumulated) {
    throw new Error('equipment accumulated depreciation does not match elapsed completed days');
  }
  if (
    (equipment.condition === 'BASIC' &&
      (equipment.capacityMultiplier !== '1.00' || equipment.qualityModifier !== 0)) ||
    (equipment.condition === 'AGED' &&
      (equipment.capacityMultiplier !== '0.85' || equipment.qualityModifier !== -10))
  ) {
    throw new Error('equipment operating modifiers do not match the locked E-01/E-04 contract');
  }
}

function createEquipment(
  metadata: CurrencyMetadata,
  catalogVersion: string,
  definition: NonNullable<(typeof openingScenarioCatalog)[OpeningScenario]['equipment']>,
): EquipmentSnapshot {
  const equipment: EquipmentSnapshot = {
    assetKey: definition.assetKey,
    category: 'KITCHEN_FRONT_BUNDLE',
    condition: definition.condition,
    originalCost: money(metadata, definition.originalCostDisplay),
    accumulatedDepreciation: money(metadata, definition.accumulatedDepreciationDisplay),
    bookValue: money(metadata, definition.bookValueDisplay),
    residualValue: money(metadata, definition.residualValueDisplay),
    depreciationMethod: 'STRAIGHT_LINE_COMPLETED_DAY',
    usefulLifeCompletedBusinessDays: definition.usefulLifeCompletedBusinessDays,
    depreciatedCompletedBusinessDays: definition.depreciatedCompletedBusinessDays,
    remainingCompletedBusinessDays: definition.remainingCompletedBusinessDays,
    depreciationPerCompletedBusinessDay: money(
      metadata,
      definition.depreciationPerCompletedBusinessDayDisplay,
    ),
    depreciationTiming: 'DAY_END_AFTER_COMPLETED_BUSINESS_DAY',
    cashImpact: 'NON_CASH',
    capacityMultiplier: definition.capacityMultiplier,
    qualityModifier: definition.qualityModifier,
    termsVersion: catalogVersion,
  };
  assertEquipmentContract(equipment);
  return equipment;
}

function createNpcContracts(
  metadata: CurrencyMetadata,
  catalogVersion: string,
  definitions: (typeof openingScenarioCatalog)[OpeningScenario]['npcContracts'],
): NpcContractSnapshot[] {
  return definitions
    .map((definition) => ({
      contractKey: definition.contractKey,
      npcKey: definition.npcKey,
      role: definition.role,
      capability: definition.capability,
      morale: definition.morale,
      salary: money(metadata, definition.salaryDisplay),
      salaryUnit: 'PER_COMPLETED_SCHEDULED_DAY' as const,
      shiftCoverage: 'ALL_LOCKED_SERVICE_PERIODS' as const,
      effectiveCompletedBusinessDay: 1 as const,
      endCompletedBusinessDay: 30 as const,
      bonusType: 'NONE' as const,
      bonusAmount: money(metadata, '0'),
      profitShareBps: 0 as const,
      termsVersion: catalogVersion,
    }))
    .sort((left, right) => compareCanonicalKeys(left.contractKey, right.contractKey));
}

function createLoan(
  metadata: CurrencyMetadata,
  catalogVersion: string,
  principalDisplay: string,
  installmentDisplay: string | null,
): OpeningLoanSnapshot[] {
  if (installmentDisplay === null) {
    if (principalDisplay !== '0') {
      throw new Error('a non-zero opening loan requires an installment schedule');
    }
    return [];
  }

  const openingPrincipal = money(metadata, principalDisplay);
  const installmentPrincipal = money(metadata, installmentDisplay);
  const zero = money(metadata, '0');
  const installments = Array.from(
    { length: 20 },
    (_, index): LoanInstallmentSnapshot => ({
      sequence: index + 1,
      dueCompletedBusinessDay: (index + 1) * 5,
      principal: installmentPrincipal,
      interest: zero,
      total: installmentPrincipal,
      status: 'SCHEDULED',
    }),
  );
  const principalSum = installments.reduce(
    (sum, installment) => sum + moneyMinor(installment.principal),
    0n,
  );
  if (principalSum !== moneyMinor(openingPrincipal)) {
    throw new Error('loan installment principal sum must equal opening principal');
  }

  return [
    {
      liabilityKey: 'loan:opening:1',
      currency: metadata.code,
      openingPrincipal,
      openingBalance: openingPrincipal,
      annualInterestBps: 0,
      repaymentModel: 'EQUAL_PRINCIPAL',
      installmentCount: 20,
      lateFeePolicy: {
        basisPoints: 500,
        base: 'UNPAID_INSTALLMENT',
        rounding: 'ROUND_HALF_UP_MINOR_UNITS',
        chargedOncePerInstallment: true,
        compounds: false,
      },
      firstMissGracePolicy: {
        eligibleMissedDueCount: 1,
        graceCompletedBusinessDays: 1,
        lateFeeRecordedOnMissedDueDay: true,
        additionalFeeDuringGrace: false,
      },
      installments,
      termsVersion: catalogVersion,
    },
  ];
}

function roundHalfUpAverage(values: readonly number[]): number {
  const sum = values.reduce((total, value) => total + value, 0);
  return Math.floor(sum / values.length + 0.5);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonical snapshot payload cannot contain a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      compareCanonicalKeys(left, right),
    );
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
      .join(',')}}`;
  }
  throw new Error('canonical snapshot payload contains an unsupported value');
}

export function serializeOpeningSnapshotPayload(
  snapshot: OpeningSnapshot | OpeningSnapshotPayload,
): string {
  const { openingSnapshotHash: _excluded, ...payload } = snapshot as OpeningSnapshot;
  return canonicalize(payload);
}

export function calculateOpeningSnapshotHash(
  snapshot: OpeningSnapshot | OpeningSnapshotPayload,
): string {
  return createHash('sha256')
    .update(serializeOpeningSnapshotPayload(snapshot), 'utf8')
    .digest('hex');
}

export function calculateOpeningInstallmentLateFee(installment: LoanInstallmentSnapshot): Money {
  return calculateBasisPointAmountRoundHalfUp(installment.total, 500);
}

export function createOpeningSnapshot(
  input: CreateOpeningSnapshotInput,
  serverVersions: OpeningVersionSelection,
): OpeningSnapshot {
  if (input === null || typeof input !== 'object') {
    throw new Error('opening input is required');
  }
  assertExactInputKeys(input);
  if (!isOpeningScenario(input.scenario)) {
    throw new Error('scenario must be a confirmed MVP opening scenario');
  }
  if (!operatingModes.has(input.operatingMode as CompetitiveOperatingMode)) {
    throw new Error('operating mode must be a locked competitive operating mode');
  }

  const resolved = resolveOpeningRegistry(serverVersions, input.currency);
  const definition = openingScenarioCatalog[input.scenario];
  const baseline = definition.startingReputation;
  const dimensions = {
    QUALITY: baseline,
    SPEED: baseline,
    PRICE: baseline,
    FAIRNESS: baseline,
    VIBE: baseline,
  };
  const depositAmount = money(resolved.currency, definition.leaseDepositDisplay);
  const dailyRent = money(resolved.currency, definition.dailyRentDisplay);
  if (moneyMinor(depositAmount) !== moneyMinor(dailyRent) * 2n) {
    throw new Error('opening lease deposit must equal two completed-day rents');
  }

  const payload: OpeningSnapshotPayload = {
    ...resolved.versions,
    scenario: input.scenario,
    operatingMode: input.operatingMode as CompetitiveOperatingMode,
    settlementCurrency: { ...resolved.currency },
    settlementCash: {
      assetKey: 'cash:settlement',
      amount: money(resolved.currency, definition.startingCashDisplay),
    },
    leaseDeposit: {
      assetKey: 'lease-deposit:opening',
      status: 'HELD',
      amount: depositAmount,
      interestBps: 0,
      refundableAtTermEnd: true,
      permittedOffsets: ['CONFIRMED_DAMAGE', 'CONFIRMED_UNPAID_RENT'],
    },
    equipmentBundles:
      definition.equipment === null
        ? []
        : [
            createEquipment(
              resolved.currency,
              resolved.versions.openingCatalogVersion,
              definition.equipment,
            ),
          ],
    openingInventory: [],
    planningAllocations: definition.planningAllocations
      .map((allocation) => ({
        allocationKey: allocation.allocationKey,
        purpose: allocation.purpose,
        amount: money(resolved.currency, allocation.amountDisplay),
        accountingTreatment: 'PLANNING_ONLY_NO_ASSET_OR_LEDGER_MOVEMENT' as const,
      }))
      .sort((left, right) => compareCanonicalKeys(left.allocationKey, right.allocationKey)),
    npcContracts: createNpcContracts(
      resolved.currency,
      resolved.versions.openingCatalogVersion,
      definition.npcContracts,
    ),
    reputation: {
      dimensions,
      overall: roundHalfUpAverage(Object.values(dimensions)),
      overallRounding: 'ROUND_HALF_UP',
    },
    lease: {
      leaseKey: 'lease:opening:1',
      premisesKey: definition.premisesKey,
      effectiveCompletedBusinessDay: 1,
      endCompletedBusinessDay: 30,
      termCompletedBusinessDays: 30,
      dailyRent,
      rentDueTiming: 'DAY_END_EACH_COMPLETED_BUSINESS_DAY',
      rentAdjustmentWithinTerm: 'PROHIBITED',
      renewalRentIncreaseCapBps: 1000,
      renewalNoticeCompletedBusinessDays: 5,
      renewalRequiresPlayerConfirmation: true,
      termsVersion: resolved.versions.openingCatalogVersion,
    },
    loans: createLoan(
      resolved.currency,
      resolved.versions.openingCatalogVersion,
      definition.loanPrincipalDisplay,
      definition.installmentPrincipalDisplay,
    ),
    economicTargets: {
      matureRevenue: money(resolved.currency, definition.matureRevenueTargetDisplay),
      firstTenCompletedDaysProfitRange: moneyRange(
        resolved.currency,
        definition.firstTenCompletedDaysProfitRangeDisplay,
      ),
      postRepairProfitRange:
        definition.postRepairProfitRangeDisplay === null
          ? null
          : moneyRange(resolved.currency, definition.postRepairProfitRangeDisplay),
    },
  };
  const openingSnapshotHash = calculateOpeningSnapshotHash(payload);
  return deepFreeze({ ...payload, openingSnapshotHash }) as OpeningSnapshot;
}

export function assertOpeningSnapshotSupported(snapshot: OpeningSnapshot): void {
  const resolved = resolveOpeningRegistry(
    {
      snapshotSchemaVersion: snapshot.snapshotSchemaVersion,
      openingCatalogVersion: snapshot.openingCatalogVersion,
      currencyMetadataVersion: snapshot.currencyMetadataVersion,
      simulationRuleVersion: snapshot.simulationRuleVersion,
    },
    snapshot.settlementCurrency.code,
  );
  if (resolved.currency.minorUnitExponent !== snapshot.settlementCurrency.minorUnitExponent) {
    throw new Error('snapshot currency exponent does not match its registered metadata version');
  }
  if (calculateOpeningSnapshotHash(snapshot) !== snapshot.openingSnapshotHash) {
    throw new Error('opening snapshot hash does not match its canonical payload');
  }
}
