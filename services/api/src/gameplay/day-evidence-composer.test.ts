import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DAY_EVIDENCE_COMPOSER_VERSION,
  DAY_EVIDENCE_EVENT_TYPES,
  composeDayEvidence,
  type ComposeDayEvidenceInput,
} from './day-evidence-composer.js';
import {
  hashReleaseEvidenceEvents,
  hashReleaseEvidenceSnapshot,
  type CanonicalEvidenceValue,
} from '../../../../packages/econ-game-release-evidence/index.js';

const fixedFieldSnapshot: ComposeDayEvidenceInput['dayEnd']['fixedFieldSnapshot'] = Object.freeze({
  dayIndex: 1,
  grossRevenue: { currency: 'TWD', minorUnits: '10000' },
  cogs: { currency: 'TWD', minorUnits: '3000' },
  wasteLoss: { currency: 'TWD', minorUnits: '100' },
  payroll: { currency: 'TWD', minorUnits: '2000' },
  opex: { currency: 'TWD', minorUnits: '1000' },
  tax: { currency: 'TWD', minorUnits: '500' },
  debtDue: { currency: 'TWD', minorUnits: '0' },
  riskPenalty: { currency: 'TWD', minorUnits: '0' },
  riskPenaltyCalculation: {
    version: 'e05-risk-penalty-v1',
    base: { currency: 'TWD', minorUnits: '0' },
    rate: 300,
    denominator: 10000,
    rounding: 'HALF_UP',
    minimum: { currency: 'TWD', minorUnits: '1' },
    amount: { currency: 'TWD', minorUnits: '0' },
    accruedTotal: { currency: 'TWD', minorUnits: '0' },
    currency: 'TWD',
    idempotencyKey: { gameId: 'game-1', dayIndex: 1, version: 'e05-risk-penalty-v1' },
  },
  dailyNet: { currency: 'TWD', minorUnits: '3400' },
  resolutionComparisonShortfall: { currency: 'TWD', minorUnits: '0' },
  shortfall: { currency: 'TWD', minorUnits: '0' },
  cashAfter: { currency: 'TWD', minorUnits: '13400' },
  reputation: { price: 50, speed: 51, quality: 52, fairness: 53, vibe: 54 },
  riskTags: [],
  riskState: {
    state: 'NORMAL',
    consecutiveDelinquentDays: 0,
    consecutiveResolutionDays: 0,
    delinquencyBaselineShortfall: null,
  },
  highRiskRevenueEnabled: true,
  leaderboardEligible: true,
});

function descriptor(eventId: string, localSequence: number, payload: CanonicalEvidenceValue) {
  return {
    eventId,
    localSequence,
    simulationRuleVersion: 'simulation-rule/v1',
    payload,
  } as const;
}

function input(plan: 'TWO_PERIODS' | 'THREE_PERIODS' = 'TWO_PERIODS'): ComposeDayEvidenceInput {
  const periods =
    plan === 'TWO_PERIODS'
      ? [
          { period: 'LUNCH' as const, servicePeriodExecutionId: 'execution-lunch', event: descriptor('period-lunch', 1, { period: 'LUNCH' }) },
          { period: 'DINNER' as const, servicePeriodExecutionId: 'execution-dinner', event: descriptor('period-dinner', 2, { period: 'DINNER' }) },
        ]
      : [
          { period: 'LUNCH' as const, servicePeriodExecutionId: 'execution-lunch', event: descriptor('period-lunch', 1, { period: 'LUNCH' }) },
          { period: 'OFF_PEAK' as const, servicePeriodExecutionId: 'execution-off-peak', event: descriptor('period-off-peak', 2, { period: 'OFF_PEAK' }) },
          { period: 'DINNER' as const, servicePeriodExecutionId: 'execution-dinner', event: descriptor('period-dinner', 3, { period: 'DINNER' }) },
        ];
  const finalSequence = periods.length + 1;
  return {
    scope: { restaurantId: 'restaurant-1', saveId: 'save-1', businessDay: 1 },
    servicePeriodPlan: plan,
    open: descriptor('open', 0, { preopenSnapshotHash: 'a'.repeat(64) }),
    servicePeriods: periods,
    inventory: descriptor('inventory', finalSequence, { closingInventoryVersion: 9 }),
    dayEnd: {
      event: descriptor('day-end', finalSequence + 1, { dailyNetMinor: '3400' }),
      fixedFieldSnapshot,
      finalResourceVersions: { game: 7, simulationRule: 'simulation-rule/v1' },
    },
    risk: descriptor('risk', finalSequence + 2, { status: 'NORMAL' }),
  };
}

test('composes two-period authoritative evidence into immutable, contiguous persistence records', () => {
  const result = composeDayEvidence(input());
  assert.equal(result.version, DAY_EVIDENCE_COMPOSER_VERSION);
  assert.deepEqual(result.replayEvents.map((event) => event.sequence), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(result.replayEvents.map((event) => event.eventType), [
    DAY_EVIDENCE_EVENT_TYPES.open,
    DAY_EVIDENCE_EVENT_TYPES.servicePeriod,
    DAY_EVIDENCE_EVENT_TYPES.servicePeriod,
    DAY_EVIDENCE_EVENT_TYPES.inventory,
    DAY_EVIDENCE_EVENT_TYPES.dayEnd,
    DAY_EVIDENCE_EVENT_TYPES.risk,
  ]);
  assert.equal(result.replayEvents.length, 6);
  assert.equal(result.replayEvents[1]?.servicePeriodExecutionId, 'execution-lunch');
  assert.equal(result.replayEvents[0]?.servicePeriodExecutionId, undefined);
  assert.equal(result.dayEnd.eventHash, result.replayEvents[0]?.eventHash);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.replayEvents), true);
  assert.equal(Object.isFrozen(result.replayEvents[0]!), true);
  assert.equal(Object.isFrozen(result.replayEvents[0]!.payload), true);
  assert.equal(Object.isFrozen(result.dayEnd.fixedFieldSnapshot), true);
  assert.throws(
    () => (result.replayEvents[0] as { eventHash: string }).eventHash = 'forged',
    /read only|readonly|Cannot assign/i,
  );
});

test('three-period plan requires and preserves canonical LUNCH, OFF_PEAK, DINNER evidence order', () => {
  const result = composeDayEvidence(input('THREE_PERIODS'));
  assert.equal(result.replayEvents.length, 7);
  assert.deepEqual(
    result.replayEvents.slice(1, 4).map((event) => event.payload),
    [{ period: 'LUNCH' }, { period: 'OFF_PEAK' }, { period: 'DINNER' }],
  );
  const wrongOrder = input('THREE_PERIODS');
  const reversed = [...wrongOrder.servicePeriods].reverse();
  assert.throws(
    () => composeDayEvidence({ ...wrongOrder, servicePeriods: reversed }),
    /canonical order LUNCH,OFF_PEAK,DINNER/,
  );
});

test('re-sequences validated canonical source records and delegates both hashes to the shared package', () => {
  const source = input();
  const outOfOrder = {
    ...source,
    open: { ...source.open, localSequence: 1 },
    servicePeriods: [
      { ...source.servicePeriods[0]!, event: { ...source.servicePeriods[0]!.event, localSequence: 0 } },
      source.servicePeriods[1]!,
    ],
  } as ComposeDayEvidenceInput;
  assert.throws(() => composeDayEvidence(outOfOrder), /source ordering must follow OPEN/);
  const result = composeDayEvidence(source);
  const expected = hashReleaseEvidenceEvents(
    result.replayEvents.map((event) => ({
      sequence: event.sequence,
      type: event.eventType,
      simulationRuleVersion: event.simulationRuleVersion,
      payload: event.payload,
    })),
  );
  assert.equal(result.dayEnd.eventHash, expected);
  assert.equal(
    result.dayEnd.snapshotHash,
    hashReleaseEvidenceSnapshot(fixedFieldSnapshot, source.dayEnd.finalResourceVersions),
  );
});

test('rejects source gaps, duplicate local sequences, missing required final evidence, and foreign authority fields', () => {
  const source = input();
  assert.throws(
    () => composeDayEvidence({ ...source, inventory: { ...source.inventory, localSequence: 8 } }),
    /local sequences must be contiguous/,
  );
  assert.throws(
    () => composeDayEvidence({ ...source, risk: { ...source.risk, localSequence: source.dayEnd.event.localSequence } }),
    /duplicate local sequences/,
  );
  const missingRisk = { ...source } as Record<string, unknown>;
  delete missingRisk.risk;
  assert.throws(() => composeDayEvidence(missingRisk as unknown as ComposeDayEvidenceInput), /unknown or missing authority fields/);
  assert.throws(
    () => composeDayEvidence({ ...source, open: { ...source.open, eventHash: 'forged' } } as unknown as ComposeDayEvidenceInput),
    /unknown or missing authority fields/,
  );
  assert.throws(
    () => composeDayEvidence({ ...source, scope: { ...source.scope, playerId: 'client-owned' } } as unknown as ComposeDayEvidenceInput),
    /unknown or missing authority fields/,
  );
});

test('rejects timestamp/self-hash descriptor fields and fixed snapshots that do not exactly match E05', () => {
  const source = input();
  assert.throws(
    () => composeDayEvidence({ ...source, dayEnd: { ...source.dayEnd, snapshotHash: 'forged' } } as unknown as ComposeDayEvidenceInput),
    /unknown or missing authority fields/,
  );
  assert.throws(
    () => composeDayEvidence({ ...source, inventory: { ...source.inventory, occurredAt: '2026-08-18T00:00:00.000Z' } } as unknown as ComposeDayEvidenceInput),
    /unknown or missing authority fields/,
  );
  assert.throws(
    () => composeDayEvidence({
      ...source,
      dayEnd: { ...source.dayEnd, fixedFieldSnapshot: { ...fixedFieldSnapshot, createdAt: 'forged' } },
    } as unknown as ComposeDayEvidenceInput), /unknown or missing authority fields/);
});

test('rejects an E05 snapshot whose day index does not match the authoritative business-day scope', () => {
  const source = input();
  assert.throws(
    () =>
      composeDayEvidence({
        ...source,
        dayEnd: {
          ...source.dayEnd,
          fixedFieldSnapshot: { ...fixedFieldSnapshot, dayIndex: 2 },
        },
      }),
    /dayIndex must equal scope.businessDay/,
  );
});
