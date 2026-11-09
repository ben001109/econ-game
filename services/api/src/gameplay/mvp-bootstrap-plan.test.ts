import assert from 'node:assert/strict';
import test from 'node:test';

import { InitializeCompetitiveSaveError } from './initialize-competitive-save.js';
import { createMvpServerBootstrapPlan } from './mvp-bootstrap-plan.js';

const context = Object.freeze({
  actorPlayerId: 'player-1',
  authorityId: 'authority-1',
  commandId: '44444444-4444-4444-8444-444444444444',
  requestFingerprint: 'a'.repeat(64),
  playerCommandVersion: 1,
});

function intent(scenario = 'DEFAULT_SMALL_SHOP') {
  return Object.freeze({
    scenario,
    operatingMode: 'STRATEGY',
    settlementCurrency: 'TWD',
    servicePeriodPlan: 'TWO_PERIODS',
  });
}

test('production MVP bootstrap plan is deterministic, canonical, and separates demand/market seeds', () => {
  const first = createMvpServerBootstrapPlan(context, intent());
  const second = createMvpServerBootstrapPlan(context, intent());
  assert.deepEqual(first, second);
  assert.equal(first.plan.openingSnapshotHash, first.plan.openingSnapshot.openingSnapshotHash);
  assert.equal(first.plan.simulationRuleVersion, 'mvp-e01-v1');
  assert.equal(first.plan.servicePeriodPlan, 'TWO_PERIODS');
  assert.deepEqual(first.plan.inventoryPoolAuthority.capacityPoints, {
    DURABLE: 305,
    PERISHABLE: 305,
  });
  assert.equal(first.plan.inventoryPoolAuthority.storageBundleKind, 'BASIC');
  assert.match(first.plan.demandSeed, /^[0-9a-f]{64}$/);
  assert.match(first.plan.marketSeedAuthority.seed, /^[0-9a-f]{64}$/);
  assert.notEqual(first.plan.demandSeed, first.plan.marketSeedAuthority.seed);
  for (const value of [
    first.epochId,
    first.plan.provisionedRestaurantId,
    first.plan.ownerMembershipId,
    first.plan.saveId,
    first.plan.ownerAuditLogId,
  ]) {
    assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('production MVP bootstrap plan preserves canonical initial storage by supported scenario', () => {
  for (const [scenario, kind, capacity] of [
    ['DEFAULT_SMALL_SHOP', 'BASIC', 305],
    ['TROUBLED_SHOP', 'AGED', 255],
  ] as const) {
    const result = createMvpServerBootstrapPlan(context, intent(scenario));
    assert.equal(result.plan.inventoryPoolAuthority.storageBundleKind, kind);
    assert.deepEqual(result.plan.inventoryPoolAuthority.capacityPoints, {
      DURABLE: capacity,
      PERISHABLE: capacity,
    });
  }
});

test('production MVP bootstrap plan rejects unregistered client selections', () => {
  for (const invalid of [
    { ...intent(), scenario: 'EMPTY_PREMISES' },
    { ...intent(), scenario: 'FORGED' },
    { ...intent(), operatingMode: 'ADMIN' },
    { ...intent(), settlementCurrency: 'BTC' },
    { ...intent(), servicePeriodPlan: 'FOUR_PERIODS' },
  ]) {
    assert.throws(
      () => createMvpServerBootstrapPlan(context, invalid),
      (error: unknown) =>
        error instanceof InitializeCompetitiveSaveError &&
        error.status === 422 &&
        error.code === 'INITIALIZE_COMPETITIVE_SAVE_INTENT_INVALID',
    );
  }
});
