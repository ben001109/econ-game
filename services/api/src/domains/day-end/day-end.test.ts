import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RISK_PENALTY_DENOMINATOR,
  RISK_PENALTY_RATE,
  RISK_PENALTY_ROUNDING,
  RISK_PENALTY_VERSION,
  settleDay,
  type DayEndInput,
  type ReputationSnapshot,
  type RiskStateSnapshot,
} from './day-end.js';
import { createMoney } from '../money/money.js';

const currency = 'TWD';
const m = (minorUnits: string) => createMoney(currency, minorUnits);
const healthyReputation: ReputationSnapshot = Object.freeze({
  price: 50,
  speed: 50,
  quality: 50,
  fairness: 50,
  vibe: 50,
});

function risk(
  state: RiskStateSnapshot['state'] = 'NORMAL',
  delinquentDays = 0,
  resolutionDays = 0,
  delinquencyBaselineShortfall: string | null = state === 'DELINQUENT' ? '0' : null,
): RiskStateSnapshot {
  return {
    state,
    consecutiveDelinquentDays: delinquentDays,
    consecutiveResolutionDays: resolutionDays,
    delinquencyBaselineShortfall:
      delinquencyBaselineShortfall === null ? null : m(delinquencyBaselineShortfall),
  };
}

function baseInput(overrides: Partial<DayEndInput> = {}): DayEndInput {
  return {
    gameId: 'game-1',
    dayIndex: 5,
    cashBefore: m('2000'),
    completedOrderReceivables: [m('1200'), m('800')],
    ingredientUsageCosts: [m('200'), m('100')],
    perishableWasteCosts: [m('100')],
    authorizedShiftWages: [m('400')],
    rent: m('100'),
    fixedFees: m('50'),
    otherOperationalCosts: m('50'),
    vat: m('150'),
    employerTax: m('50'),
    maturingDebt: m('100'),
    currentInterest: m('10'),
    overduePenalty: m('5'),
    riskPenaltyAccruedTotalBefore: m('0'),
    reputation: healthyReputation,
    previousRisk: risk(),
    ...overrides,
  };
}

function deficitInput(base: string, overrides: Partial<DayEndInput> = {}): DayEndInput {
  return baseInput({
    dayIndex: 1,
    cashBefore: m(`-${base}`),
    completedOrderReceivables: [],
    ingredientUsageCosts: [],
    perishableWasteCosts: [],
    authorizedShiftWages: [],
    rent: m('0'),
    fixedFees: m('0'),
    otherOperationalCosts: m('0'),
    vat: m('0'),
    employerTax: m('0'),
    maturingDebt: m('0'),
    currentInterest: m('0'),
    overduePenalty: m('0'),
    ...overrides,
  });
}

test('outputs every fixed report field and applies the confirmed day-end chain', () => {
  const result = settleDay(baseInput());

  assert.deepEqual(result.snapshot, {
    dayIndex: 5,
    grossRevenue: m('2000'),
    cogs: m('300'),
    wasteLoss: m('100'),
    payroll: m('400'),
    opex: m('200'),
    tax: m('200'),
    debtDue: m('115'),
    riskPenalty: m('0'),
    riskPenaltyCalculation: {
      version: RISK_PENALTY_VERSION,
      base: m('0'),
      rate: RISK_PENALTY_RATE,
      denominator: RISK_PENALTY_DENOMINATOR,
      rounding: RISK_PENALTY_ROUNDING,
      minimum: m('1'),
      amount: m('0'),
      accruedTotal: m('0'),
      currency,
      idempotencyKey: {
        gameId: 'game-1',
        dayIndex: 5,
        version: RISK_PENALTY_VERSION,
      },
    },
    dailyNet: m('685'),
    resolutionComparisonShortfall: m('0'),
    shortfall: m('0'),
    cashAfter: m('2685'),
    reputation: healthyReputation,
    riskTags: [],
    riskState: risk(),
    highRiskRevenueEnabled: true,
    leaderboardEligible: true,
  });
  assert.deepEqual(result.events, [
    {
      sequence: 0,
      type: 'DAY_END_SETTLED',
      dayIndex: 5,
      dailyNet: m('685'),
      cashAfter: m('2685'),
    },
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.snapshot.riskTags), true);
});

test('charges maturing debt only every fifth day while overdue penalty remains due daily', () => {
  const result = settleDay(baseInput({ dayIndex: 4 }));

  assert.deepEqual(result.snapshot.debtDue, m('5'));
  assert.deepEqual(result.snapshot.dailyNet, m('795'));
});

test('charges the versioned 3% HALF_UP penalty once from the pre-penalty base', () => {
  const input = baseInput({
    dayIndex: 1,
    cashBefore: m('0'),
    completedOrderReceivables: [],
    ingredientUsageCosts: [m('1000')],
    perishableWasteCosts: [],
    authorizedShiftWages: [],
    rent: m('0'),
    fixedFees: m('0'),
    otherOperationalCosts: m('0'),
    vat: m('0'),
    employerTax: m('0'),
    maturingDebt: m('0'),
    currentInterest: m('0'),
    overduePenalty: m('0'),
    riskPenaltyAccruedTotalBefore: m('200'),
  });
  const result = settleDay(input);

  assert.deepEqual(result.snapshot.riskPenalty, m('30'));
  assert.deepEqual(result.snapshot.dailyNet, m('-1030'));
  assert.deepEqual(result.snapshot.cashAfter, m('-1030'));
  assert.deepEqual(result.snapshot.shortfall, m('1030'));
  assert.deepEqual(result.snapshot.riskPenaltyCalculation, {
    version: RISK_PENALTY_VERSION,
    base: m('1000'),
    rate: 300,
    denominator: 10000,
    rounding: 'HALF_UP',
    minimum: m('1'),
    amount: m('30'),
    accruedTotal: m('230'),
    currency,
    idempotencyKey: {
      gameId: 'game-1',
      dayIndex: 1,
      version: RISK_PENALTY_VERSION,
    },
  });
  assert.deepEqual(result.snapshot.riskTags, ['DELINQUENT']);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ['DAY_END_SETTLED', 'RISK_PENALTY_ACCRUED', 'financialRisk', 'RISK_STATE_TRANSITION'],
  );
  assert.deepEqual(result.events[1], {
    sequence: 1,
    type: 'RISK_PENALTY_ACCRUED',
    idempotencyKey: {
      gameId: 'game-1',
      dayIndex: 1,
      version: RISK_PENALTY_VERSION,
    },
    base: m('1000'),
    amount: m('30'),
    accruedTotalBefore: m('200'),
    accruedTotalAfter: m('230'),
  });
  assert.deepEqual(result.events[2], {
    sequence: 2,
    type: 'financialRisk',
    reason: 'SHORTFALL',
    shortfall: m('1030'),
    delinquencyBaselineShortfall: m('1000'),
    resolutionComparisonShortfall: m('1000'),
    deferredPaymentKinds: [],
  });
  assert.deepEqual(result.events[3], {
    sequence: 3,
    type: 'RISK_STATE_TRANSITION',
    reason: 'PAYMENT_CASH_INSUFFICIENT',
    precondition: {
      state: 'NORMAL',
      consecutiveDelinquentDays: 0,
      consecutiveResolutionDays: 0,
      shortfall: '1030',
      delinquencyBaselineShortfall: '1000',
      resolutionComparisonShortfall: '1000',
      repaymentRatio: 0,
      minimumReputation: 50,
      rehabExitApproved: false,
    },
    postcondition: {
      state: 'DELINQUENT',
      consecutiveDelinquentDays: 1,
      consecutiveResolutionDays: 0,
      highRiskRevenueEnabled: true,
      leaderboardEligible: true,
    },
  });
});

test('applies HALF_UP boundaries and the one-minor-unit minimum only to positive bases', () => {
  const zero = settleDay(baseInput());
  const one = settleDay(deficitInput('1'));
  const belowHalfUp = settleDay(deficitInput('149'));
  const atHalfUp = settleDay(deficitInput('150'));

  assert.equal(zero.snapshot.riskPenalty.minorUnits, '0');
  assert.equal(
    zero.events.some((event) => event.type === 'RISK_PENALTY_ACCRUED'),
    false,
  );
  assert.equal(one.snapshot.riskPenalty.minorUnits, '1');
  assert.equal(belowHalfUp.snapshot.riskPenalty.minorUnits, '4');
  assert.equal(atHalfUp.snapshot.riskPenalty.minorUnits, '5');
});

test('charges positive bases in DELINQUENT, RESOLUTION, and REHAB without compounding history', () => {
  const inputs = [
    deficitInput('1000', {
      previousRisk: risk('DELINQUENT', 1, 0, '5000'),
      riskPenaltyAccruedTotalBefore: m('99999'),
    }),
    deficitInput('1000', {
      previousRisk: risk('RESOLUTION', 0, 0, null),
      riskPenaltyAccruedTotalBefore: m('99999'),
    }),
    deficitInput('1000', {
      previousRisk: risk('REHAB', 0, 0, null),
      riskPenaltyAccruedTotalBefore: m('99999'),
    }),
  ];

  for (const input of inputs) {
    const result = settleDay(input);
    assert.equal(result.snapshot.riskPenaltyCalculation.base.minorUnits, '1000');
    assert.equal(result.snapshot.riskPenalty.minorUnits, '30');
    assert.equal(result.snapshot.riskPenaltyCalculation.accruedTotal.minorUnits, '100029');
    assert.equal(result.events.filter((event) => event.type === 'RISK_PENALTY_ACCRUED').length, 1);
  }
});

test('retries and replays expose the same unique accrual tuple without duplicating the event', () => {
  const input = deficitInput('1000', {
    gameId: 'game-retry',
    dayIndex: 7,
    riskPenaltyAccruedTotalBefore: m('200'),
  });
  const first = settleDay(input);
  const replay = settleDay(input);

  assert.equal(JSON.stringify(first), JSON.stringify(replay));
  const accruals = first.events.filter((event) => event.type === 'RISK_PENALTY_ACCRUED');
  assert.equal(accruals.length, 1);
  assert.deepEqual(accruals[0]?.idempotencyKey, {
    gameId: 'game-retry',
    dayIndex: 7,
    version: 'e05-risk-penalty-v1',
  });
  assert.equal(accruals[0]?.accruedTotalBefore.minorUnits, '200');
  assert.equal(accruals[0]?.accruedTotalAfter.minorUnits, '230');
});

test('tracks deferred payments even when closing cash is non-negative', () => {
  const result = settleDay(baseInput({ deferredPaymentKinds: ['SUPPLY', 'PAYROLL', 'SUPPLY'] }));

  assert.equal(result.snapshot.riskState.state, 'DELINQUENT');
  assert.equal(result.snapshot.riskState.consecutiveDelinquentDays, 1);
  assert.equal(result.snapshot.highRiskRevenueEnabled, true);
  assert.deepEqual(result.events[1], {
    sequence: 1,
    type: 'financialRisk',
    reason: 'DEFERRED_PAYMENT',
    shortfall: m('0'),
    delinquencyBaselineShortfall: m('0'),
    resolutionComparisonShortfall: m('0'),
    deferredPaymentKinds: ['PAYROLL', 'SUPPLY'],
  });
});

test('moves DELINQUENT to NORMAL only after full repayment and non-negative closing cash', () => {
  const result = settleDay(
    baseInput({
      previousRisk: risk('DELINQUENT', 1, 0, '100'),
      repaymentRatio: 1,
    }),
  );

  assert.equal(result.snapshot.riskState.state, 'NORMAL');
  assert.equal(result.snapshot.riskState.delinquencyBaselineShortfall, null);
  assert.equal(result.snapshot.highRiskRevenueEnabled, true);
  const transition = result.events.at(-1);
  assert.equal(transition?.type, 'RISK_STATE_TRANSITION');
  assert.equal(
    transition?.type === 'RISK_STATE_TRANSITION' ? transition.reason : undefined,
    'DELINQUENCY_CLEARED',
  );
});

test('keeps the episode active when final shortfall is zero but repayment is incomplete', () => {
  const result = settleDay(
    baseInput({
      previousRisk: risk('DELINQUENT', 1, 0, '1000'),
      repaymentRatio: 0.5,
    }),
  );

  assert.equal(result.snapshot.shortfall.minorUnits, '0');
  assert.equal(result.snapshot.resolutionComparisonShortfall.minorUnits, '0');
  assert.equal(result.snapshot.riskState.state, 'DELINQUENT');
  assert.equal(result.snapshot.riskState.consecutiveDelinquentDays, 2);
  assert.equal(result.snapshot.riskState.delinquencyBaselineShortfall?.minorUnits, '1000');
  assert.equal(result.snapshot.highRiskRevenueEnabled, false);
  assert.equal(result.events[1]?.type, 'financialRisk');
  assert.equal(
    result.events[1]?.type === 'financialRisk' ? result.events[1].reason : undefined,
    'OUTSTANDING_REPAYMENT',
  );
});

test('moves the second unresolved delinquent day to RESOLUTION at exactly half the episode baseline', () => {
  const result = settleDay(
    baseInput({
      dayIndex: 1,
      cashBefore: m('-100'),
      completedOrderReceivables: [],
      ingredientUsageCosts: [],
      perishableWasteCosts: [],
      authorizedShiftWages: [],
      rent: m('0'),
      fixedFees: m('0'),
      otherOperationalCosts: m('0'),
      vat: m('0'),
      employerTax: m('0'),
      maturingDebt: m('0'),
      currentInterest: m('0'),
      overduePenalty: m('0'),
      previousRisk: risk('DELINQUENT', 1, 0, '200'),
    }),
  );

  assert.equal(result.snapshot.riskState.state, 'RESOLUTION');
  assert.equal(result.snapshot.riskState.consecutiveDelinquentDays, 0);
  assert.equal(result.snapshot.riskState.consecutiveResolutionDays, 0);
  assert.equal(result.snapshot.riskState.delinquencyBaselineShortfall, null);
  assert.equal(result.snapshot.highRiskRevenueEnabled, false);
  const transition = result.events.at(-1);
  assert.equal(transition?.type, 'RISK_STATE_TRANSITION');
  assert.equal(
    transition?.type === 'RISK_STATE_TRANSITION' ? transition.reason : undefined,
    'REPEATED_DELINQUENCY_WITHOUT_HALF_REDUCTION',
  );
});

test('keeps the immutable episode baseline and DELINQUENT state when current is strictly below half', () => {
  const result = settleDay(
    baseInput({
      dayIndex: 1,
      cashBefore: m('-96'),
      completedOrderReceivables: [],
      ingredientUsageCosts: [],
      perishableWasteCosts: [],
      authorizedShiftWages: [],
      rent: m('0'),
      fixedFees: m('0'),
      otherOperationalCosts: m('0'),
      vat: m('0'),
      employerTax: m('0'),
      maturingDebt: m('0'),
      currentInterest: m('0'),
      overduePenalty: m('0'),
      previousRisk: risk('DELINQUENT', 1, 0, '200'),
    }),
  );

  assert.equal(result.snapshot.shortfall.minorUnits, '99');
  assert.equal(result.snapshot.resolutionComparisonShortfall.minorUnits, '96');
  assert.equal(result.snapshot.riskState.state, 'DELINQUENT');
  assert.equal(result.snapshot.riskState.consecutiveDelinquentDays, 2);
  assert.equal(result.snapshot.riskState.delinquencyBaselineShortfall?.minorUnits, '200');
  assert.equal(result.snapshot.highRiskRevenueEnabled, false);
  const financialRisk = result.events.find((event) => event.type === 'financialRisk');
  assert.equal(financialRisk?.delinquencyBaselineShortfall?.minorUnits, '200');
  assert.equal(financialRisk?.resolutionComparisonShortfall.minorUnits, '96');
  assert.equal(
    result.events.some((event) => event.type === 'RISK_STATE_TRANSITION'),
    false,
  );
});

test('uses integer cross multiplication for an odd immutable baseline without rebasing', () => {
  const belowHalf = settleDay(
    baseInput({
      dayIndex: 2,
      cashBefore: m('-100'),
      completedOrderReceivables: [],
      ingredientUsageCosts: [],
      perishableWasteCosts: [],
      authorizedShiftWages: [],
      rent: m('0'),
      fixedFees: m('0'),
      otherOperationalCosts: m('0'),
      vat: m('0'),
      employerTax: m('0'),
      maturingDebt: m('0'),
      currentInterest: m('0'),
      overduePenalty: m('0'),
      previousRisk: risk('DELINQUENT', 1, 0, '201'),
    }),
  );
  const atOrAboveHalf = settleDay(
    baseInput({
      dayIndex: 2,
      cashBefore: m('-101'),
      completedOrderReceivables: [],
      ingredientUsageCosts: [],
      perishableWasteCosts: [],
      authorizedShiftWages: [],
      rent: m('0'),
      fixedFees: m('0'),
      otherOperationalCosts: m('0'),
      vat: m('0'),
      employerTax: m('0'),
      maturingDebt: m('0'),
      currentInterest: m('0'),
      overduePenalty: m('0'),
      previousRisk: risk('DELINQUENT', 1, 0, '201'),
    }),
  );

  assert.equal(belowHalf.snapshot.resolutionComparisonShortfall.minorUnits, '100');
  assert.equal(belowHalf.snapshot.riskState.state, 'DELINQUENT');
  assert.equal(belowHalf.snapshot.riskState.delinquencyBaselineShortfall?.minorUnits, '201');
  assert.equal(atOrAboveHalf.snapshot.resolutionComparisonShortfall.minorUnits, '101');
  assert.equal(atOrAboveHalf.snapshot.riskState.state, 'RESOLUTION');
  assert.equal(atOrAboveHalf.snapshot.riskState.delinquencyBaselineShortfall, null);
});

test('counts three full RESOLUTION days after entry, then activates REHAB for the next opening', () => {
  const resolutionEntry = risk('RESOLUTION', 0, 0, null);
  const dayThree = settleDay(baseInput({ dayIndex: 3, previousRisk: resolutionEntry }));
  const dayFour = settleDay(baseInput({ dayIndex: 4, previousRisk: dayThree.snapshot.riskState }));
  const dayFive = settleDay(baseInput({ dayIndex: 5, previousRisk: dayFour.snapshot.riskState }));

  assert.equal(dayThree.snapshot.riskState.state, 'RESOLUTION');
  assert.equal(dayThree.snapshot.riskState.consecutiveResolutionDays, 1);
  assert.equal(dayFour.snapshot.riskState.state, 'RESOLUTION');
  assert.equal(dayFour.snapshot.riskState.consecutiveResolutionDays, 2);
  assert.equal(dayFive.snapshot.riskState.state, 'REHAB');
  assert.equal(dayFive.snapshot.riskState.consecutiveDelinquentDays, 0);
  assert.equal(dayFive.snapshot.riskState.consecutiveResolutionDays, 0);
  assert.equal(dayFive.snapshot.leaderboardEligible, false);
  const transition = dayFive.events.at(-1);
  assert.equal(
    transition?.type === 'RISK_STATE_TRANSITION' ? transition.reason : undefined,
    'THREE_RESOLUTION_DAYS',
  );
});

test('combines recovery, reputation crash, and flow events without changing the accounting formula', () => {
  const result = settleDay(
    baseInput({
      reputation: { ...healthyReputation, quality: 9 },
      flowRiskHigh: true,
    }),
  );

  assert.deepEqual(result.snapshot.riskTags, [
    'REHAB',
    'RecoveryNeeded',
    'ReputationCrash',
    'FLOW_RISK_HIGH',
  ]);
  assert.equal(result.snapshot.dailyNet.minorUnits, '685');
  assert.equal(result.snapshot.riskState.state, 'REHAB');
  assert.equal(result.snapshot.riskState.consecutiveDelinquentDays, 0);
  assert.equal(result.snapshot.riskState.consecutiveResolutionDays, 0);
  assert.equal(result.snapshot.riskState.delinquencyBaselineShortfall, null);
  assert.deepEqual(
    result.events.filter((event) => event.type === 'RISK_TAGGED').map((event) => event.tag),
    ['RecoveryNeeded', 'ReputationCrash', 'FLOW_RISK_HIGH'],
  );
  const transition = result.events.at(-1);
  assert.equal(
    transition?.type === 'RISK_STATE_TRANSITION' ? transition.reason : undefined,
    'REPUTATION_CRASH',
  );
});

test('uses strict reputation boundaries: 15 is healthy and 10 needs recovery without a crash', () => {
  const atFifteen = settleDay(baseInput({ reputation: { ...healthyReputation, fairness: 15 } }));
  const atTen = settleDay(baseInput({ reputation: { ...healthyReputation, fairness: 10 } }));

  assert.deepEqual(atFifteen.snapshot.riskTags, []);
  assert.deepEqual(atTen.snapshot.riskTags, ['RecoveryNeeded']);
  assert.equal(atTen.snapshot.riskState.state, 'NORMAL');
});

test('allows REHAB exit only with manual approval, cleared shortfall, and all reputation at least 15', () => {
  const prior = risk('REHAB', 0, 0, null);
  const denied = settleDay(
    baseInput({
      previousRisk: prior,
      rehabExitApproved: true,
      reputation: { ...healthyReputation, vibe: 14 },
    }),
  );
  const approved = settleDay(baseInput({ previousRisk: prior, rehabExitApproved: true }));

  assert.equal(denied.snapshot.riskState.state, 'REHAB');
  assert.equal(approved.snapshot.riskState.state, 'NORMAL');
  const transition = approved.events.at(-1);
  assert.equal(
    transition?.type === 'RISK_STATE_TRANSITION' ? transition.reason : undefined,
    'REHAB_EXIT_APPROVED',
  );
});

test('produces byte-identical snapshots and events for identical replay inputs', () => {
  const input = baseInput({
    deferredPaymentKinds: ['CONTRACT', 'PAYROLL'],
    flowRiskHigh: true,
    reputation: { ...healthyReputation, speed: 14 },
  });

  assert.equal(JSON.stringify(settleDay(input)), JSON.stringify(settleDay(input)));
});

test('rejects mixed currencies, invalid state streaks, negative costs, and invalid reputations', () => {
  assert.throws(() => settleDay(baseInput({ gameId: ' ' })), /game id/);
  assert.throws(() => settleDay(baseInput({ vat: createMoney('USD', '1') })), /must use TWD/);
  assert.throws(
    () => settleDay(baseInput({ riskPenaltyAccruedTotalBefore: m('-1') })),
    /accrued total before must not be negative/,
  );
  assert.throws(
    () => settleDay(baseInput({ previousRisk: risk('DELINQUENT', 0) })),
    /requires a delinquent streak and baseline/,
  );
  assert.throws(
    () => settleDay(baseInput({ authorizedShiftWages: [m('-1')] })),
    /must not be negative/,
  );
  assert.throws(
    () => settleDay(baseInput({ reputation: { ...healthyReputation, price: 101 } })),
    /price reputation/,
  );
});
