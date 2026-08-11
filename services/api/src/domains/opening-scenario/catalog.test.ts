import assert from 'node:assert/strict';
import test from 'node:test';

import { openingScenarioCatalog } from './catalog.js';

test('catalog v2 defines exactly the three stable opening scenarios in display-major units', () => {
  assert.deepEqual(Object.keys(openingScenarioCatalog), [
    'EMPTY_PREMISES',
    'DEFAULT_SMALL_SHOP',
    'TROUBLED_SHOP',
  ]);
  assert.deepEqual(
    Object.values(openingScenarioCatalog).map((scenario) => scenario.startingCashDisplay),
    ['32000', '12000', '8000'],
  );
  assert.deepEqual(
    Object.values(openingScenarioCatalog).map((scenario) => scenario.leaseDepositDisplay),
    ['1800', '2000', '1400'],
  );
  assert.equal(openingScenarioCatalog.DEFAULT_SMALL_SHOP.equipment?.qualityModifier, 0);
  assert.equal(openingScenarioCatalog.TROUBLED_SHOP.equipment?.qualityModifier, -10);
  assert.equal(openingScenarioCatalog.TROUBLED_SHOP.equipment?.capacityMultiplier, '0.85');
  assert.equal(Object.isFrozen(openingScenarioCatalog), true);
  assert.equal(Object.isFrozen(openingScenarioCatalog.TROUBLED_SHOP.equipment), true);
});

test('empty-premises planning amounts retain their locked 1,800 + 3,200 split', () => {
  const initialInventory = openingScenarioCatalog.EMPTY_PREMISES.planningAllocations.find(
    (allocation) => allocation.purpose === 'INITIAL_INVENTORY',
  );

  assert.equal(initialInventory?.amountDisplay, '3200');
  assert.equal(
    BigInt(openingScenarioCatalog.EMPTY_PREMISES.leaseDepositDisplay) +
      BigInt(initialInventory!.amountDisplay),
    5000n,
  );
});
