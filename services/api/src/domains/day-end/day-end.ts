import { createMoney, type Money } from '../money/money.js';

export const RISK_PENALTY_VERSION = 'e05-risk-penalty-v1' as const;
export const RISK_PENALTY_RATE = 300 as const;
export const RISK_PENALTY_DENOMINATOR = 10_000 as const;
export const RISK_PENALTY_ROUNDING = 'HALF_UP' as const;

export type FinancialRiskState = 'NORMAL' | 'DELINQUENT' | 'RESOLUTION' | 'REHAB';
export type RiskTag =
  | 'DELINQUENT'
  | 'RESOLUTION'
  | 'REHAB'
  | 'RecoveryNeeded'
  | 'ReputationCrash'
  | 'FLOW_RISK_HIGH';
export type DeferredPaymentKind = 'PAYROLL' | 'SUPPLY' | 'CONTRACT' | 'DEBT';

export type ReputationSnapshot = Readonly<{
  price: number;
  speed: number;
  quality: number;
  fairness: number;
  vibe: number;
}>;

export type RiskStateSnapshot = Readonly<{
  state: FinancialRiskState;
  consecutiveDelinquentDays: number;
  consecutiveResolutionDays: number;
  delinquencyBaselineShortfall: Money | null;
}>;

export type DayEndInput = Readonly<{
  gameId: string;
  dayIndex: number;
  cashBefore: Money;
  completedOrderReceivables: readonly Money[];
  ingredientUsageCosts: readonly Money[];
  perishableWasteCosts: readonly Money[];
  authorizedShiftWages: readonly Money[];
  rent: Money;
  fixedFees: Money;
  otherOperationalCosts: Money;
  vat: Money;
  employerTax: Money;
  maturingDebt: Money;
  currentInterest: Money;
  overduePenalty: Money;
  riskPenaltyAccruedTotalBefore: Money;
  reputation: ReputationSnapshot;
  previousRisk: RiskStateSnapshot;
  deferredPaymentKinds?: readonly DeferredPaymentKind[];
  repaymentRatio?: number;
  flowRiskHigh?: boolean;
  rehabExitApproved?: boolean;
}>;

export type RiskPenaltyCalculationSnapshot = Readonly<{
  version: typeof RISK_PENALTY_VERSION;
  base: Money;
  rate: typeof RISK_PENALTY_RATE;
  denominator: typeof RISK_PENALTY_DENOMINATOR;
  rounding: typeof RISK_PENALTY_ROUNDING;
  minimum: Money;
  amount: Money;
  accruedTotal: Money;
  currency: string;
  idempotencyKey: Readonly<{
    gameId: string;
    dayIndex: number;
    version: typeof RISK_PENALTY_VERSION;
  }>;
}>;

export type DayEndSnapshot = Readonly<{
  dayIndex: number;
  grossRevenue: Money;
  cogs: Money;
  wasteLoss: Money;
  payroll: Money;
  opex: Money;
  tax: Money;
  debtDue: Money;
  riskPenalty: Money;
  riskPenaltyCalculation: RiskPenaltyCalculationSnapshot;
  dailyNet: Money;
  resolutionComparisonShortfall: Money;
  shortfall: Money;
  cashAfter: Money;
  reputation: ReputationSnapshot;
  riskTags: readonly RiskTag[];
  riskState: RiskStateSnapshot;
  highRiskRevenueEnabled: boolean;
  leaderboardEligible: boolean;
}>;

export type RiskTransitionReason =
  | 'PAYMENT_CASH_INSUFFICIENT'
  | 'DELINQUENCY_CLEARED'
  | 'REPEATED_DELINQUENCY_WITHOUT_HALF_REDUCTION'
  | 'THREE_RESOLUTION_DAYS'
  | 'REPUTATION_CRASH'
  | 'REHAB_EXIT_APPROVED';

export type RiskTransitionEvent = Readonly<{
  sequence: number;
  type: 'RISK_STATE_TRANSITION';
  reason: RiskTransitionReason;
  precondition: Readonly<{
    state: FinancialRiskState;
    consecutiveDelinquentDays: number;
    consecutiveResolutionDays: number;
    shortfall: string;
    delinquencyBaselineShortfall: string | null;
    resolutionComparisonShortfall: string;
    repaymentRatio: number;
    minimumReputation: number;
    rehabExitApproved: boolean;
  }>;
  postcondition: Readonly<{
    state: FinancialRiskState;
    consecutiveDelinquentDays: number;
    consecutiveResolutionDays: number;
    highRiskRevenueEnabled: boolean;
    leaderboardEligible: boolean;
  }>;
}>;

export type DayEndEvent =
  | Readonly<{
      sequence: number;
      type: 'RISK_PENALTY_ACCRUED';
      idempotencyKey: Readonly<{
        gameId: string;
        dayIndex: number;
        version: typeof RISK_PENALTY_VERSION;
      }>;
      base: Money;
      amount: Money;
      accruedTotalBefore: Money;
      accruedTotalAfter: Money;
    }>
  | Readonly<{
      sequence: number;
      type: 'DAY_END_SETTLED';
      dayIndex: number;
      dailyNet: Money;
      cashAfter: Money;
    }>
  | Readonly<{
      sequence: number;
      type: 'financialRisk';
      reason: 'SHORTFALL' | 'DEFERRED_PAYMENT' | 'OUTSTANDING_REPAYMENT';
      shortfall: Money;
      delinquencyBaselineShortfall: Money | null;
      resolutionComparisonShortfall: Money;
      deferredPaymentKinds: readonly DeferredPaymentKind[];
    }>
  | Readonly<{
      sequence: number;
      type: 'RISK_TAGGED';
      tag: 'RecoveryNeeded' | 'ReputationCrash' | 'FLOW_RISK_HIGH';
      reason: string;
    }>
  | RiskTransitionEvent;

export type DayEndResult = Readonly<{
  snapshot: DayEndSnapshot;
  events: readonly DayEndEvent[];
}>;

const FINANCIAL_STATE_TAGS: Readonly<Record<FinancialRiskState, RiskTag | undefined>> =
  Object.freeze({
    NORMAL: undefined,
    DELINQUENT: 'DELINQUENT',
    RESOLUTION: 'RESOLUTION',
    REHAB: 'REHAB',
  });

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function assertInteger(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
}

function assertRatio(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
}

function assertReputation(reputation: ReputationSnapshot): void {
  for (const [dimension, value] of Object.entries(reputation)) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`${dimension} reputation must be between 0 and 100`);
    }
  }
}

function amount(money: Money, currency: string, name: string, allowNegative = false): bigint {
  if (money.currency !== currency) {
    throw new Error(`${name} must use ${currency}`);
  }
  const value = BigInt(money.minorUnits);
  if (!allowNegative && value < 0n) {
    throw new Error(`${name} must not be negative`);
  }
  return value;
}

function money(currency: string, value: bigint): Money {
  return createMoney(currency, value.toString());
}

function sum(values: readonly Money[], currency: string, name: string): bigint {
  return values.reduce((total, value, index) => {
    return total + amount(value, currency, `${name}[${index}]`);
  }, 0n);
}

function calculateRiskPenalty(base: bigint): bigint {
  if (base < 0n) {
    throw new Error('risk penalty base must not be negative');
  }
  if (base === 0n) return 0n;

  const halfUp =
    (base * BigInt(RISK_PENALTY_RATE) + BigInt(RISK_PENALTY_DENOMINATOR / 2)) /
    BigInt(RISK_PENALTY_DENOMINATOR);
  return halfUp < 1n ? 1n : halfUp;
}

function settleShortfall(baseCashAfter: bigint): Readonly<{
  riskPenalty: bigint;
  cashAfter: bigint;
  shortfall: bigint;
}> {
  const baseShortfall = baseCashAfter < 0n ? -baseCashAfter : 0n;
  const riskPenalty = calculateRiskPenalty(baseShortfall);
  const cashAfter = baseCashAfter - riskPenalty;
  return {
    riskPenalty,
    cashAfter,
    shortfall: cashAfter < 0n ? -cashAfter : 0n,
  };
}

function nextDayEffects(risk: RiskStateSnapshot): Readonly<{
  highRiskRevenueEnabled: boolean;
  leaderboardEligible: boolean;
}> {
  return {
    highRiskRevenueEnabled:
      risk.state === 'NORMAL' ||
      (risk.state === 'DELINQUENT' && risk.consecutiveDelinquentDays === 1),
    leaderboardEligible: risk.state !== 'REHAB',
  };
}

function minimumReputation(reputation: ReputationSnapshot): number {
  return Math.min(
    reputation.price,
    reputation.speed,
    reputation.quality,
    reputation.fairness,
    reputation.vibe,
  );
}

type TransitionContext = Readonly<{
  current: RiskStateSnapshot;
  shortfall: Money;
  resolutionComparisonShortfall: Money;
  deferredPaymentKinds: readonly DeferredPaymentKind[];
  repaymentRatio: number;
  minimumReputation: number;
  rehabExitApproved: boolean;
}>;

type TransitionResult = Readonly<{
  next: RiskStateSnapshot;
  reason?: RiskTransitionReason;
}>;

function nextRiskState(context: TransitionContext): TransitionResult {
  const shortfall = BigInt(context.shortfall.minorUnits);
  const resolutionComparisonShortfall = BigInt(context.resolutionComparisonShortfall.minorUnits);
  const financialRisk = shortfall > 0n || context.deferredPaymentKinds.length > 0;
  const reputationCrash = context.minimumReputation < 10;

  if (reputationCrash && context.current.state !== 'REHAB') {
    return {
      next: {
        state: 'REHAB',
        consecutiveDelinquentDays: 0,
        consecutiveResolutionDays: 0,
        delinquencyBaselineShortfall: null,
      },
      reason: 'REPUTATION_CRASH',
    };
  }

  if (context.current.state === 'REHAB') {
    if (context.rehabExitApproved && context.minimumReputation >= 15 && shortfall === 0n) {
      return {
        next: {
          state: 'NORMAL',
          consecutiveDelinquentDays: 0,
          consecutiveResolutionDays: 0,
          delinquencyBaselineShortfall: null,
        },
        reason: 'REHAB_EXIT_APPROVED',
      };
    }
    return {
      next: {
        ...context.current,
        delinquencyBaselineShortfall: null,
      },
    };
  }

  if (context.current.state === 'RESOLUTION') {
    const resolutionDays = context.current.consecutiveResolutionDays + 1;
    if (resolutionDays >= 3) {
      return {
        next: {
          state: 'REHAB',
          consecutiveDelinquentDays: 0,
          consecutiveResolutionDays: 0,
          delinquencyBaselineShortfall: null,
        },
        reason: 'THREE_RESOLUTION_DAYS',
      };
    }
    return {
      next: {
        state: 'RESOLUTION',
        consecutiveDelinquentDays: 0,
        consecutiveResolutionDays: resolutionDays,
        delinquencyBaselineShortfall: null,
      },
    };
  }

  if (context.current.state === 'DELINQUENT') {
    if (!financialRisk && context.repaymentRatio === 1) {
      return {
        next: {
          state: 'NORMAL',
          consecutiveDelinquentDays: 0,
          consecutiveResolutionDays: 0,
          delinquencyBaselineShortfall: null,
        },
        reason: 'DELINQUENCY_CLEARED',
      };
    }

    const delinquentDays = context.current.consecutiveDelinquentDays + 1;
    if (context.current.delinquencyBaselineShortfall === null) {
      throw new Error('active DELINQUENT episode requires a baseline shortfall');
    }
    const baselineShortfall = BigInt(context.current.delinquencyBaselineShortfall.minorUnits);
    const notReducedBelowHalf = resolutionComparisonShortfall * 2n >= baselineShortfall;
    if (delinquentDays >= 2 && notReducedBelowHalf) {
      return {
        next: {
          state: 'RESOLUTION',
          consecutiveDelinquentDays: 0,
          consecutiveResolutionDays: 0,
          delinquencyBaselineShortfall: null,
        },
        reason: 'REPEATED_DELINQUENCY_WITHOUT_HALF_REDUCTION',
      };
    }
    return {
      next: {
        state: 'DELINQUENT',
        consecutiveDelinquentDays: delinquentDays,
        consecutiveResolutionDays: 0,
        delinquencyBaselineShortfall: context.current.delinquencyBaselineShortfall,
      },
    };
  }

  if (financialRisk) {
    return {
      next: {
        state: 'DELINQUENT',
        consecutiveDelinquentDays: 1,
        consecutiveResolutionDays: 0,
        delinquencyBaselineShortfall: context.resolutionComparisonShortfall,
      },
      reason: 'PAYMENT_CASH_INSUFFICIENT',
    };
  }

  return {
    next: {
      state: 'NORMAL',
      consecutiveDelinquentDays: 0,
      consecutiveResolutionDays: 0,
      delinquencyBaselineShortfall: null,
    },
  };
}

function validateRiskSnapshot(snapshot: RiskStateSnapshot, currency: string): void {
  if (!['NORMAL', 'DELINQUENT', 'RESOLUTION', 'REHAB'].includes(snapshot.state)) {
    throw new Error('risk state is invalid');
  }
  assertInteger(snapshot.consecutiveDelinquentDays, 'consecutive delinquent days');
  assertInteger(snapshot.consecutiveResolutionDays, 'consecutive resolution days');
  if (snapshot.delinquencyBaselineShortfall !== null) {
    amount(snapshot.delinquencyBaselineShortfall, currency, 'delinquency baseline shortfall');
  }

  switch (snapshot.state) {
    case 'NORMAL':
    case 'REHAB':
      if (
        snapshot.consecutiveDelinquentDays !== 0 ||
        snapshot.consecutiveResolutionDays !== 0 ||
        snapshot.delinquencyBaselineShortfall !== null
      ) {
        throw new Error(`${snapshot.state} risk state cannot carry a risk streak`);
      }
      break;
    case 'DELINQUENT':
      if (
        snapshot.consecutiveDelinquentDays < 1 ||
        snapshot.consecutiveResolutionDays !== 0 ||
        snapshot.delinquencyBaselineShortfall === null
      ) {
        throw new Error('DELINQUENT risk state requires a delinquent streak and baseline');
      }
      break;
    case 'RESOLUTION':
      if (
        snapshot.consecutiveDelinquentDays !== 0 ||
        snapshot.delinquencyBaselineShortfall !== null
      ) {
        throw new Error('RESOLUTION risk state cannot carry DELINQUENT episode state');
      }
      break;
  }
}

export function settleDay(input: DayEndInput): DayEndResult {
  if (typeof input.gameId !== 'string' || input.gameId.trim().length === 0) {
    throw new Error('game id must not be empty');
  }
  assertInteger(input.dayIndex, 'day index', 1);
  assertReputation(input.reputation);
  const repaymentRatio = input.repaymentRatio ?? 0;
  assertRatio(repaymentRatio, 'repayment ratio');

  const currency = input.cashBefore.currency;
  const cashBefore = amount(input.cashBefore, currency, 'cash before', true);
  const riskPenaltyAccruedTotalBefore = amount(
    input.riskPenaltyAccruedTotalBefore,
    currency,
    'risk penalty accrued total before',
  );
  validateRiskSnapshot(input.previousRisk, currency);

  const deferredPaymentKinds = [...new Set(input.deferredPaymentKinds ?? [])].sort();
  const validDeferredKinds: readonly DeferredPaymentKind[] = [
    'CONTRACT',
    'DEBT',
    'PAYROLL',
    'SUPPLY',
  ];
  if (deferredPaymentKinds.some((kind) => !validDeferredKinds.includes(kind))) {
    throw new Error('deferred payment kind is invalid');
  }

  const grossRevenue = sum(input.completedOrderReceivables, currency, 'receivable');
  const cogs = sum(input.ingredientUsageCosts, currency, 'ingredient usage cost');
  const wasteLoss = sum(input.perishableWasteCosts, currency, 'perishable waste cost');
  const payroll = sum(input.authorizedShiftWages, currency, 'authorized shift wage');
  const opex =
    amount(input.rent, currency, 'rent') +
    amount(input.fixedFees, currency, 'fixed fees') +
    amount(input.otherOperationalCosts, currency, 'other operational costs');
  const tax =
    amount(input.vat, currency, 'VAT') + amount(input.employerTax, currency, 'employer tax');
  const overduePenalty = amount(input.overduePenalty, currency, 'overdue penalty');
  const debtDue =
    overduePenalty +
    (input.dayIndex % 5 === 0
      ? amount(input.maturingDebt, currency, 'maturing debt') +
        amount(input.currentInterest, currency, 'current interest')
      : 0n);
  if (input.dayIndex % 5 !== 0) {
    amount(input.maturingDebt, currency, 'maturing debt');
    amount(input.currentInterest, currency, 'current interest');
  }

  const operatingProfit = grossRevenue - cogs - wasteLoss - payroll - opex - tax;
  const baseDailyNet = operatingProfit - debtDue;
  const baseCashAfter = cashBefore + baseDailyNet;
  const resolutionComparisonShortfall = money(currency, baseCashAfter < 0n ? -baseCashAfter : 0n);
  const settlement = settleShortfall(baseCashAfter);
  const dailyNet = baseDailyNet - settlement.riskPenalty;
  const riskPenaltyAccruedTotalAfter = riskPenaltyAccruedTotalBefore + settlement.riskPenalty;
  const riskPenaltyIdempotencyKey = {
    gameId: input.gameId,
    dayIndex: input.dayIndex,
    version: RISK_PENALTY_VERSION,
  } as const;

  const shortfallMoney = money(currency, settlement.shortfall);
  const minimum = minimumReputation(input.reputation);
  const transition = nextRiskState({
    current: input.previousRisk,
    shortfall: shortfallMoney,
    resolutionComparisonShortfall,
    deferredPaymentKinds,
    repaymentRatio,
    minimumReputation: minimum,
    rehabExitApproved: input.rehabExitApproved ?? false,
  });
  // These flags are persisted atomically by day end and become the opening gates for the next day.
  // They never rewrite the just-settled day or alter the core accounting formula.
  const stateEffects = nextDayEffects(transition.next);

  const riskTags: RiskTag[] = [];
  const financialTag = FINANCIAL_STATE_TAGS[transition.next.state];
  if (financialTag !== undefined) riskTags.push(financialTag);
  if (minimum < 15) riskTags.push('RecoveryNeeded');
  if (minimum < 10) riskTags.push('ReputationCrash');
  if (input.flowRiskHigh === true) riskTags.push('FLOW_RISK_HIGH');

  let sequence = 0;
  const events: DayEndEvent[] = [
    {
      sequence: sequence++,
      type: 'DAY_END_SETTLED',
      dayIndex: input.dayIndex,
      dailyNet: money(currency, dailyNet),
      cashAfter: money(currency, settlement.cashAfter),
    },
  ];

  if (BigInt(resolutionComparisonShortfall.minorUnits) > 0n) {
    events.push({
      sequence: sequence++,
      type: 'RISK_PENALTY_ACCRUED',
      idempotencyKey: riskPenaltyIdempotencyKey,
      base: resolutionComparisonShortfall,
      amount: money(currency, settlement.riskPenalty),
      accruedTotalBefore: money(currency, riskPenaltyAccruedTotalBefore),
      accruedTotalAfter: money(currency, riskPenaltyAccruedTotalAfter),
    });
  }

  const outstandingDelinquentRepayment =
    input.previousRisk.state === 'DELINQUENT' && repaymentRatio < 1;
  if (
    settlement.shortfall > 0n ||
    deferredPaymentKinds.length > 0 ||
    outstandingDelinquentRepayment
  ) {
    events.push({
      sequence: sequence++,
      type: 'financialRisk',
      reason:
        settlement.shortfall > 0n
          ? 'SHORTFALL'
          : deferredPaymentKinds.length > 0
            ? 'DEFERRED_PAYMENT'
            : 'OUTSTANDING_REPAYMENT',
      shortfall: shortfallMoney,
      delinquencyBaselineShortfall:
        input.previousRisk.delinquencyBaselineShortfall ??
        (transition.next.state === 'DELINQUENT'
          ? transition.next.delinquencyBaselineShortfall
          : null),
      resolutionComparisonShortfall,
      deferredPaymentKinds,
    });
  }
  if (minimum < 15) {
    events.push({
      sequence: sequence++,
      type: 'RISK_TAGGED',
      tag: 'RecoveryNeeded',
      reason: 'at least one reputation dimension is below 15',
    });
  }
  if (minimum < 10) {
    events.push({
      sequence: sequence++,
      type: 'RISK_TAGGED',
      tag: 'ReputationCrash',
      reason: 'at least one reputation dimension is below 10',
    });
  }
  if (input.flowRiskHigh === true) {
    events.push({
      sequence: sequence++,
      type: 'RISK_TAGGED',
      tag: 'FLOW_RISK_HIGH',
      reason: 'queue to demand ratio exceeded 1.2 for two consecutive ticks',
    });
  }

  if (transition.reason !== undefined) {
    events.push({
      sequence: sequence++,
      type: 'RISK_STATE_TRANSITION',
      reason: transition.reason,
      precondition: {
        state: input.previousRisk.state,
        consecutiveDelinquentDays: input.previousRisk.consecutiveDelinquentDays,
        consecutiveResolutionDays: input.previousRisk.consecutiveResolutionDays,
        shortfall: shortfallMoney.minorUnits,
        delinquencyBaselineShortfall:
          input.previousRisk.delinquencyBaselineShortfall?.minorUnits ??
          (transition.next.state === 'DELINQUENT'
            ? (transition.next.delinquencyBaselineShortfall?.minorUnits ?? null)
            : null),
        resolutionComparisonShortfall: resolutionComparisonShortfall.minorUnits,
        repaymentRatio,
        minimumReputation: minimum,
        rehabExitApproved: input.rehabExitApproved ?? false,
      },
      postcondition: {
        state: transition.next.state,
        consecutiveDelinquentDays: transition.next.consecutiveDelinquentDays,
        consecutiveResolutionDays: transition.next.consecutiveResolutionDays,
        ...stateEffects,
      },
    });
  }

  return deepFreeze({
    snapshot: {
      dayIndex: input.dayIndex,
      grossRevenue: money(currency, grossRevenue),
      cogs: money(currency, cogs),
      wasteLoss: money(currency, wasteLoss),
      payroll: money(currency, payroll),
      opex: money(currency, opex),
      tax: money(currency, tax),
      debtDue: money(currency, debtDue),
      riskPenalty: money(currency, settlement.riskPenalty),
      riskPenaltyCalculation: {
        version: RISK_PENALTY_VERSION,
        base: resolutionComparisonShortfall,
        rate: RISK_PENALTY_RATE,
        denominator: RISK_PENALTY_DENOMINATOR,
        rounding: RISK_PENALTY_ROUNDING,
        minimum: money(currency, 1n),
        amount: money(currency, settlement.riskPenalty),
        accruedTotal: money(currency, riskPenaltyAccruedTotalAfter),
        currency,
        idempotencyKey: riskPenaltyIdempotencyKey,
      },
      dailyNet: money(currency, dailyNet),
      resolutionComparisonShortfall,
      shortfall: shortfallMoney,
      cashAfter: money(currency, settlement.cashAfter),
      reputation: { ...input.reputation },
      riskTags,
      riskState: transition.next,
      ...stateEffects,
    },
    events,
  });
}
