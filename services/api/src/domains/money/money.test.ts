import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateBasisPointAmountRoundHalfUp,
  convertDisplayIntegerToMinorUnits,
  createMoney,
  createMoneyFromDisplayInteger,
} from './money.js';

test('creates immutable Money with a canonical base-10 minor-unit string', () => {
  const money = createMoney('TWD', '32000');

  assert.deepEqual(money, { currency: 'TWD', minorUnits: '32000' });
  assert.equal(JSON.stringify(money), '{"currency":"TWD","minorUnits":"32000"}');
  assert.equal(Object.isFrozen(money), true);
  assert.equal(Reflect.set(money, 'minorUnits', '1'), false);
});

test('converts integer display-major values with exponent 0/2 and arbitrary precision', () => {
  assert.equal(
    convertDisplayIntegerToMinorUnits({ code: 'TWD', minorUnitExponent: 0 }, '32000'),
    '32000',
  );
  assert.equal(
    convertDisplayIntegerToMinorUnits({ code: 'USD', minorUnitExponent: 2 }, '32000'),
    '3200000',
  );
  assert.deepEqual(
    createMoneyFromDisplayInteger(
      { code: 'USD', minorUnitExponent: 2 },
      '999999999999999999999999999999999999',
    ),
    {
      currency: 'USD',
      minorUnits: '99999999999999999999999999999999999900',
    },
  );
});

test('rejects fractional, exponent-form, non-canonical, and client-shaped exponent values', () => {
  assert.throws(() => createMoney('tw', '1'), /currency/);
  assert.throws(() => createMoney('TWD', '1.5'), /minor units/);
  assert.throws(() => createMoney('TWD', '01'), /minor units/);
  assert.throws(() => createMoney('TWD', '-0'), /minor units/);
  assert.throws(() => createMoney('TWD', 1 as unknown as string), /minor units/);
  assert.throws(
    () => convertDisplayIntegerToMinorUnits({ code: 'TWD', minorUnitExponent: 0 }, '1.5'),
    /display amount/,
  );
  assert.throws(
    () => convertDisplayIntegerToMinorUnits({ code: 'TWD', minorUnitExponent: 0 }, '1e3'),
    /display amount/,
  );
  assert.throws(
    () => convertDisplayIntegerToMinorUnits({ code: 'TWD', minorUnitExponent: 1.5 }, '1'),
    /server currency metadata/,
  );
});

test('calculates basis-point amounts in minor units using roundHalfUp', () => {
  assert.deepEqual(calculateBasisPointAmountRoundHalfUp(createMoney('TWD', '1750'), 500), {
    currency: 'TWD',
    minorUnits: '88',
  });
  assert.deepEqual(calculateBasisPointAmountRoundHalfUp(createMoney('TWD', '1749'), 500), {
    currency: 'TWD',
    minorUnits: '87',
  });
  assert.throws(
    () => calculateBasisPointAmountRoundHalfUp(createMoney('TWD', '-1'), 500),
    /non-negative/,
  );
});
