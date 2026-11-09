import { createHash } from 'node:crypto';

import { createMoney, type Money } from '../money/money.js';

const nonNegativeIntegerPattern = /^(?:0|[1-9]\d*)$/;

export function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

export function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

export function moneyMinorUnits(value: Money, name = 'money'): bigint {
  if (!nonNegativeIntegerPattern.test(value.minorUnits)) {
    throw new Error(`${name} must use non-negative canonical minor units`);
  }
  return BigInt(value.minorUnits);
}

export function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new Error('money values must use the same currency');
  }
}

export function moneyFromMinorUnits(currency: string, amount: bigint): Money {
  if (amount < 0n) {
    throw new Error('money amount cannot be negative');
  }
  return createMoney(currency, amount.toString());
}

export function roundHalfUpRatio(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new Error(
      'round-half-up ratio requires a non-negative numerator and positive denominator',
    );
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue);
    }
    Object.freeze(value);
  }
  return value;
}

export function stableBucket(seed: string, identity: string, bucketCount: number): number {
  assertPositiveSafeInteger(bucketCount, 'bucket count');
  const digest = createHash('sha256').update(`${seed}\u0000${identity}`).digest();
  return digest.readUInt32BE(0) % bucketCount;
}

export function compareStableKey(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
