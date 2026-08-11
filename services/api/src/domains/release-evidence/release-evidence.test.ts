import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalizeReleaseEvidence,
  createReleaseEvidenceHashes,
  hashDayEndSnapshot,
  hashReplayEventSequence,
  RELEASE_EVIDENCE_VERSION,
  verifyWebDiscordReleaseEvidence,
  type ClientReleaseEvidenceInput,
  type ReplayEventForEvidence,
} from './release-evidence.js';
import type { DayEndSnapshot } from '../day-end/day-end.js';
import { createMoney } from '../money/money.js';

const money = (minorUnits: string) => createMoney('USD', minorUnits);

function snapshot(): DayEndSnapshot {
  return {
    dayIndex: 1,
    grossRevenue: money('10000'),
    cogs: money('3000'),
    wasteLoss: money('100'),
    payroll: money('2000'),
    opex: money('1000'),
    tax: money('500'),
    debtDue: money('0'),
    riskPenalty: money('0'),
    riskPenaltyCalculation: {
      version: 'e05-risk-penalty-v1',
      base: money('0'),
      rate: 300,
      denominator: 10_000,
      rounding: 'HALF_UP',
      minimum: money('1'),
      amount: money('0'),
      accruedTotal: money('0'),
      currency: 'USD',
      idempotencyKey: { gameId: 'game-1', dayIndex: 1, version: 'e05-risk-penalty-v1' },
    },
    dailyNet: money('3400'),
    resolutionComparisonShortfall: money('0'),
    shortfall: money('0'),
    cashAfter: money('13400'),
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
  };
}

const replayEvents: readonly ReplayEventForEvidence[] = [
  {
    sequence: 0,
    simulationRuleVersion: 'simulation-rule/v1',
    type: 'OPEN_DAY',
    payload: { gameId: 'game-1', dayIndex: 1 },
  },
  {
    sequence: 1,
    simulationRuleVersion: 'simulation-rule/v1',
    type: 'DAY_END_SETTLED',
    payload: { cashAfterMinor: '13400' },
  },
];

function evidence(client: 'WEB' | 'DISCORD'): ClientReleaseEvidenceInput {
  return {
    client,
    replayEvents,
    dayEnd: {
      snapshot: snapshot(),
      finalResourceVersions: {
        game: 7,
        inventoryCatalog: 'inventory-rule/v1',
        simulationRule: 'simulation-rule/v1',
      },
    },
  };
}

test('canonical serialization sorts object keys and rejects unsupported or non-finite values', () => {
  assert.equal(
    canonicalizeReleaseEvidence({ z: 1, a: { y: true, x: 'value' } }),
    '{"a":{"x":"value","y":true},"z":1}',
  );
  assert.throws(() => canonicalizeReleaseEvidence({ bad: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalizeReleaseEvidence({ bad: undefined }), /unsupported/);
});

test('eventHash is based on canonical sequence order and includes simulation rule version', () => {
  const expected = hashReplayEventSequence(replayEvents);
  assert.equal(hashReplayEventSequence([...replayEvents].reverse()), expected);
  assert.equal(expected.length, 64);
  assert.notEqual(
    hashReplayEventSequence([
      { ...replayEvents[0]!, simulationRuleVersion: 'simulation-rule/v2' },
      replayEvents[1]!,
    ]),
    expected,
  );
  assert.throws(
    () => hashReplayEventSequence([replayEvents[0]!, { ...replayEvents[1]!, sequence: 0 }]),
    /unique/,
  );
});

test('snapshotHash fixes all E05 fields plus final resource versions', () => {
  const first = evidence('WEB').dayEnd;
  const second = {
    snapshot: snapshot(),
    finalResourceVersions: {
      simulationRule: 'simulation-rule/v1',
      inventoryCatalog: 'inventory-rule/v1',
      game: 7,
    },
  } as const;
  assert.equal(hashDayEndSnapshot(first), hashDayEndSnapshot(second));
  assert.notEqual(
    hashDayEndSnapshot({
      ...first,
      finalResourceVersions: { ...first.finalResourceVersions, game: 8 },
    }),
    hashDayEndSnapshot(first),
  );
  assert.throws(
    () => hashDayEndSnapshot({ snapshot: snapshot(), finalResourceVersions: {} }),
    /versions are required/,
  );
});

test('matching Web and Discord evidence returns both hashes and remains immutable', () => {
  const hashes = verifyWebDiscordReleaseEvidence(evidence('WEB'), evidence('DISCORD'));
  assert.equal(hashes.version, RELEASE_EVIDENCE_VERSION);
  assert.equal(hashes.eventHash.length, 64);
  assert.equal(hashes.snapshotHash.length, 64);
  assert.equal(Object.isFrozen(hashes), true);
  assert.deepEqual(createReleaseEvidenceHashes(evidence('WEB')), hashes);
});

test('either event or snapshot divergence blocks release independently', () => {
  const discordEventDrift = {
    ...evidence('DISCORD'),
    replayEvents: [replayEvents[0]!, { ...replayEvents[1]!, payload: { cashAfterMinor: '13399' } }],
  } as const;
  assert.throws(
    () => verifyWebDiscordReleaseEvidence(evidence('WEB'), discordEventDrift),
    /eventHash values differ/,
  );

  const discordSnapshotDrift = {
    ...evidence('DISCORD'),
    dayEnd: {
      ...evidence('DISCORD').dayEnd,
      finalResourceVersions: {
        ...evidence('DISCORD').dayEnd.finalResourceVersions,
        game: 8,
      },
    },
  } as const;
  assert.throws(
    () => verifyWebDiscordReleaseEvidence(evidence('WEB'), discordSnapshotDrift),
    /snapshotHash values differ/,
  );
});
