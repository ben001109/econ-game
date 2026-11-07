import {
  canonicalizeReleaseEvidence,
  hashReleaseEvidenceEvents,
  RELEASE_EVIDENCE_VERSION,
  type CanonicalEvidenceValue,
} from '../../../../../packages/econ-game-release-evidence/index.js';

import { deriveFloorFlowServiceProfile } from '../demand-flow/demand-flow.js';
import {
  MVP_FIRST_DAY_CATALOG_VERSIONS,
  resolveMvpFirstDayCatalog,
} from '../inventory-procurement/mvp-first-day-catalog.js';
import {
  assertInventoryCostPoolInvariant,
  wastePerishableAtDayEnd,
  type InventoryState,
} from '../inventory-procurement/inventory.js';
import { createMoney, type Money } from '../money/money.js';
import { assertOpeningSnapshotSupported } from '../opening-scenario/snapshot.js';
import type { RecipeServiceSnapshot } from '../service-quality/service-quality.js';
import {
  createAdvanceServicePeriodInput,
  replayAdvanceServicePeriod,
  type AdvanceServicePeriodResultSnapshot,
} from '../../gameplay/advance-service-period.js';
import { validateCanonicalOpenAuthority } from '../../gameplay/open-business-day-command.js';
import type { FirstDayOpenAuthority } from '../../gameplay/prisma-open-business-day-repository.js';
import type {
  PersistedAdvanceExecution,
  PersistedInventoryAudit,
  PersistedInventoryStock,
} from '../../gameplay/prisma-advance-service-period-repository.js';

export const MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION =
  'mvp-first-day-settlement-policy/v1' as const;
export const MVP_FIRST_DAY_SETTLEMENT_SIMULATION_RULE = 'mvp-e01-v1' as const;

export type MvpFirstDaySettlementPolicyVersion = typeof MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION;
export type MvpFirstDayServicePeriodPlan = 'TWO_PERIODS' | 'THREE_PERIODS';
export type MvpFirstDayServicePeriod = 'LUNCH' | 'OFF_PEAK' | 'DINNER';
export type MvpFirstDayOwnerAssignment = 'KITCHEN' | 'FRONT' | 'NONE';

export type MvpFirstDaySettlementLockedRecords = Readonly<{
  policyVersion: MvpFirstDaySettlementPolicyVersion;
  businessDay: 1;
  openAuthority: FirstDayOpenAuthority;
  executions: readonly PersistedAdvanceExecution[];
  e03: Readonly<{
    openingInventory: InventoryState;
    finalInventoryBeforeWaste: InventoryState;
    periodOutcomes: readonly Readonly<{
      ordinal: number;
      resultHash: string;
      outcomes: AdvanceServicePeriodResultSnapshot['inventoryOutcomes'];
    }>[];
    inventoryStocks: readonly PersistedInventoryStock[];
    inventoryAudits: readonly PersistedInventoryAudit[];
  }>;
}>;

type ServerOpeningAccountingAuthority = Readonly<{
  source: 'PERSISTED_PREOPEN_ACCOUNTING';
  snapshotHash: string;
  cashAfterProcurement: Money;
}>;

type ServerServedOrderFinancial = Readonly<{
  orderId: string;
  grossRevenue: Money;
  cogs: Money;
}>;

type ServerPeriodExecutionAuthority = Readonly<{
  source: 'PERSISTED_SERVICE_PERIOD_EXECUTION';
  ordinal: number;
  periodKey: MvpFirstDayServicePeriod;
  inputHash: string;
  resultHash: string;
  ownerAssignment: MvpFirstDayOwnerAssignment;
  initiator: Readonly<{ actorId: string; role: 'OWNER' | 'MANAGER' }>;
  periodWindow: Readonly<{ start: number; end: number }>;
  servedOrders: readonly ServerServedOrderFinancial[];
}>;

type ServerNpcContractAuthority = Readonly<{
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

type ServerLeaseAuthority = Readonly<{
  source: 'PERSISTED_OPENING_LEASE';
  openingSnapshotHash: string;
  leaseKey: 'lease:opening:1';
  termsVersion: string;
  effectiveCompletedBusinessDay: 1;
  endCompletedBusinessDay: 30;
  rentDueTiming: 'DAY_END_EACH_COMPLETED_BUSINESS_DAY';
  dailyRent: Money;
}>;

type ServerPerishableWaste = Readonly<{
  ingredientId: string;
  cost: Money;
}>;

type ServerE03DayEndAuthority = Readonly<{
  source: 'PERSISTED_E03_DAY_END_INVENTORY';
  finalInventoryHash: string;
  perishableWaste: readonly ServerPerishableWaste[];
}>;

type ServerEquipmentDepreciationEntry = Readonly<{
  assetKey: string;
  termsVersion: string;
  depreciationMethod: 'STRAIGHT_LINE_COMPLETED_DAY';
  depreciationTiming: 'DAY_END_AFTER_COMPLETED_BUSINESS_DAY';
  cashImpact: 'NON_CASH';
  amount: Money;
}>;

type ServerEquipmentDepreciationAuthority = Readonly<{
  source: 'PERSISTED_OPENING_EQUIPMENT_SNAPSHOT';
  openingSnapshotHash: string;
  entries: readonly ServerEquipmentDepreciationEntry[];
}>;

/**
 * Private server authority. A command adapter must construct this only from locked rows and
 * immutable snapshots. It is deliberately not a client command shape.
 */
type DerivedMvpFirstDaySettlementAuthority = Readonly<{
  version: MvpFirstDaySettlementPolicyVersion;
  businessDay: 1;
  simulationRuleVersion: string;
  servicePeriodPlan: MvpFirstDayServicePeriodPlan;
  openingSnapshotHash: string;
  openingAccounting: ServerOpeningAccountingAuthority;
  periodExecutions: readonly ServerPeriodExecutionAuthority[];
  npcContracts: readonly ServerNpcContractAuthority[];
  lease: ServerLeaseAuthority;
  e03DayEnd: ServerE03DayEndAuthority;
  equipmentDepreciation: ServerEquipmentDepreciationAuthority;
}>;

type SettlementFairnessWorker = Readonly<{
  workerId: string;
  kind: 'NPC' | 'HUMAN';
  scheduledPeriodKeys: readonly MvpFirstDayServicePeriod[];
  fulfilledPeriodKeys: readonly MvpFirstDayServicePeriod[];
  scheduledPeriodUnits: number;
  fulfilledPeriodUnits: number;
  scheduledTickUnits: number;
  fulfilledTickUnits: number;
}>;

export type MvpFirstDaySettlementEvidencePayload = Readonly<{
  version: MvpFirstDaySettlementPolicyVersion;
  hashContractVersion: typeof RELEASE_EVIDENCE_VERSION;
  businessDay: 1;
  simulationRuleVersion: string;
  servicePeriodPlan: MvpFirstDayServicePeriodPlan;
  authorityReferences: Readonly<{
    openingSnapshotHash: string;
    preopenAccountingSnapshotHash: string;
    periodExecutions: readonly Readonly<{
      ordinal: number;
      periodKey: MvpFirstDayServicePeriod;
      inputHash: string;
      resultHash: string;
      servedOrders: readonly ServerServedOrderFinancial[];
    }>[];
    finalInventoryHash: string;
    leaseTermsVersion: string;
    equipmentTermsVersions: readonly string[];
  }>;
  cashFlow: Readonly<{
    openingCashAfterPreopenProcurement: Money;
    grossServiceRevenueCollected: Money;
    npcPayrollPaid: Money;
    dailyLeaseRentPaid: Money;
    cashBeforeE05RiskPenalty: Money;
    preopenProcurementRecharged: false;
    cogsCashChargedAtSettlement: false;
    wasteCashChargedAtSettlement: false;
  }>;
  profitAndLoss: Readonly<{
    grossRevenue: Money;
    cogs: Money;
    wasteLoss: Money;
    payroll: Money;
    rent: Money;
    operatingProfit: Money;
    equipmentDepreciation: Money;
    equipmentDepreciationCashImpact: 'NON_CASH';
  }>;
  explicitFirstDayZeroPolicy: Readonly<{
    vat: Money;
    employerContribution: Money;
    fixedOperatingFee: Money;
    debtInstallment: Money;
    debtInterest: Money;
    overduePenalty: Money;
  }>;
  payrollEntries: readonly Readonly<{
    contractKey: string;
    npcKey: string;
    amount: Money;
    recognition: 'ONCE_PER_COMPLETED_SCHEDULED_DAY';
  }>[];
  fairness: Readonly<{
    unit: 'CANONICAL_SERVICE_PERIOD_AND_TICK';
    workers: readonly SettlementFairnessWorker[];
    scheduledPeriodUnits: number;
    fulfilledPeriodUnits: number;
    scheduledTickUnits: number;
    fulfilledTickUnits: number;
  }>;
  riskOpeningState: Readonly<{
    state: 'NORMAL';
    consecutiveDelinquentDays: 0;
    consecutiveResolutionDays: 0;
    delinquencyBaselineShortfall: null;
  }>;
}>;

export type MvpFirstDaySettlementEvidence = Readonly<
  MvpFirstDaySettlementEvidencePayload & { evidenceHash: string }
>;

const sha256Pattern = /^[a-f0-9]{64}$/;
const canonicalIntegerPattern = /^(?:0|-?[1-9]\d*)$/;
const nonNegativeIntegerPattern = /^(?:0|[1-9]\d*)$/;

const periodsByPlan = Object.freeze({
  TWO_PERIODS: Object.freeze(['LUNCH', 'DINNER'] as const),
  THREE_PERIODS: Object.freeze(['LUNCH', 'OFF_PEAK', 'DINNER'] as const),
});

const windowsByPlan = Object.freeze({
  TWO_PERIODS: Object.freeze({
    LUNCH: Object.freeze({ start: 0, end: 9 }),
    DINNER: Object.freeze({ start: 10, end: 19 }),
  }),
  THREE_PERIODS: Object.freeze({
    LUNCH: Object.freeze({ start: 0, end: 7 }),
    OFF_PEAK: Object.freeze({ start: 8, end: 11 }),
    DINNER: Object.freeze({ start: 12, end: 19 }),
  }),
});

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function record(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function exact(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${expected.join(', ')}`);
  }
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty canonical string`);
  }
  return value;
}

function hash(value: unknown, name: string): string {
  const parsed = string(value, name);
  if (!sha256Pattern.test(parsed)) throw new Error(`${name} must be a lowercase SHA-256 value`);
  return parsed;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function parseMoney(value: unknown, name: string, currency?: string): Money {
  record(value, name);
  exact(value, ['currency', 'minorUnits'], name);
  const parsedCurrency = string(value.currency, `${name}.currency`);
  if (currency !== undefined && parsedCurrency !== currency) {
    throw new Error(`${name} must use ${currency}`);
  }
  if (typeof value.minorUnits !== 'string' || !nonNegativeIntegerPattern.test(value.minorUnits)) {
    throw new Error(`${name}.minorUnits must be a non-negative canonical integer`);
  }
  return createMoney(parsedCurrency, value.minorUnits);
}

function moneyUnits(value: Money): bigint {
  return BigInt(value.minorUnits);
}

function money(currency: string, units: bigint): Money {
  return createMoney(currency, units.toString());
}

function evidenceMoneyUnits(
  value: unknown,
  name: string,
  currency?: string,
  allowNegative = false,
): Readonly<{ currency: string; units: bigint }> {
  record(value, name);
  exact(value, ['currency', 'minorUnits'], name);
  const parsedCurrency = string(value.currency, `${name}.currency`);
  if (currency !== undefined && parsedCurrency !== currency) {
    throw new Error(`${name} must use ${currency}`);
  }
  const pattern = allowNegative ? canonicalIntegerPattern : nonNegativeIntegerPattern;
  if (typeof value.minorUnits !== 'string' || !pattern.test(value.minorUnits)) {
    throw new Error(`${name}.minorUnits is not canonical`);
  }
  return { currency: parsedCurrency, units: BigInt(value.minorUnits) };
}

function parseOpeningAccounting(value: unknown): ServerOpeningAccountingAuthority {
  record(value, 'openingAccounting');
  exact(value, ['source', 'snapshotHash', 'cashAfterProcurement'], 'openingAccounting');
  if (value.source !== 'PERSISTED_PREOPEN_ACCOUNTING') {
    throw new Error('openingAccounting source is not server-authoritative');
  }
  return deepFreeze({
    source: value.source,
    snapshotHash: hash(value.snapshotHash, 'openingAccounting.snapshotHash'),
    cashAfterProcurement: parseMoney(
      value.cashAfterProcurement,
      'openingAccounting.cashAfterProcurement',
    ),
  });
}

function parseServedOrder(value: unknown, currency: string): ServerServedOrderFinancial {
  record(value, 'served order financial');
  exact(value, ['orderId', 'grossRevenue', 'cogs'], 'served order financial');
  return deepFreeze({
    orderId: string(value.orderId, 'served order ID'),
    grossRevenue: parseMoney(value.grossRevenue, 'served order gross revenue', currency),
    cogs: parseMoney(value.cogs, 'served order COGS', currency),
  });
}

function parsePeriodExecution(value: unknown, currency: string): ServerPeriodExecutionAuthority {
  record(value, 'period execution');
  exact(
    value,
    [
      'source',
      'ordinal',
      'periodKey',
      'inputHash',
      'resultHash',
      'ownerAssignment',
      'initiator',
      'periodWindow',
      'servedOrders',
    ],
    'period execution',
  );
  if (value.source !== 'PERSISTED_SERVICE_PERIOD_EXECUTION') {
    throw new Error('period execution source is not server-authoritative');
  }
  if (!['LUNCH', 'OFF_PEAK', 'DINNER'].includes(value.periodKey as string)) {
    throw new Error('period execution periodKey is unsupported');
  }
  if (!['KITCHEN', 'FRONT', 'NONE'].includes(value.ownerAssignment as string)) {
    throw new Error('period execution ownerAssignment is unsupported');
  }
  record(value.initiator, 'period execution initiator');
  exact(value.initiator, ['actorId', 'role'], 'period execution initiator');
  if (value.initiator.role !== 'OWNER' && value.initiator.role !== 'MANAGER') {
    throw new Error('period execution initiator role is unsupported');
  }
  record(value.periodWindow, 'period execution window');
  exact(value.periodWindow, ['start', 'end'], 'period execution window');
  if (!Array.isArray(value.servedOrders)) throw new Error('servedOrders must be an array');
  const servedOrders = value.servedOrders
    .map((entry) => parseServedOrder(entry, currency))
    .sort((left, right) => left.orderId.localeCompare(right.orderId));
  if (new Set(servedOrders.map((entry) => entry.orderId)).size !== servedOrders.length) {
    throw new Error('served order IDs must be unique within a period');
  }
  return deepFreeze({
    source: value.source,
    ordinal: integer(value.ordinal, 'period execution ordinal', 1),
    periodKey: value.periodKey as MvpFirstDayServicePeriod,
    inputHash: hash(value.inputHash, 'period execution inputHash'),
    resultHash: hash(value.resultHash, 'period execution resultHash'),
    ownerAssignment: value.ownerAssignment as MvpFirstDayOwnerAssignment,
    initiator: deepFreeze({
      actorId: string(value.initiator.actorId, 'period execution initiator actorId'),
      role: value.initiator.role,
    }),
    periodWindow: deepFreeze({
      start: integer(value.periodWindow.start, 'period execution start tick'),
      end: integer(value.periodWindow.end, 'period execution end tick'),
    }),
    servedOrders: deepFreeze(servedOrders),
  });
}

function parseNpcContract(value: unknown, currency: string): ServerNpcContractAuthority {
  record(value, 'NPC contract');
  exact(
    value,
    [
      'contractKey',
      'npcKey',
      'role',
      'capability',
      'morale',
      'salary',
      'salaryUnit',
      'shiftCoverage',
      'effectiveCompletedBusinessDay',
      'endCompletedBusinessDay',
      'bonusType',
      'bonusAmount',
      'profitShareBps',
      'termsVersion',
    ],
    'NPC contract',
  );
  if (
    (value.role !== 'KITCHEN' && value.role !== 'CASHIER') ||
    value.capability !== 'MEDIUM' ||
    (value.morale !== 'NORMAL' && value.morale !== 'LOW') ||
    value.salaryUnit !== 'PER_COMPLETED_SCHEDULED_DAY' ||
    value.shiftCoverage !== 'ALL_LOCKED_SERVICE_PERIODS' ||
    value.effectiveCompletedBusinessDay !== 1 ||
    value.endCompletedBusinessDay !== 30 ||
    value.bonusType !== 'NONE' ||
    value.profitShareBps !== 0
  ) {
    throw new Error('NPC contract is not a canonical active Day1 contract');
  }
  const bonusAmount = parseMoney(value.bonusAmount, 'NPC contract bonus amount', currency);
  if (moneyUnits(bonusAmount) !== 0n) throw new Error('Day1 NPC bonus amount must be zero');
  return deepFreeze({
    contractKey: string(value.contractKey, 'NPC contract key'),
    npcKey: string(value.npcKey, 'NPC key'),
    role: value.role,
    capability: value.capability,
    morale: value.morale,
    salary: parseMoney(value.salary, 'NPC contract salary', currency),
    salaryUnit: value.salaryUnit,
    shiftCoverage: value.shiftCoverage,
    effectiveCompletedBusinessDay: value.effectiveCompletedBusinessDay,
    endCompletedBusinessDay: value.endCompletedBusinessDay,
    bonusType: value.bonusType,
    bonusAmount,
    profitShareBps: value.profitShareBps,
    termsVersion: string(value.termsVersion, 'NPC contract termsVersion'),
  });
}

function parseLease(value: unknown, currency: string): ServerLeaseAuthority {
  record(value, 'lease authority');
  exact(
    value,
    [
      'source',
      'openingSnapshotHash',
      'leaseKey',
      'termsVersion',
      'effectiveCompletedBusinessDay',
      'endCompletedBusinessDay',
      'rentDueTiming',
      'dailyRent',
    ],
    'lease authority',
  );
  if (
    value.source !== 'PERSISTED_OPENING_LEASE' ||
    value.leaseKey !== 'lease:opening:1' ||
    value.effectiveCompletedBusinessDay !== 1 ||
    value.endCompletedBusinessDay !== 30 ||
    value.rentDueTiming !== 'DAY_END_EACH_COMPLETED_BUSINESS_DAY'
  ) {
    throw new Error('lease authority is not the canonical active Day1 lease');
  }
  return deepFreeze({
    source: value.source,
    openingSnapshotHash: hash(value.openingSnapshotHash, 'lease openingSnapshotHash'),
    leaseKey: value.leaseKey,
    termsVersion: string(value.termsVersion, 'lease termsVersion'),
    effectiveCompletedBusinessDay: value.effectiveCompletedBusinessDay,
    endCompletedBusinessDay: value.endCompletedBusinessDay,
    rentDueTiming: value.rentDueTiming,
    dailyRent: parseMoney(value.dailyRent, 'daily rent', currency),
  });
}

function parseE03DayEnd(value: unknown, currency: string): ServerE03DayEndAuthority {
  record(value, 'E03 day-end authority');
  exact(value, ['source', 'finalInventoryHash', 'perishableWaste'], 'E03 day-end authority');
  if (value.source !== 'PERSISTED_E03_DAY_END_INVENTORY') {
    throw new Error('E03 day-end source is not server-authoritative');
  }
  if (!Array.isArray(value.perishableWaste)) {
    throw new Error('E03 perishableWaste must be an array');
  }
  const perishableWaste = value.perishableWaste
    .map((entry) => {
      record(entry, 'perishable waste');
      exact(entry, ['ingredientId', 'cost'], 'perishable waste');
      return deepFreeze({
        ingredientId: string(entry.ingredientId, 'waste ingredient ID'),
        cost: parseMoney(entry.cost, 'perishable waste cost', currency),
      });
    })
    .sort((left, right) => left.ingredientId.localeCompare(right.ingredientId));
  if (new Set(perishableWaste.map((entry) => entry.ingredientId)).size !== perishableWaste.length) {
    throw new Error('perishable waste ingredient IDs must be unique');
  }
  return deepFreeze({
    source: value.source,
    finalInventoryHash: hash(value.finalInventoryHash, 'final inventory hash'),
    perishableWaste: deepFreeze(perishableWaste),
  });
}

function parseEquipmentDepreciation(
  value: unknown,
  currency: string,
): ServerEquipmentDepreciationAuthority {
  record(value, 'equipment depreciation authority');
  exact(value, ['source', 'openingSnapshotHash', 'entries'], 'equipment depreciation authority');
  if (value.source !== 'PERSISTED_OPENING_EQUIPMENT_SNAPSHOT') {
    throw new Error('equipment depreciation source is not server-authoritative');
  }
  if (!Array.isArray(value.entries)) throw new Error('equipment depreciation entries are required');
  const entries = value.entries
    .map((entry) => {
      record(entry, 'equipment depreciation entry');
      exact(
        entry,
        [
          'assetKey',
          'termsVersion',
          'depreciationMethod',
          'depreciationTiming',
          'cashImpact',
          'amount',
        ],
        'equipment depreciation entry',
      );
      if (
        entry.depreciationMethod !== 'STRAIGHT_LINE_COMPLETED_DAY' ||
        entry.depreciationTiming !== 'DAY_END_AFTER_COMPLETED_BUSINESS_DAY' ||
        entry.cashImpact !== 'NON_CASH'
      ) {
        throw new Error('equipment depreciation entry is not a supported immutable authority');
      }
      return deepFreeze({
        assetKey: string(entry.assetKey, 'equipment depreciation assetKey'),
        termsVersion: string(entry.termsVersion, 'equipment depreciation termsVersion'),
        depreciationMethod: entry.depreciationMethod,
        depreciationTiming: entry.depreciationTiming,
        cashImpact: entry.cashImpact,
        amount: parseMoney(entry.amount, 'equipment depreciation amount', currency),
      });
    })
    .sort((left, right) => left.assetKey.localeCompare(right.assetKey));
  if (new Set(entries.map((entry) => entry.assetKey)).size !== entries.length) {
    throw new Error('equipment depreciation asset keys must be unique');
  }
  return deepFreeze({
    source: value.source,
    openingSnapshotHash: hash(
      value.openingSnapshotHash,
      'equipment depreciation openingSnapshotHash',
    ),
    entries: deepFreeze(entries),
  });
}

function parseDerivedMvpFirstDaySettlementAuthority(
  value: unknown,
): DerivedMvpFirstDaySettlementAuthority {
  record(value, 'MVP first-day settlement authority');
  exact(
    value,
    [
      'version',
      'businessDay',
      'simulationRuleVersion',
      'servicePeriodPlan',
      'openingSnapshotHash',
      'openingAccounting',
      'periodExecutions',
      'npcContracts',
      'lease',
      'e03DayEnd',
      'equipmentDepreciation',
    ],
    'MVP first-day settlement authority',
  );
  if (value.version !== MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION || value.businessDay !== 1) {
    throw new Error('MVP first-day settlement policy version or business day is unsupported');
  }
  if (value.servicePeriodPlan !== 'TWO_PERIODS' && value.servicePeriodPlan !== 'THREE_PERIODS') {
    throw new Error('MVP first-day service period plan is unsupported');
  }
  const openingSnapshotHash = hash(value.openingSnapshotHash, 'openingSnapshotHash');
  const openingAccounting = parseOpeningAccounting(value.openingAccounting);
  const currency = openingAccounting.cashAfterProcurement.currency;
  if (!Array.isArray(value.periodExecutions) || !Array.isArray(value.npcContracts)) {
    throw new Error('periodExecutions and npcContracts must be arrays');
  }
  const periodExecutions = value.periodExecutions
    .map((entry) => parsePeriodExecution(entry, currency))
    .sort((left, right) => left.ordinal - right.ordinal);
  const npcContracts = value.npcContracts
    .map((entry) => parseNpcContract(entry, currency))
    .sort((left, right) => left.contractKey.localeCompare(right.contractKey));
  const lease = parseLease(value.lease, currency);
  const e03DayEnd = parseE03DayEnd(value.e03DayEnd, currency);
  const equipmentDepreciation = parseEquipmentDepreciation(value.equipmentDepreciation, currency);
  if (
    lease.openingSnapshotHash !== openingSnapshotHash ||
    equipmentDepreciation.openingSnapshotHash !== openingSnapshotHash
  ) {
    throw new Error('settlement authorities do not share the same opening snapshot');
  }
  if (
    new Set(npcContracts.map((entry) => entry.contractKey)).size !== npcContracts.length ||
    new Set(npcContracts.map((entry) => entry.npcKey)).size !== npcContracts.length
  ) {
    throw new Error('NPC contract and NPC keys must be unique');
  }
  const orderIds = periodExecutions.flatMap((period) =>
    period.servedOrders.map((order) => order.orderId),
  );
  if (new Set(orderIds).size !== orderIds.length) {
    throw new Error('served order IDs must be unique across the business day');
  }

  const plan = value.servicePeriodPlan;
  const expectedPeriods = periodsByPlan[plan];
  if (
    periodExecutions.length !== expectedPeriods.length ||
    periodExecutions.some(
      (period, index) =>
        period.ordinal !== index + 1 || period.periodKey !== expectedPeriods[index],
    )
  ) {
    throw new Error('period executions must be the complete canonical Day1 plan');
  }
  for (const period of periodExecutions) {
    const expectedWindow =
      windowsByPlan[plan][period.periodKey as keyof (typeof windowsByPlan)[typeof plan]];
    if (
      expectedWindow === undefined ||
      period.periodWindow.start !== expectedWindow.start ||
      period.periodWindow.end !== expectedWindow.end
    ) {
      throw new Error('period execution window does not match the canonical Day1 schedule');
    }
  }

  return deepFreeze({
    version: value.version,
    businessDay: value.businessDay,
    simulationRuleVersion: string(value.simulationRuleVersion, 'simulationRuleVersion'),
    servicePeriodPlan: plan,
    openingSnapshotHash,
    openingAccounting,
    periodExecutions: deepFreeze(periodExecutions),
    npcContracts: deepFreeze(npcContracts),
    lease,
    e03DayEnd,
    equipmentDepreciation,
  });
}

function settlementEvidenceHash(payload: MvpFirstDaySettlementEvidencePayload): string {
  return hashReleaseEvidenceEvents([
    {
      sequence: 0,
      simulationRuleVersion: payload.simulationRuleVersion,
      type: MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION,
      payload: payload as unknown as CanonicalEvidenceValue,
    },
  ]);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalizeReleaseEvidence(left) === canonicalizeReleaseEvidence(right);
}

function deterministicPrivateId(kind: string, ...parts: readonly string[]): string {
  const digest = hashReleaseEvidenceEvents([
    {
      sequence: 0,
      simulationRuleVersion: MVP_FIRST_DAY_SETTLEMENT_SIMULATION_RULE,
      type: `private-id:${kind}`,
      payload: parts as unknown as CanonicalEvidenceValue,
    },
  ]);
  return `${kind}:${digest}`;
}

export function resolveMvpFirstDaySettlementSimulationRule(value: unknown): Readonly<{
  simulationRuleVersion: typeof MVP_FIRST_DAY_SETTLEMENT_SIMULATION_RULE;
  settlementPolicyVersion: MvpFirstDaySettlementPolicyVersion;
}> {
  if (value !== MVP_FIRST_DAY_SETTLEMENT_SIMULATION_RULE) {
    throw new Error('unknown first-day settlement simulation rule; fallback is prohibited');
  }
  return Object.freeze({
    simulationRuleVersion: MVP_FIRST_DAY_SETTLEMENT_SIMULATION_RULE,
    settlementPolicyVersion: MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION,
  });
}

function assertLockedRecordBoundary(value: unknown): MvpFirstDaySettlementLockedRecords {
  record(value, 'MVP first-day settlement locked records');
  exact(
    value,
    ['policyVersion', 'businessDay', 'openAuthority', 'executions', 'e03'],
    'MVP first-day settlement locked records',
  );
  if (value.policyVersion !== MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION || value.businessDay !== 1) {
    throw new Error('locked settlement record policy version or business day is unsupported');
  }
  record(value.openAuthority, 'locked open authority');
  exact(
    value.openAuthority,
    ['save', 'businessDay', 'preopenSnapshot', 'inventoryPoolAuthorities'],
    'locked open authority',
  );
  if (!Array.isArray(value.executions)) throw new Error('locked executions must be an array');
  record(value.e03, 'locked E03 records');
  exact(
    value.e03,
    [
      'openingInventory',
      'finalInventoryBeforeWaste',
      'periodOutcomes',
      'inventoryStocks',
      'inventoryAudits',
    ],
    'locked E03 records',
  );
  if (
    !Array.isArray(value.e03.periodOutcomes) ||
    !Array.isArray(value.e03.inventoryStocks) ||
    !Array.isArray(value.e03.inventoryAudits)
  ) {
    throw new Error('locked E03 outcome, stock, and audit records must be arrays');
  }
  return value as unknown as MvpFirstDaySettlementLockedRecords;
}

function assertCanonicalOpeningInventory(
  inventory: InventoryState,
  envelope: ReturnType<typeof validateCanonicalOpenAuthority>['privateEnvelope'],
): void {
  assertInventoryCostPoolInvariant(inventory);
  const opening = envelope.inventoryProcurement;
  if (
    inventory.currency !== opening.openingStocks[0]?.costPool.currency ||
    !canonicalEqual(inventory.capacity, opening.capacity) ||
    !canonicalEqual(inventory.stocks, opening.openingStocks) ||
    !canonicalEqual(inventory.orderReservations, opening.openingReservations) ||
    !canonicalEqual(inventory.reservedUndelivered, opening.reservedUndelivered)
  ) {
    throw new Error('locked E03 opening inventory does not match the immutable pre-open snapshot');
  }
  if (inventory.transactions.length !== inventory.stocks.length) {
    throw new Error('locked E03 opening inventory receipts are incomplete');
  }
  for (const [index, stock] of inventory.stocks.entries()) {
    const transaction = inventory.transactions[index];
    if (
      transaction === undefined ||
      transaction.sequence !== index + 1 ||
      transaction.type !== 'RECEIPT' ||
      transaction.ingredientId !== stock.ingredientId ||
      transaction.quantityPoints !== stock.onHandPoints ||
      !canonicalEqual(transaction.amount, stock.costPool) ||
      transaction.referenceId !== envelope.preopenSnapshotId
    ) {
      throw new Error('locked E03 opening receipt does not reconcile to pre-open stock');
    }
  }
}

function validateExecutionRecords(
  records: MvpFirstDaySettlementLockedRecords,
  envelope: ReturnType<typeof validateCanonicalOpenAuthority>['privateEnvelope'],
): readonly PersistedAdvanceExecution[] {
  const plan = records.openAuthority.save.servicePeriodPlan;
  const expectedPeriods = periodsByPlan[plan];
  if (records.executions.length !== expectedPeriods.length) {
    throw new Error('settlement requires every canonical Day1 service-period execution');
  }
  const openingSnapshot = records.openAuthority.save.openingSnapshot;
  const catalog = resolveMvpFirstDayCatalog(MVP_FIRST_DAY_CATALOG_VERSIONS, {
    code: openingSnapshot.settlementCurrency.code,
    metadataVersion: openingSnapshot.currencyMetadataVersion,
  });
  const activeRecipeIds = envelope.menu.items.map((item) => item.recipeVersionId);
  const recipeVersions = catalog.recipeCatalog.filter((recipe) =>
    activeRecipeIds.includes(recipe.id),
  );
  if (recipeVersions.length !== activeRecipeIds.length) {
    throw new Error('locked menu recipes do not resolve to the canonical first-day catalog');
  }
  const enabledSubstitutionIds = new Set(
    envelope.menu.items.flatMap((item) => item.enabledSubstitutionIds),
  );
  const enabledSubstitutions = catalog.substitutionCatalog.filter((substitution) =>
    enabledSubstitutionIds.has(substitution.id),
  );
  if (enabledSubstitutions.length !== enabledSubstitutionIds.size) {
    throw new Error('locked menu substitutions do not resolve to the canonical first-day catalog');
  }
  const recipes: readonly RecipeServiceSnapshot[] = recipeVersions.map((recipe) => {
    const item = envelope.menu.items.find((candidate) => candidate.recipeVersionId === recipe.id)!;
    const recommendedPrice = Number(item.basePrice.minorUnits);
    const salePrice = Number(item.salePrice.minorUnits);
    if (!Number.isSafeInteger(recommendedPrice) || !Number.isSafeInteger(salePrice)) {
      throw new Error('locked menu price exceeds the supported deterministic simulation range');
    }
    return Object.freeze({
      id: recipe.id,
      baseQuality: recipe.baseQuality,
      substitutionQualityDelta: 0,
      recommendedPrice,
      salePrice,
      portions: 0,
    });
  });
  const equipment = openingSnapshot.equipmentBundles[0];
  if (equipment === undefined || openingSnapshot.equipmentBundles.length !== 1) {
    throw new Error('completed Day1 execution requires one immutable E01 equipment bundle');
  }
  let previous: AdvanceServicePeriodResultSnapshot | undefined;
  for (const [index, execution] of records.executions.entries()) {
    record(execution, 'locked service-period execution');
    exact(
      execution,
      [
        'id',
        'ordinal',
        'periodKey',
        'commandId',
        'simulationRuleVersion',
        'inputSnapshot',
        'inputHash',
        'resultSnapshot',
        'resultHash',
      ],
      'locked service-period execution',
    );
    const replayed = replayAdvanceServicePeriod(execution.inputSnapshot);
    const periodGroups = envelope.demandSchedule.groups.filter(
      (group) => group.period === expectedPeriods[index],
    );
    const activeGuests = periodGroups.reduce((total, group) => total + group.size, 0);
    const floorFlowServiceProfile = deriveFloorFlowServiceProfile(envelope.layout, {
      seatedGuests: 0,
      waitingGroups: 0,
      activeGuests,
      demandGroups: Math.max(1, periodGroups.length),
    });
    const expectedInput = createAdvanceServicePeriodInput(
      {
        businessDay: 1,
        expectedPeriodKey: expectedPeriods[index]!,
        ownerAssignment: execution.inputSnapshot.ownerAssignment,
      },
      {
        businessDay: 1,
        servicePeriodPlan: plan,
        initiator: execution.inputSnapshot.initiator,
        npcContracts: openingSnapshot.npcContracts,
        demandSchedule: envelope.demandSchedule,
        recipes,
        inventoryState: previous?.inventoryState ?? records.e03.openingInventory,
        recipeVersions,
        enabledSubstitutions,
        equipment: { kitchen: equipment.condition, front: equipment.condition },
        kitchenExecutionQualityModifier: 0,
        floorFlowServiceProfile,
        openingReputation: previous === undefined ? openingSnapshot.reputation : undefined,
        previousResult: previous,
      },
    );
    if (
      execution.ordinal !== index + 1 ||
      execution.periodKey !== expectedPeriods[index] ||
      execution.simulationRuleVersion !== MVP_FIRST_DAY_SETTLEMENT_SIMULATION_RULE ||
      execution.inputHash !== execution.inputSnapshot.inputHash ||
      execution.resultHash !== execution.resultSnapshot.resultHash ||
      execution.inputSnapshot.previousResultHash !== (previous?.resultHash ?? null) ||
      execution.inputSnapshot.ownerAssignment !== execution.resultSnapshot.ownerAssignment ||
      !canonicalEqual(expectedInput, execution.inputSnapshot) ||
      !canonicalEqual(replayed, execution.resultSnapshot)
    ) {
      throw new Error(
        'locked service-period execution chain or authority provenance is forged or noncanonical',
      );
    }
    previous = execution.resultSnapshot;
  }
  return records.executions;
}

function assertPersistedE03Records(
  records: MvpFirstDaySettlementLockedRecords,
  executions: readonly PersistedAdvanceExecution[],
): void {
  const e03 = records.e03;
  assertInventoryCostPoolInvariant(e03.openingInventory);
  assertInventoryCostPoolInvariant(e03.finalInventoryBeforeWaste);
  if (
    !canonicalEqual(executions[0]!.inputSnapshot.inventoryState, e03.openingInventory) ||
    !canonicalEqual(executions.at(-1)!.resultSnapshot.inventoryState, e03.finalInventoryBeforeWaste)
  ) {
    throw new Error('locked E03 opening/final inventory differs from immutable execution evidence');
  }
  if (e03.periodOutcomes.length !== executions.length) {
    throw new Error('locked E03 period outcome evidence is incomplete');
  }
  for (const [index, period] of e03.periodOutcomes.entries()) {
    record(period, 'locked E03 period outcomes');
    exact(period, ['ordinal', 'resultHash', 'outcomes'], 'locked E03 period outcomes');
    if (
      period.ordinal !== index + 1 ||
      period.resultHash !== executions[index]!.resultHash ||
      !canonicalEqual(period.outcomes, executions[index]!.resultSnapshot.inventoryOutcomes)
    ) {
      throw new Error('locked E03 period outcomes differ from replayed execution');
    }
  }

  const final = e03.finalInventoryBeforeWaste;
  if (e03.inventoryStocks.length !== final.stocks.length) {
    throw new Error('locked E03 persisted stock projection is incomplete');
  }
  for (const stock of final.stocks) {
    const row = e03.inventoryStocks.find(
      (candidate) => candidate.ingredientId === stock.ingredientId,
    );
    const reserved = final.reservedUndelivered
      .filter((entry) => entry.ingredientId === stock.ingredientId)
      .reduce((total, entry) => total + entry.quantityPoints, 0);
    if (row !== undefined) {
      record(row, 'locked E03 stock row');
      exact(
        row,
        [
          'id',
          'inventoryItemId',
          'ingredientId',
          'pool',
          'version',
          'onHandPoints',
          'reservedUndeliveredPoints',
          'costPoolMinor',
        ],
        'locked E03 stock row',
      );
    }
    if (
      row === undefined ||
      row.pool !== stock.pool ||
      row.onHandPoints !== stock.onHandPoints ||
      row.reservedUndeliveredPoints !== reserved ||
      row.costPoolMinor !== stock.costPool.minorUnits ||
      stock.reservedPoints !== 0
    ) {
      throw new Error('locked E03 persisted stock projection is stale');
    }
  }

  const expectedAudits = executions.flatMap((execution) => {
    const priorCount = execution.inputSnapshot.inventoryState.transactions.length;
    return execution.resultSnapshot.inventoryState.transactions
      .slice(priorCount)
      .map((transaction, commandSequence) => ({ execution, transaction, commandSequence }));
  });
  if (e03.inventoryAudits.length !== expectedAudits.length) {
    throw new Error('locked E03 inventory audit evidence is incomplete');
  }
  for (const expected of expectedAudits) {
    const audit = e03.inventoryAudits.find(
      (candidate) =>
        candidate.commandId === expected.execution.commandId &&
        candidate.commandSequence === expected.commandSequence &&
        candidate.ingredientId === expected.transaction.ingredientId,
    );
    if (audit !== undefined) {
      record(audit, 'locked E03 audit row');
      exact(
        audit,
        ['commandId', 'commandSequence', 'ingredientId', 'metadata'],
        'locked E03 audit row',
      );
      record(audit.metadata, 'locked E03 audit metadata');
      exact(
        audit.metadata,
        [
          'schemaVersion',
          'domainSequence',
          'domainTransactionId',
          'domainType',
          'ingredientId',
          'quantityPoints',
        ],
        'locked E03 audit metadata',
      );
    }
    if (
      audit === undefined ||
      audit.metadata.schemaVersion !== 'gameplay.service-inventory-audit/v1' ||
      audit.metadata.domainSequence !== expected.transaction.sequence ||
      audit.metadata.domainTransactionId !== expected.transaction.transactionId ||
      audit.metadata.domainType !== expected.transaction.type ||
      audit.metadata.ingredientId !== expected.transaction.ingredientId ||
      audit.metadata.quantityPoints !== expected.transaction.quantityPoints
    ) {
      throw new Error('locked E03 inventory audit differs from replayed execution');
    }
  }
}

function deriveSettlementAuthorityFromLockedRecords(
  value: unknown,
): DerivedMvpFirstDaySettlementAuthority {
  const records = assertLockedRecordBoundary(value);
  const open = records.openAuthority;
  if (open.businessDay.status !== 'SERVICE_COMPLETE') {
    throw new Error('Day1 settlement requires a SERVICE_COMPLETE business day');
  }
  resolveMvpFirstDaySettlementSimulationRule(open.save.simulationRuleVersion);
  if (
    open.businessDay.simulationRuleVersion !== MVP_FIRST_DAY_SETTLEMENT_SIMULATION_RULE ||
    open.preopenSnapshot.simulationRuleVersion !== MVP_FIRST_DAY_SETTLEMENT_SIMULATION_RULE
  ) {
    throw new Error('settlement rule authority differs across immutable records');
  }
  assertOpeningSnapshotSupported(open.save.openingSnapshot);
  const validatedOpen = validateCanonicalOpenAuthority(open);
  const envelope = validatedOpen.privateEnvelope;
  assertCanonicalOpeningInventory(records.e03.openingInventory, envelope);
  const executions = validateExecutionRecords(records, envelope);
  assertPersistedE03Records(records, executions);

  const openingSnapshot = open.save.openingSnapshot;
  const currency = openingSnapshot.settlementCurrency.code;
  const openingInventoryCost = records.e03.openingInventory.transactions.reduce(
    (total, transaction) =>
      transaction.type === 'RECEIPT' ? total + BigInt(transaction.amount.minorUnits) : total,
    0n,
  );
  const openingCash = BigInt(openingSnapshot.settlementCash.amount.minorUnits);
  if (openingInventoryCost > openingCash) {
    throw new Error('pre-open procurement exceeds immutable opening settlement cash');
  }
  const menuPriceByRecipe = new Map(
    envelope.menu.items.map((item) => [item.recipeVersionId, item.salePrice]),
  );
  const periodExecutions = executions.map((execution) => {
    const outcomeByOrder = new Map(
      execution.resultSnapshot.inventoryOutcomes.map((outcome) => [outcome.orderId, outcome]),
    );
    const servedOrders = execution.resultSnapshot.orders.map((order) => {
      if (order.state !== 'SERVED')
        throw new Error('settlement execution contains an unserved order');
      const outcome = outcomeByOrder.get(order.id);
      const salePrice = menuPriceByRecipe.get(order.recipeId);
      if (
        outcome === undefined ||
        outcome.recipeId !== order.recipeId ||
        salePrice === undefined ||
        salePrice.currency !== currency
      ) {
        throw new Error('settlement cannot derive order revenue/COGS from immutable records');
      }
      return {
        orderId: order.id,
        grossRevenue: money(currency, BigInt(salePrice.minorUnits) * BigInt(outcome.servings)),
        cogs: createMoney(currency, outcome.cogs.minorUnits),
      };
    });
    if (servedOrders.length !== outcomeByOrder.size) {
      throw new Error('settlement execution has unmatched E03 order outcomes');
    }
    return {
      source: 'PERSISTED_SERVICE_PERIOD_EXECUTION' as const,
      ordinal: execution.ordinal,
      periodKey: execution.periodKey,
      inputHash: execution.inputHash,
      resultHash: execution.resultHash,
      ownerAssignment: execution.inputSnapshot.ownerAssignment,
      initiator: execution.inputSnapshot.initiator,
      periodWindow: execution.inputSnapshot.periodWindow,
      servedOrders,
    };
  });
  const finalResultHash = executions.at(-1)!.resultHash;
  const waste = wastePerishableAtDayEnd(
    records.e03.finalInventoryBeforeWaste,
    deterministicPrivateId('day1-perishable-waste', finalResultHash),
    1,
  );
  const equipmentEntries = openingSnapshot.equipmentBundles.map((equipment) => {
    const bookValue = BigInt(equipment.bookValue.minorUnits);
    const residualValue = BigInt(equipment.residualValue.minorUnits);
    const scheduled = BigInt(equipment.depreciationPerCompletedBusinessDay.minorUnits);
    const amount =
      bookValue > residualValue
        ? [scheduled, bookValue - residualValue].sort((a, b) => (a < b ? -1 : 1))[0]!
        : 0n;
    return {
      assetKey: equipment.assetKey,
      termsVersion: equipment.termsVersion,
      depreciationMethod: equipment.depreciationMethod,
      depreciationTiming: equipment.depreciationTiming,
      cashImpact: equipment.cashImpact,
      amount: money(currency, amount),
    };
  });
  const lease = openingSnapshot.lease;
  return parseDerivedMvpFirstDaySettlementAuthority({
    version: MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION,
    businessDay: 1,
    simulationRuleVersion: MVP_FIRST_DAY_SETTLEMENT_SIMULATION_RULE,
    servicePeriodPlan: open.save.servicePeriodPlan,
    openingSnapshotHash: openingSnapshot.openingSnapshotHash,
    openingAccounting: {
      source: 'PERSISTED_PREOPEN_ACCOUNTING',
      snapshotHash: envelope.preopenSnapshotHash,
      cashAfterProcurement: money(currency, openingCash - openingInventoryCost),
    },
    periodExecutions,
    npcContracts: openingSnapshot.npcContracts,
    lease: {
      source: 'PERSISTED_OPENING_LEASE',
      openingSnapshotHash: openingSnapshot.openingSnapshotHash,
      leaseKey: lease.leaseKey,
      termsVersion: lease.termsVersion,
      effectiveCompletedBusinessDay: lease.effectiveCompletedBusinessDay,
      endCompletedBusinessDay: lease.endCompletedBusinessDay,
      rentDueTiming: lease.rentDueTiming,
      dailyRent: lease.dailyRent,
    },
    e03DayEnd: {
      source: 'PERSISTED_E03_DAY_END_INVENTORY',
      finalInventoryHash: hashReleaseEvidenceEvents([
        {
          sequence: 0,
          simulationRuleVersion: MVP_FIRST_DAY_SETTLEMENT_SIMULATION_RULE,
          type: 'mvp-first-day-final-inventory-before-waste',
          payload: records.e03.finalInventoryBeforeWaste as unknown as CanonicalEvidenceValue,
        },
      ]),
      perishableWaste: waste.wasted.map((entry) => ({
        ingredientId: entry.ingredientId,
        cost: entry.cost,
      })),
    },
    equipmentDepreciation: {
      source: 'PERSISTED_OPENING_EQUIPMENT_SNAPSHOT',
      openingSnapshotHash: openingSnapshot.openingSnapshotHash,
      entries: equipmentEntries,
    },
  });
}

/**
 * The only settlement composition entry point. It accepts immutable server records, never a
 * client command or independently supplied financial/risk/evidence amounts.
 */
export function composeMvpFirstDaySettlementEvidence(
  lockedRecords: unknown,
): MvpFirstDaySettlementEvidence {
  return composeDerivedMvpFirstDaySettlementEvidence(
    deriveSettlementAuthorityFromLockedRecords(lockedRecords),
  );
}

function fairnessWorkers(
  authority: DerivedMvpFirstDaySettlementAuthority,
): readonly SettlementFairnessWorker[] {
  const tickUnits = new Map(
    authority.periodExecutions.map((period) => [
      period.periodKey,
      period.periodWindow.end - period.periodWindow.start + 1,
    ]),
  );
  const allPeriods = authority.periodExecutions.map((period) => period.periodKey);
  const workers: SettlementFairnessWorker[] = authority.npcContracts.map((contract) => ({
    workerId: contract.npcKey,
    kind: 'NPC',
    scheduledPeriodKeys: [...allPeriods],
    fulfilledPeriodKeys: [...allPeriods],
    scheduledPeriodUnits: allPeriods.length,
    fulfilledPeriodUnits: allPeriods.length,
    scheduledTickUnits: allPeriods.reduce(
      (total, period) => total + (tickUnits.get(period) ?? 0),
      0,
    ),
    fulfilledTickUnits: allPeriods.reduce(
      (total, period) => total + (tickUnits.get(period) ?? 0),
      0,
    ),
  }));
  const humanPeriods = new Map<string, MvpFirstDayServicePeriod[]>();
  for (const period of authority.periodExecutions) {
    if (period.ownerAssignment === 'NONE') continue;
    const workerId = `player:${period.initiator.actorId}`;
    const assigned = humanPeriods.get(workerId) ?? [];
    assigned.push(period.periodKey);
    humanPeriods.set(workerId, assigned);
  }
  for (const [workerId, periods] of humanPeriods) {
    const ticks = periods.reduce((total, period) => total + (tickUnits.get(period) ?? 0), 0);
    workers.push({
      workerId,
      kind: 'HUMAN',
      scheduledPeriodKeys: [...periods],
      fulfilledPeriodKeys: [...periods],
      scheduledPeriodUnits: periods.length,
      fulfilledPeriodUnits: periods.length,
      scheduledTickUnits: ticks,
      fulfilledTickUnits: ticks,
    });
  }
  return deepFreeze(workers.sort((left, right) => left.workerId.localeCompare(right.workerId)));
}

function composeDerivedMvpFirstDaySettlementEvidence(
  value: unknown,
): MvpFirstDaySettlementEvidence {
  const authority = parseDerivedMvpFirstDaySettlementAuthority(value);
  const currency = authority.openingAccounting.cashAfterProcurement.currency;
  const servedOrders = authority.periodExecutions.flatMap((period) => period.servedOrders);
  const grossRevenue = servedOrders.reduce(
    (total, order) => total + moneyUnits(order.grossRevenue),
    0n,
  );
  const cogs = servedOrders.reduce((total, order) => total + moneyUnits(order.cogs), 0n);
  const wasteLoss = authority.e03DayEnd.perishableWaste.reduce(
    (total, entry) => total + moneyUnits(entry.cost),
    0n,
  );
  const payroll = authority.npcContracts.reduce(
    (total, contract) => total + moneyUnits(contract.salary),
    0n,
  );
  const rent = moneyUnits(authority.lease.dailyRent);
  const openingCash = moneyUnits(authority.openingAccounting.cashAfterProcurement);
  const cashBeforeE05RiskPenalty = openingCash + grossRevenue - payroll - rent;
  const operatingProfit = grossRevenue - cogs - wasteLoss - payroll - rent;
  const equipmentDepreciation = authority.equipmentDepreciation.entries.reduce(
    (total, entry) => total + moneyUnits(entry.amount),
    0n,
  );
  const zero = money(currency, 0n);
  const workers = fairnessWorkers(authority);
  const payload: MvpFirstDaySettlementEvidencePayload = deepFreeze({
    version: MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION,
    hashContractVersion: RELEASE_EVIDENCE_VERSION,
    businessDay: 1,
    simulationRuleVersion: authority.simulationRuleVersion,
    servicePeriodPlan: authority.servicePeriodPlan,
    authorityReferences: deepFreeze({
      openingSnapshotHash: authority.openingSnapshotHash,
      preopenAccountingSnapshotHash: authority.openingAccounting.snapshotHash,
      periodExecutions: deepFreeze(
        authority.periodExecutions.map((period) =>
          deepFreeze({
            ordinal: period.ordinal,
            periodKey: period.periodKey,
            inputHash: period.inputHash,
            resultHash: period.resultHash,
            servedOrders: deepFreeze(
              period.servedOrders.map((order) =>
                deepFreeze({
                  orderId: order.orderId,
                  grossRevenue: order.grossRevenue,
                  cogs: order.cogs,
                }),
              ),
            ),
          }),
        ),
      ),
      finalInventoryHash: authority.e03DayEnd.finalInventoryHash,
      leaseTermsVersion: authority.lease.termsVersion,
      equipmentTermsVersions: deepFreeze(
        authority.equipmentDepreciation.entries
          .map((entry) => entry.termsVersion)
          .sort((left, right) => left.localeCompare(right)),
      ),
    }),
    cashFlow: deepFreeze({
      openingCashAfterPreopenProcurement: authority.openingAccounting.cashAfterProcurement,
      grossServiceRevenueCollected: money(currency, grossRevenue),
      npcPayrollPaid: money(currency, payroll),
      dailyLeaseRentPaid: money(currency, rent),
      cashBeforeE05RiskPenalty: money(currency, cashBeforeE05RiskPenalty),
      preopenProcurementRecharged: false,
      cogsCashChargedAtSettlement: false,
      wasteCashChargedAtSettlement: false,
    }),
    profitAndLoss: deepFreeze({
      grossRevenue: money(currency, grossRevenue),
      cogs: money(currency, cogs),
      wasteLoss: money(currency, wasteLoss),
      payroll: money(currency, payroll),
      rent: money(currency, rent),
      operatingProfit: money(currency, operatingProfit),
      equipmentDepreciation: money(currency, equipmentDepreciation),
      equipmentDepreciationCashImpact: 'NON_CASH',
    }),
    explicitFirstDayZeroPolicy: deepFreeze({
      vat: zero,
      employerContribution: zero,
      fixedOperatingFee: zero,
      debtInstallment: zero,
      debtInterest: zero,
      overduePenalty: zero,
    }),
    payrollEntries: deepFreeze(
      authority.npcContracts.map((contract) =>
        deepFreeze({
          contractKey: contract.contractKey,
          npcKey: contract.npcKey,
          amount: contract.salary,
          recognition: 'ONCE_PER_COMPLETED_SCHEDULED_DAY' as const,
        }),
      ),
    ),
    fairness: deepFreeze({
      unit: 'CANONICAL_SERVICE_PERIOD_AND_TICK',
      workers,
      scheduledPeriodUnits: workers.reduce(
        (total, worker) => total + worker.scheduledPeriodUnits,
        0,
      ),
      fulfilledPeriodUnits: workers.reduce(
        (total, worker) => total + worker.fulfilledPeriodUnits,
        0,
      ),
      scheduledTickUnits: workers.reduce((total, worker) => total + worker.scheduledTickUnits, 0),
      fulfilledTickUnits: workers.reduce((total, worker) => total + worker.fulfilledTickUnits, 0),
    }),
    riskOpeningState: deepFreeze({
      state: 'NORMAL',
      consecutiveDelinquentDays: 0,
      consecutiveResolutionDays: 0,
      delinquencyBaselineShortfall: null,
    }),
  });
  return deepFreeze({ ...payload, evidenceHash: settlementEvidenceHash(payload) });
}

function assertCanonicalSettlementEvidencePayload(
  value: Record<string, unknown>,
  plan: MvpFirstDayServicePeriodPlan,
): void {
  const simulationRuleVersion = string(
    value.simulationRuleVersion,
    'evidence simulationRuleVersion',
  );
  if (simulationRuleVersion.length === 0)
    throw new Error('evidence simulationRuleVersion is required');

  record(value.authorityReferences, 'evidence authorityReferences');
  exact(
    value.authorityReferences,
    [
      'openingSnapshotHash',
      'preopenAccountingSnapshotHash',
      'periodExecutions',
      'finalInventoryHash',
      'leaseTermsVersion',
      'equipmentTermsVersions',
    ],
    'evidence authorityReferences',
  );
  const openingSnapshotHash = hash(
    value.authorityReferences.openingSnapshotHash,
    'evidence openingSnapshotHash',
  );
  hash(value.authorityReferences.preopenAccountingSnapshotHash, 'evidence preopen accounting hash');
  hash(value.authorityReferences.finalInventoryHash, 'evidence finalInventoryHash');
  string(value.authorityReferences.leaseTermsVersion, 'evidence leaseTermsVersion');
  if (!Array.isArray(value.authorityReferences.equipmentTermsVersions)) {
    throw new Error('evidence equipmentTermsVersions must be an array');
  }
  value.authorityReferences.equipmentTermsVersions.forEach((entry, index) =>
    string(entry, `evidence equipmentTermsVersions[${index}]`),
  );
  const equipmentTermsVersions = value.authorityReferences.equipmentTermsVersions as string[];
  if (
    equipmentTermsVersions.some(
      (entry, index) => index > 0 && equipmentTermsVersions[index - 1]!.localeCompare(entry) > 0,
    )
  ) {
    throw new Error('evidence equipmentTermsVersions must be canonically sorted');
  }
  if (!Array.isArray(value.authorityReferences.periodExecutions)) {
    throw new Error('evidence periodExecutions must be an array');
  }
  const canonicalPeriods = periodsByPlan[plan];
  if (value.authorityReferences.periodExecutions.length !== canonicalPeriods.length) {
    throw new Error('evidence period executions must contain the complete Day1 plan');
  }
  const orderIds = new Set<string>();
  let evidenceRevenue = 0n;
  let evidenceCogs = 0n;
  let evidenceCurrency: string | undefined;
  value.authorityReferences.periodExecutions.forEach((period, index) => {
    record(period, 'evidence period execution');
    exact(
      period,
      ['ordinal', 'periodKey', 'inputHash', 'resultHash', 'servedOrders'],
      'evidence period execution',
    );
    if (period.ordinal !== index + 1 || period.periodKey !== canonicalPeriods[index]) {
      throw new Error('evidence period execution order is not canonical');
    }
    hash(period.inputHash, 'evidence period inputHash');
    hash(period.resultHash, 'evidence period resultHash');
    if (!Array.isArray(period.servedOrders)) {
      throw new Error('evidence servedOrders must be an array');
    }
    let previousOrderId: string | undefined;
    for (const order of period.servedOrders) {
      record(order, 'evidence served order');
      exact(order, ['orderId', 'grossRevenue', 'cogs'], 'evidence served order');
      const orderId = string(order.orderId, 'evidence served order ID');
      if (orderIds.has(orderId) || (previousOrderId !== undefined && previousOrderId >= orderId)) {
        throw new Error('evidence served order IDs must be unique and canonically ordered');
      }
      orderIds.add(orderId);
      previousOrderId = orderId;
      const revenue = evidenceMoneyUnits(
        order.grossRevenue,
        'evidence served order revenue',
        evidenceCurrency,
      );
      evidenceCurrency ??= revenue.currency;
      const cogs = evidenceMoneyUnits(order.cogs, 'evidence served order COGS', evidenceCurrency);
      evidenceRevenue += revenue.units;
      evidenceCogs += cogs.units;
    }
  });

  record(value.cashFlow, 'evidence cashFlow');
  exact(
    value.cashFlow,
    [
      'openingCashAfterPreopenProcurement',
      'grossServiceRevenueCollected',
      'npcPayrollPaid',
      'dailyLeaseRentPaid',
      'cashBeforeE05RiskPenalty',
      'preopenProcurementRecharged',
      'cogsCashChargedAtSettlement',
      'wasteCashChargedAtSettlement',
    ],
    'evidence cashFlow',
  );
  const openingCash = evidenceMoneyUnits(
    value.cashFlow.openingCashAfterPreopenProcurement,
    'evidence opening cash',
    evidenceCurrency,
  );
  evidenceCurrency ??= openingCash.currency;
  const cashRevenue = evidenceMoneyUnits(
    value.cashFlow.grossServiceRevenueCollected,
    'evidence cash revenue',
    evidenceCurrency,
  ).units;
  const cashPayroll = evidenceMoneyUnits(
    value.cashFlow.npcPayrollPaid,
    'evidence cash payroll',
    evidenceCurrency,
  ).units;
  const cashRent = evidenceMoneyUnits(
    value.cashFlow.dailyLeaseRentPaid,
    'evidence cash rent',
    evidenceCurrency,
  ).units;
  const cashBeforeRisk = evidenceMoneyUnits(
    value.cashFlow.cashBeforeE05RiskPenalty,
    'evidence cash before E05 risk penalty',
    evidenceCurrency,
    true,
  ).units;
  if (
    value.cashFlow.preopenProcurementRecharged !== false ||
    value.cashFlow.cogsCashChargedAtSettlement !== false ||
    value.cashFlow.wasteCashChargedAtSettlement !== false
  ) {
    throw new Error('evidence must not double-charge inventory cash at settlement');
  }
  if (cashBeforeRisk !== openingCash.units + cashRevenue - cashPayroll - cashRent) {
    throw new Error('evidence cash-flow arithmetic is invalid');
  }

  record(value.profitAndLoss, 'evidence profitAndLoss');
  exact(
    value.profitAndLoss,
    [
      'grossRevenue',
      'cogs',
      'wasteLoss',
      'payroll',
      'rent',
      'operatingProfit',
      'equipmentDepreciation',
      'equipmentDepreciationCashImpact',
    ],
    'evidence profitAndLoss',
  );
  const pnlRevenue = evidenceMoneyUnits(
    value.profitAndLoss.grossRevenue,
    'evidence P&L revenue',
    evidenceCurrency,
  ).units;
  const pnlCogs = evidenceMoneyUnits(
    value.profitAndLoss.cogs,
    'evidence P&L COGS',
    evidenceCurrency,
  ).units;
  const pnlWaste = evidenceMoneyUnits(
    value.profitAndLoss.wasteLoss,
    'evidence P&L waste',
    evidenceCurrency,
  ).units;
  const pnlPayroll = evidenceMoneyUnits(
    value.profitAndLoss.payroll,
    'evidence P&L payroll',
    evidenceCurrency,
  ).units;
  const pnlRent = evidenceMoneyUnits(
    value.profitAndLoss.rent,
    'evidence P&L rent',
    evidenceCurrency,
  ).units;
  const operatingProfit = evidenceMoneyUnits(
    value.profitAndLoss.operatingProfit,
    'evidence operating profit',
    evidenceCurrency,
    true,
  ).units;
  evidenceMoneyUnits(
    value.profitAndLoss.equipmentDepreciation,
    'evidence equipment depreciation',
    evidenceCurrency,
  );
  if (value.profitAndLoss.equipmentDepreciationCashImpact !== 'NON_CASH') {
    throw new Error('evidence equipment depreciation must be non-cash');
  }
  if (
    evidenceRevenue !== pnlRevenue ||
    evidenceCogs !== pnlCogs ||
    cashRevenue !== pnlRevenue ||
    cashPayroll !== pnlPayroll ||
    cashRent !== pnlRent ||
    operatingProfit !== pnlRevenue - pnlCogs - pnlWaste - pnlPayroll - pnlRent
  ) {
    throw new Error('evidence P&L arithmetic or authority reconciliation is invalid');
  }

  record(value.explicitFirstDayZeroPolicy, 'evidence explicitFirstDayZeroPolicy');
  const zeroKeys = [
    'vat',
    'employerContribution',
    'fixedOperatingFee',
    'debtInstallment',
    'debtInterest',
    'overduePenalty',
  ] as const;
  exact(value.explicitFirstDayZeroPolicy, zeroKeys, 'evidence explicitFirstDayZeroPolicy');
  for (const key of zeroKeys) {
    if (
      evidenceMoneyUnits(
        value.explicitFirstDayZeroPolicy[key],
        `evidence zero policy ${key}`,
        evidenceCurrency,
      ).units !== 0n
    ) {
      throw new Error(`evidence zero policy ${key} must be explicit zero`);
    }
  }

  if (!Array.isArray(value.payrollEntries))
    throw new Error('evidence payrollEntries must be an array');
  let payrollEntryTotal = 0n;
  let previousContractKey: string | undefined;
  const payrollNpcKeys = new Set<string>();
  for (const entry of value.payrollEntries) {
    record(entry, 'evidence payroll entry');
    exact(entry, ['contractKey', 'npcKey', 'amount', 'recognition'], 'evidence payroll entry');
    const contractKey = string(entry.contractKey, 'evidence payroll contractKey');
    const npcKey = string(entry.npcKey, 'evidence payroll npcKey');
    if (
      (previousContractKey !== undefined && previousContractKey >= contractKey) ||
      payrollNpcKeys.has(npcKey) ||
      entry.recognition !== 'ONCE_PER_COMPLETED_SCHEDULED_DAY'
    ) {
      throw new Error('evidence payroll entries are duplicated or noncanonical');
    }
    previousContractKey = contractKey;
    payrollNpcKeys.add(npcKey);
    payrollEntryTotal += evidenceMoneyUnits(
      entry.amount,
      'evidence payroll entry amount',
      evidenceCurrency,
    ).units;
  }
  if (payrollEntryTotal !== pnlPayroll)
    throw new Error('evidence payroll entries do not reconcile');

  record(value.fairness, 'evidence fairness');
  exact(
    value.fairness,
    [
      'unit',
      'workers',
      'scheduledPeriodUnits',
      'fulfilledPeriodUnits',
      'scheduledTickUnits',
      'fulfilledTickUnits',
    ],
    'evidence fairness',
  );
  if (
    value.fairness.unit !== 'CANONICAL_SERVICE_PERIOD_AND_TICK' ||
    !Array.isArray(value.fairness.workers)
  ) {
    throw new Error('evidence fairness unit or workers are invalid');
  }
  const fairnessTotals = {
    scheduledPeriods: 0,
    fulfilledPeriods: 0,
    scheduledTicks: 0,
    fulfilledTicks: 0,
  };
  let previousWorkerId: string | undefined;
  for (const worker of value.fairness.workers) {
    record(worker, 'evidence fairness worker');
    exact(
      worker,
      [
        'workerId',
        'kind',
        'scheduledPeriodKeys',
        'fulfilledPeriodKeys',
        'scheduledPeriodUnits',
        'fulfilledPeriodUnits',
        'scheduledTickUnits',
        'fulfilledTickUnits',
      ],
      'evidence fairness worker',
    );
    const workerId = string(worker.workerId, 'evidence fairness workerId');
    if (
      (previousWorkerId !== undefined && previousWorkerId >= workerId) ||
      (worker.kind !== 'NPC' && worker.kind !== 'HUMAN') ||
      !Array.isArray(worker.scheduledPeriodKeys) ||
      !Array.isArray(worker.fulfilledPeriodKeys)
    ) {
      throw new Error('evidence fairness worker is duplicated or invalid');
    }
    previousWorkerId = workerId;
    const scheduledKeys = worker.scheduledPeriodKeys;
    const fulfilledKeys = worker.fulfilledPeriodKeys;
    if (
      scheduledKeys.length !== fulfilledKeys.length ||
      scheduledKeys.some(
        (period, index) =>
          period !== fulfilledKeys[index] || !canonicalPeriods.includes(period as never),
      )
    ) {
      throw new Error('evidence fairness scheduled and fulfilled periods must match canonically');
    }
    const scheduledPeriods = integer(worker.scheduledPeriodUnits, 'scheduled period units');
    const fulfilledPeriods = integer(worker.fulfilledPeriodUnits, 'fulfilled period units');
    const scheduledTicks = integer(worker.scheduledTickUnits, 'scheduled tick units');
    const fulfilledTicks = integer(worker.fulfilledTickUnits, 'fulfilled tick units');
    if (
      scheduledPeriods !== scheduledKeys.length ||
      fulfilledPeriods !== fulfilledKeys.length ||
      scheduledPeriods !== fulfilledPeriods ||
      scheduledTicks !== fulfilledTicks
    ) {
      throw new Error('evidence fairness units do not match completed assignments');
    }
    fairnessTotals.scheduledPeriods += scheduledPeriods;
    fairnessTotals.fulfilledPeriods += fulfilledPeriods;
    fairnessTotals.scheduledTicks += scheduledTicks;
    fairnessTotals.fulfilledTicks += fulfilledTicks;
  }
  if (
    value.fairness.scheduledPeriodUnits !== fairnessTotals.scheduledPeriods ||
    value.fairness.fulfilledPeriodUnits !== fairnessTotals.fulfilledPeriods ||
    value.fairness.scheduledTickUnits !== fairnessTotals.scheduledTicks ||
    value.fairness.fulfilledTickUnits !== fairnessTotals.fulfilledTicks
  ) {
    throw new Error('evidence fairness totals do not reconcile');
  }

  record(value.riskOpeningState, 'evidence riskOpeningState');
  exact(
    value.riskOpeningState,
    [
      'state',
      'consecutiveDelinquentDays',
      'consecutiveResolutionDays',
      'delinquencyBaselineShortfall',
    ],
    'evidence riskOpeningState',
  );
  if (
    value.riskOpeningState.state !== 'NORMAL' ||
    value.riskOpeningState.consecutiveDelinquentDays !== 0 ||
    value.riskOpeningState.consecutiveResolutionDays !== 0 ||
    value.riskOpeningState.delinquencyBaselineShortfall !== null
  ) {
    throw new Error('evidence risk opening state must be canonical NORMAL/0/0/null');
  }
}

/**
 * Verifies only canonical shape, arithmetic, and the self hash of already-produced evidence.
 * It does not prove persistence provenance and must never be used to authorize settlement.
 */
export function parseMvpFirstDaySettlementEvidenceSelfConsistency(
  value: unknown,
): MvpFirstDaySettlementEvidence {
  record(value, 'MVP first-day settlement evidence');
  exact(
    value,
    [
      'version',
      'hashContractVersion',
      'businessDay',
      'simulationRuleVersion',
      'servicePeriodPlan',
      'authorityReferences',
      'cashFlow',
      'profitAndLoss',
      'explicitFirstDayZeroPolicy',
      'payrollEntries',
      'fairness',
      'riskOpeningState',
      'evidenceHash',
    ],
    'MVP first-day settlement evidence',
  );
  if (
    value.version !== MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION ||
    value.hashContractVersion !== RELEASE_EVIDENCE_VERSION ||
    value.businessDay !== 1 ||
    (value.servicePeriodPlan !== 'TWO_PERIODS' && value.servicePeriodPlan !== 'THREE_PERIODS')
  ) {
    throw new Error('MVP first-day settlement evidence version is unsupported');
  }
  assertCanonicalSettlementEvidencePayload(value, value.servicePeriodPlan);
  const evidenceHash = hash(value.evidenceHash, 'settlement evidenceHash');
  const payload = { ...value } as Record<string, unknown>;
  delete payload.evidenceHash;
  const expected = settlementEvidenceHash(
    payload as unknown as MvpFirstDaySettlementEvidencePayload,
  );
  if (evidenceHash !== expected) throw new Error('settlement evidence hash does not match payload');
  return deepFreeze(value as unknown as MvpFirstDaySettlementEvidence);
}

export function resolveMvpFirstDaySettlementPolicy(version: unknown): Readonly<{
  version: MvpFirstDaySettlementPolicyVersion;
  compose: typeof composeMvpFirstDaySettlementEvidence;
}> {
  if (version !== MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION) {
    throw new Error('unknown MVP first-day settlement policy version');
  }
  return Object.freeze({
    version: MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION,
    compose: composeMvpFirstDaySettlementEvidence,
  });
}
