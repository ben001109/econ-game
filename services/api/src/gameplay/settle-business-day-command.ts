import { createHash } from 'node:crypto';

import type { CanonicalEvidenceValue } from '../../../../packages/econ-game-release-evidence/index.js';

import { CommandError, type CanonicalCommandValue } from '../commands/command-contract.js';
import type {
  CommandHandler,
  LedgerPostingLineEffect,
  LedgerTransactionalEffect,
} from '../commands/command-dispatcher.js';
import {
  settleDay,
  type DayEndResult,
  type DayEndSnapshot,
  type ReputationSnapshot,
} from '../domains/day-end/day-end.js';
import {
  MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION,
  resolveMvpFirstDaySettlementPolicy,
  type MvpFirstDaySettlementEvidence,
} from '../domains/day-end/mvp-first-day-settlement-policy.js';
import {
  wastePerishableAtDayEnd,
  type DayEndWasteResult,
} from '../domains/inventory-procurement/inventory.js';
import { createMoney, type Money } from '../domains/money/money.js';
import {
  composeDayEvidence,
  type ComposedDayEvidence,
  type ComposeDayEvidenceInput,
} from './day-evidence-composer.js';
import {
  PrismaSettleBusinessDayRepository,
  type FirstDaySettlementAuthority,
} from './prisma-settle-business-day-repository.js';

export const SETTLE_BUSINESS_DAY = 'SETTLE_BUSINESS_DAY' as const;
export const BUSINESS_DAY_SETTLED_EVENT_TYPE = 'gameplay.business-day.settled' as const;
export const BUSINESS_DAY_SETTLED_EVENT_VERSION = 1 as const;

const sha256Pattern = /^[a-f0-9]{64}$/;
const nonNegativeIntegerPattern = /^(?:0|[1-9]\d*)$/;

export function parseSettleBusinessDayIntent(value: unknown): Readonly<{ businessDay: 1 }> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'businessDay') ||
    (value as Readonly<Record<string, unknown>>).businessDay !== 1
  ) {
    throw new Error('SETTLE_BUSINESS_DAY intent must contain exactly businessDay: 1');
  }
  return Object.freeze({ businessDay: 1 as const });
}

export function createSettleBusinessDayCommandHandler(): CommandHandler {
  return Object.freeze({
    commandType: SETTLE_BUSINESS_DAY,
    async execute({ context, command, currentVersion, persistence }) {
      if (command.commandType !== SETTLE_BUSINESS_DAY || command.aggregateId !== context.saveId) {
        throw new CommandError(422, 'SETTLE_COMMAND_SCOPE_INVALID');
      }
      try {
        parseSettleBusinessDayIntent(command.payload);
      } catch {
        throw new CommandError(422, 'SETTLE_BUSINESS_DAY_INTENT_INVALID');
      }

      const repository = new PrismaSettleBusinessDayRepository(persistence);
      const authority = await repository.loadFirstDaySettlementAuthority({
        restaurantId: context.tenantId,
        saveId: context.saveId,
        membershipId: context.membershipId,
        actorId: context.actorId,
      });

      let prepared: PreparedFirstDaySettlement;
      try {
        prepared = prepareFirstDaySettlement(authority, command.commandId);
      } catch (error) {
        if (error instanceof CommandError) throw error;
        throw new CommandError(503, 'SETTLEMENT_AUTHORITY_INVALID');
      }

      await repository.persistFirstDaySettlement({
        restaurantId: context.tenantId,
        saveId: context.saveId,
        businessDayId: authority.openAuthority.businessDay.id,
        commandId: command.commandId,
        simulationRuleVersion: authority.openAuthority.save.simulationRuleVersion,
        authority,
        waste: prepared.waste,
        dayEndResult: prepared.dayEndResult,
        evidence: prepared.evidence,
        dayEndSnapshotId: prepared.dayEndSnapshotId,
      });

      const aggregateVersion = currentVersion + 1;
      const publicRisk = Object.freeze({
        status: prepared.dayEndResult.snapshot.riskState.state,
        tags: Object.freeze([...prepared.dayEndResult.snapshot.riskTags]),
        highRiskRevenueEnabled: prepared.dayEndResult.snapshot.highRiskRevenueEnabled,
        leaderboardEligible: prepared.dayEndResult.snapshot.leaderboardEligible,
      });
      const reputation = Object.freeze({ ...prepared.dayEndResult.snapshot.reputation });
      const safeSummary = Object.freeze({
        ordersServed: authority.executions.reduce(
          (total, execution) =>
            total + execution.resultSnapshot.orders.filter((order) => order.state === 'SERVED').length,
          0,
        ),
        servicePeriodsCompleted: authority.executions.length,
        wasteLinesRecorded: prepared.waste.wasted.length,
      });
      const ledgerSummary = Object.freeze({
        transactionId: command.commandId,
        currency: prepared.currency,
        balanced: true,
      });
      const safeProjection = Object.freeze({
        businessDay: 1,
        businessDayId: authority.openAuthority.businessDay.id,
        status: 'SETTLED',
        dayEndSnapshotId: prepared.dayEndSnapshotId,
        eventHash: prepared.evidence.dayEnd.eventHash,
        snapshotHash: prepared.evidence.dayEnd.snapshotHash,
        summary: safeSummary,
        ledgerSummary,
        risk: publicRisk,
        reputation,
      });

      return Object.freeze({
        aggregateVersion,
        result: canonicalValue({
          competitiveSave: { id: context.saveId, version: aggregateVersion },
          ...safeProjection,
        }),
        effects: Object.freeze({
          ledger: prepared.ledger,
          outbox: Object.freeze([
            Object.freeze({
              kind: 'outbox.event/v1' as const,
              eventId: command.commandId,
              eventSequence: 0,
              eventType: BUSINESS_DAY_SETTLED_EVENT_TYPE,
              eventVersion: BUSINESS_DAY_SETTLED_EVENT_VERSION,
              payload: Object.freeze({
                schemaVersion: 'gameplay.business-day.settled/v1',
                ...safeProjection,
              }),
            }),
          ]),
        }),
      });
    },
  });
}

export type PreparedFirstDaySettlement = Readonly<{
  currency: string;
  settlementEvidence: MvpFirstDaySettlementEvidence;
  waste: DayEndWasteResult;
  dayEndResult: DayEndResult;
  evidence: ComposedDayEvidence;
  dayEndSnapshotId: string;
  ledger: LedgerTransactionalEffect;
}>;

/** Pure, pre-write projection from already-locked records. */
export function prepareFirstDaySettlement(
  authority: FirstDaySettlementAuthority,
  commandId: string,
): PreparedFirstDaySettlement {
  const policy = resolveMvpFirstDaySettlementPolicy(MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION);
  const settlementEvidence = policy.compose(Object.freeze({
    policyVersion: policy.version,
    businessDay: 1,
    openAuthority: authority.openAuthority,
    executions: authority.executions,
    e03: Object.freeze({
      openingInventory: authority.executions[0]!.inputSnapshot.inventoryState,
      finalInventoryBeforeWaste: authority.executions.at(-1)!.resultSnapshot.inventoryState,
      periodOutcomes: Object.freeze(
        authority.executions.map((execution) => Object.freeze({
          ordinal: execution.ordinal,
          resultHash: execution.resultHash,
          outcomes: execution.resultSnapshot.inventoryOutcomes,
        })),
      ),
      inventoryStocks: authority.inventoryStocks,
      inventoryAudits: authority.inventoryAudits,
    }),
  }));

  const currency = settlementEvidence.cashFlow.openingCashAfterPreopenProcurement.currency;
  const finalExecution = authority.executions.at(-1)!;
  const wasteTransactionId = privateId('day1-perishable-waste', finalExecution.resultHash);
  const waste = wastePerishableAtDayEnd(
    finalExecution.resultSnapshot.inventoryState,
    wasteTransactionId,
    1,
  );
  assertMoneyEqual(
    waste.wasteExpense,
    settlementEvidence.profitAndLoss.wasteLoss,
    'policy and E03 waste differ',
  );

  const cogs = settlementEvidence.profitAndLoss.cogs;
  const wasteLoss = settlementEvidence.profitAndLoss.wasteLoss;
  // E05 calculates P&L and cash together. Inventory was paid at PREOPEN, so this
  // bridge adds the non-cash COGS/waste recognition back to the E05 cash base.
  // E05 then subtracts those expenses once for P&L while cash remains governed by
  // the settlement policy's opening-cash + revenue - payroll - rent contract.
  const e05CashRecognitionBridge = money(
    currency,
    moneyUnits(settlementEvidence.cashFlow.openingCashAfterPreopenProcurement) +
      moneyUnits(cogs) +
      moneyUnits(wasteLoss),
  );
  const servedOrders = settlementEvidence.authorityReferences.periodExecutions.flatMap(
    (period) => period.servedOrders,
  );
  const finalReputation = finalExecution.resultSnapshot.reputation as ReputationSnapshot;
  const dayEndResult = settleDay({
    gameId: authority.openAuthority.save.id,
    dayIndex: 1,
    cashBefore: e05CashRecognitionBridge,
    completedOrderReceivables: Object.freeze(servedOrders.map((order) => order.grossRevenue)),
    ingredientUsageCosts: Object.freeze(servedOrders.map((order) => order.cogs)),
    perishableWasteCosts: Object.freeze(
      waste.wasted.map((entry) => entry.cost),
    ),
    authorizedShiftWages: Object.freeze(
      settlementEvidence.payrollEntries.map((entry) => entry.amount),
    ),
    rent: settlementEvidence.cashFlow.dailyLeaseRentPaid,
    fixedFees: settlementEvidence.explicitFirstDayZeroPolicy.fixedOperatingFee,
    otherOperationalCosts: money(currency, 0n),
    vat: settlementEvidence.explicitFirstDayZeroPolicy.vat,
    employerTax: settlementEvidence.explicitFirstDayZeroPolicy.employerContribution,
    maturingDebt: settlementEvidence.explicitFirstDayZeroPolicy.debtInstallment,
    currentInterest: settlementEvidence.explicitFirstDayZeroPolicy.debtInterest,
    overduePenalty: settlementEvidence.explicitFirstDayZeroPolicy.overduePenalty,
    riskPenaltyAccruedTotalBefore: money(currency, 0n),
    reputation: finalReputation,
    previousRisk: Object.freeze({
      state: settlementEvidence.riskOpeningState.state,
      consecutiveDelinquentDays: settlementEvidence.riskOpeningState.consecutiveDelinquentDays,
      consecutiveResolutionDays: settlementEvidence.riskOpeningState.consecutiveResolutionDays,
      delinquencyBaselineShortfall: null,
    }),
    deferredPaymentKinds: Object.freeze([]),
    repaymentRatio: 1,
    flowRiskHigh: authority.executions.some((execution) => execution.resultSnapshot.flowRiskHigh),
    rehabExitApproved: false,
  });
  assertDayEndReconciles(dayEndResult.snapshot, settlementEvidence);

  const expectedStockVersions = Object.freeze(
    Object.fromEntries(
      authority.inventoryStocks.map((stock) => [
        `inventory:${stock.ingredientId}`,
        stock.version + (waste.wasted.some((entry) => entry.ingredientId === stock.ingredientId) ? 1 : 0),
      ]),
    ),
  );
  const finalResourceVersions = Object.freeze({
    businessDay: 'SETTLED',
    openingSnapshot: authority.openAuthority.save.openingSnapshotHash,
    preopenSnapshot: authority.openAuthority.preopenSnapshot.snapshotHash,
    ...Object.fromEntries(
      authority.executions.map((execution) => [
        `servicePeriod:${execution.ordinal}`,
        execution.resultHash,
      ]),
    ),
    ...expectedStockVersions,
    riskState: 1,
    reputation: 1,
    settlementPolicy: settlementEvidence.version,
  });
  const dayEndSnapshotId = privateId('day-end-snapshot', authority.openAuthority.save.id, '1');
  const evidenceInput = buildDayEvidenceInput(
    authority,
    settlementEvidence,
    waste,
    dayEndResult,
    finalResourceVersions,
  );
  const evidence = composeDayEvidence(evidenceInput);
  const ledger = createSettlementLedger(commandId, currency, settlementEvidence, dayEndResult);
  return Object.freeze({
    currency,
    settlementEvidence,
    waste,
    dayEndResult,
    evidence,
    dayEndSnapshotId,
    ledger,
  });
}

function buildDayEvidenceInput(
  authority: FirstDaySettlementAuthority,
  settlement: MvpFirstDaySettlementEvidence,
  waste: DayEndWasteResult,
  dayEnd: DayEndResult,
  finalResourceVersions: Readonly<Record<string, string | number>>,
): ComposeDayEvidenceInput {
  const rule = authority.openAuthority.save.simulationRuleVersion;
  let sequence = 0;
  return Object.freeze({
    scope: Object.freeze({
      restaurantId: authority.restaurantId,
      saveId: authority.openAuthority.save.id,
      businessDay: 1,
    }),
    servicePeriodPlan: authority.openAuthority.save.servicePeriodPlan,
    open: descriptor(
      privateId('replay-open', authority.openAuthority.save.id, authority.openAuthority.preopenSnapshot.snapshotHash),
      sequence++,
      rule,
      {
        schemaVersion: 'gameplay.replay.business-day-opened/v1',
        openingSnapshotHash: authority.openAuthority.save.openingSnapshotHash,
        preopenSnapshotHash: authority.openAuthority.preopenSnapshot.snapshotHash,
      },
    ),
    servicePeriods: Object.freeze(
      authority.executions.map((execution) => Object.freeze({
        period: execution.periodKey,
        servicePeriodExecutionId: execution.id,
        event: descriptor(
          privateId('replay-service-period', execution.id, execution.resultHash),
          sequence++,
          rule,
          {
            schemaVersion: 'gameplay.replay.service-period-completed/v1',
            ordinal: execution.ordinal,
            periodKey: execution.periodKey,
            inputHash: execution.inputHash,
            resultHash: execution.resultHash,
            ownerAssignment: execution.inputSnapshot.ownerAssignment,
          },
        ),
      })),
    ),
    inventory: descriptor(
      privateId('replay-inventory-day-finalized', authority.openAuthority.save.id, settlement.authorityReferences.finalInventoryHash),
      sequence++,
      rule,
      {
        schemaVersion: 'gameplay.replay.inventory-day-finalized/v1',
        finalInventoryBeforeWasteHash: settlement.authorityReferences.finalInventoryHash,
        waste: waste.wasted.map((entry) => ({
          ingredientId: entry.ingredientId,
          quantityPoints: entry.quantityPoints,
          cost: entry.cost,
        })),
      },
    ),
    dayEnd: Object.freeze({
      event: descriptor(
        privateId('replay-day-end-settled', authority.openAuthority.save.id, settlement.evidenceHash),
        sequence++,
        rule,
        {
          schemaVersion: 'gameplay.replay.day-end-settled/v1',
          settlementPolicyEvidence: settlement,
          fixedFieldSnapshot: dayEnd.snapshot,
        },
      ),
      fixedFieldSnapshot: dayEnd.snapshot as unknown as ComposeDayEvidenceInput['dayEnd']['fixedFieldSnapshot'],
      finalResourceVersions,
    }),
    risk: descriptor(
      privateId('replay-risk-day-finalized', authority.openAuthority.save.id, settlement.evidenceHash),
      sequence,
      rule,
      {
        schemaVersion: 'gameplay.replay.risk-day-finalized/v1',
        events: dayEnd.events,
        riskState: dayEnd.snapshot.riskState,
        riskTags: dayEnd.snapshot.riskTags,
        highRiskRevenueEnabled: dayEnd.snapshot.highRiskRevenueEnabled,
        leaderboardEligible: dayEnd.snapshot.leaderboardEligible,
        reputation: dayEnd.snapshot.reputation,
      },
    ),
  });
}

function descriptor(
  eventId: string,
  localSequence: number,
  simulationRuleVersion: string,
  payload: unknown,
) {
  return Object.freeze({
    eventId,
    localSequence,
    simulationRuleVersion,
    payload: payload as CanonicalEvidenceValue,
  });
}

function createSettlementLedger(
  commandId: string,
  currency: string,
  settlement: MvpFirstDaySettlementEvidence,
  dayEnd: DayEndResult,
): LedgerTransactionalEffect {
  const lines: LedgerPostingLineEffect[] = [];
  const pair = (
    amount: Money,
    debitAccount: string,
    creditAccount: string,
  ) => {
    const units = moneyUnits(amount);
    if (units === 0n) return;
    if (units < 0n) throw new Error('settlement ledger cannot post a negative line');
    lines.push(
      Object.freeze({ accountCode: debitAccount, direction: 'DEBIT', amountMinor: amount.minorUnits }),
      Object.freeze({ accountCode: creditAccount, direction: 'CREDIT', amountMinor: amount.minorUnits }),
    );
  };
  pair(settlement.profitAndLoss.grossRevenue, 'CASH:SETTLEMENT', 'REVENUE:SERVICE');
  pair(settlement.profitAndLoss.cogs, 'EXPENSE:COGS', 'ASSET:INVENTORY');
  pair(settlement.profitAndLoss.wasteLoss, 'EXPENSE:WASTE', 'ASSET:INVENTORY');
  pair(settlement.profitAndLoss.payroll, 'EXPENSE:PAYROLL', 'CASH:SETTLEMENT');
  pair(settlement.profitAndLoss.rent, 'EXPENSE:RENT', 'CASH:SETTLEMENT');
  pair(
    settlement.profitAndLoss.equipmentDepreciation,
    'EXPENSE:DEPRECIATION',
    'CONTRA_ASSET:ACCUMULATED_DEPRECIATION',
  );
  pair(dayEnd.snapshot.riskPenalty, 'EXPENSE:RISK_PENALTY', 'CASH:SETTLEMENT');
  if (lines.length < 2) throw new Error('settlement ledger requires at least one balanced posting pair');
  const debit = lines
    .filter((line) => line.direction === 'DEBIT')
    .reduce((total, line) => total + BigInt(line.amountMinor), 0n);
  const credit = lines
    .filter((line) => line.direction === 'CREDIT')
    .reduce((total, line) => total + BigInt(line.amountMinor), 0n);
  if (debit !== credit || debit <= 0n) throw new Error('settlement ledger is not balanced');
  return Object.freeze({
    kind: 'ledger.posting/v1' as const,
    transactionId: commandId,
    eventId: commandId,
    currency,
    reason: 'MVP Day 1 canonical settlement',
    lines: Object.freeze(lines),
  });
}

function assertDayEndReconciles(
  snapshot: DayEndSnapshot,
  settlement: MvpFirstDaySettlementEvidence,
): void {
  const expected = settlement.profitAndLoss;
  for (const [actual, wanted, label] of [
    [snapshot.grossRevenue, expected.grossRevenue, 'gross revenue'],
    [snapshot.cogs, expected.cogs, 'COGS'],
    [snapshot.wasteLoss, expected.wasteLoss, 'waste loss'],
    [snapshot.payroll, expected.payroll, 'payroll'],
    [snapshot.opex, expected.rent, 'opex/rent'],
    [snapshot.tax, settlement.explicitFirstDayZeroPolicy.vat, 'tax'],
    [snapshot.debtDue, settlement.explicitFirstDayZeroPolicy.debtInstallment, 'debt due'],
  ] as const) {
    assertMoneyEqual(actual, wanted, `E05 ${label} differs from policy`);
  }
  const cashBeforePenalty = signedMoneyUnits(snapshot.cashAfter) + moneyUnits(snapshot.riskPenalty);
  if (cashBeforePenalty !== moneyUnits(settlement.cashFlow.cashBeforeE05RiskPenalty)) {
    throw new Error('E05 cash result double-charged or omitted a policy-authoritative cash flow');
  }
  const expectedDailyNet = signedMoneyUnits(expected.operatingProfit) - moneyUnits(snapshot.riskPenalty);
  if (signedMoneyUnits(snapshot.dailyNet) !== expectedDailyNet) {
    throw new Error('E05 daily net differs from settlement P&L and risk penalty');
  }
}

function assertMoneyEqual(actual: Money, expected: Money, message: string): void {
  if (actual.currency !== expected.currency || actual.minorUnits !== expected.minorUnits) {
    throw new Error(message);
  }
}

function money(currency: string, units: bigint): Money {
  return createMoney(currency, units.toString());
}

function moneyUnits(value: Money): bigint {
  if (!nonNegativeIntegerPattern.test(value.minorUnits)) {
    throw new Error('settlement authority money must be non-negative canonical minor units');
  }
  return BigInt(value.minorUnits);
}

function signedMoneyUnits(value: Money): bigint {
  if (!/^(?:0|-?[1-9]\d*)$/.test(value.minorUnits)) {
    throw new Error('settlement authority money must use canonical signed minor units');
  }
  return BigInt(value.minorUnits);
}

function privateId(kind: string, ...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${kind}:${digest}`;
}

function canonicalValue(value: unknown): CanonicalCommandValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(canonicalValue));
  if (typeof value === 'object') {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>);
    if (entries.some(([, nested]) => nested === undefined)) {
      throw new CommandError(503, 'SETTLEMENT_PUBLIC_PROJECTION_INVALID');
    }
    return Object.freeze(Object.fromEntries(entries.map(([key, nested]) => [key, canonicalValue(nested)])));
  }
  throw new CommandError(503, 'SETTLEMENT_PUBLIC_PROJECTION_INVALID');
}

export function assertSettleHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !sha256Pattern.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256`);
  }
  return value;
}
