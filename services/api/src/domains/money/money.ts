declare const minorUnitsBrand: unique symbol;

export type MinorUnits = string & { readonly [minorUnitsBrand]: 'MinorUnits' };

export type Money = Readonly<{
  currency: string;
  minorUnits: MinorUnits;
}>;

export type CurrencyMetadata = Readonly<{
  code: string;
  minorUnitExponent: number;
}>;

const canonicalIntegerPattern = /^(?:0|-?[1-9]\d*)$/;
const nonNegativeCanonicalIntegerPattern = /^(?:0|[1-9]\d*)$/;

export function createMoney(currency: string, minorUnits: string): Money {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error('currency must be a three-letter uppercase ISO 4217 code');
  }
  if (typeof minorUnits !== 'string' || !canonicalIntegerPattern.test(minorUnits)) {
    throw new Error('minor units must be a canonical integer string');
  }

  return Object.freeze({ currency, minorUnits: minorUnits as MinorUnits });
}

export function convertDisplayIntegerToMinorUnits(
  metadata: CurrencyMetadata,
  displayInteger: string,
): MinorUnits {
  if (typeof displayInteger !== 'string' || !canonicalIntegerPattern.test(displayInteger)) {
    throw new Error('display amount must be a canonical integer without a fraction or exponent');
  }
  if (
    !Number.isSafeInteger(metadata.minorUnitExponent) ||
    metadata.minorUnitExponent < 0 ||
    metadata.minorUnitExponent > 9
  ) {
    throw new Error('minor unit exponent must come from supported server currency metadata');
  }

  return (
    BigInt(displayInteger) *
    10n ** BigInt(metadata.minorUnitExponent)
  ).toString() as MinorUnits;
}

export function createMoneyFromDisplayInteger(
  metadata: CurrencyMetadata,
  displayInteger: string,
): Money {
  return createMoney(metadata.code, convertDisplayIntegerToMinorUnits(metadata, displayInteger));
}

export function calculateBasisPointAmountRoundHalfUp(money: Money, basisPoints: number): Money {
  if (!nonNegativeCanonicalIntegerPattern.test(money.minorUnits)) {
    throw new Error('basis point amount requires non-negative canonical minor units');
  }
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) {
    throw new Error('basis points must be a non-negative safe integer');
  }

  const numerator = BigInt(money.minorUnits) * BigInt(basisPoints);
  const quotient = numerator / 10_000n;
  const remainder = numerator % 10_000n;
  const rounded = remainder * 2n >= 10_000n ? quotient + 1n : quotient;

  return createMoney(money.currency, rounded.toString());
}
