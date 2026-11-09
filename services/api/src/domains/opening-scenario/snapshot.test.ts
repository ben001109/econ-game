import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  assertEquipmentContract,
  assertOpeningSnapshotSupported,
  calculateOpeningInstallmentLateFee,
  createOpeningSnapshot,
  serializeOpeningSnapshotPayload,
  type EquipmentSnapshot,
  type OpeningSnapshot,
} from './snapshot.js';
import {
  MVP_OPENING_VERSIONS,
  serverOpeningRegistry,
  type OpeningVersionSelection,
} from './registry.js';

function createScenario(
  scenario: 'EMPTY_PREMISES' | 'DEFAULT_SMALL_SHOP' | 'TROUBLED_SHOP',
  currency = 'TWD',
): OpeningSnapshot {
  return createOpeningSnapshot(
    { scenario, operatingMode: 'STRATEGY', currency },
    MVP_OPENING_VERSIONS,
  );
}

test('server registry resolves exactly four locked version families', () => {
  assert.deepEqual(MVP_OPENING_VERSIONS, {
    snapshotSchemaVersion: 'opening-snapshot/v1',
    openingCatalogVersion: 'mvp-e01-opening-v2',
    currencyMetadataVersion: 'iso-4217-mvp/v1',
    simulationRuleVersion: 'mvp-e01-v1',
  });
  assert.deepEqual(Object.keys(serverOpeningRegistry), [
    'snapshotSchemas',
    'openingCatalogs',
    'currencyMetadata',
    'simulationRules',
  ]);
  assert.equal(Object.isFrozen(serverOpeningRegistry.currencyMetadata['iso-4217-mvp/v1']), true);
});

test('empty premises keeps stable identities, no opening inventory/debt/equipment/NPC, and planning-only budgets', () => {
  const snapshot = createScenario('EMPTY_PREMISES');

  assert.deepEqual(snapshot.settlementCash, {
    assetKey: 'cash:settlement',
    amount: { currency: 'TWD', minorUnits: '32000' },
  });
  assert.deepEqual(snapshot.leaseDeposit, {
    assetKey: 'lease-deposit:opening',
    status: 'HELD',
    amount: { currency: 'TWD', minorUnits: '1800' },
    interestBps: 0,
    refundableAtTermEnd: true,
    permittedOffsets: ['CONFIRMED_DAMAGE', 'CONFIRMED_UNPAID_RENT'],
  });
  assert.deepEqual(snapshot.equipmentBundles, []);
  assert.deepEqual(snapshot.openingInventory, []);
  assert.deepEqual(snapshot.npcContracts, []);
  assert.deepEqual(snapshot.loans, []);
  assert.deepEqual(
    snapshot.planningAllocations.map(({ allocationKey, purpose, amount }) => ({
      allocationKey,
      purpose,
      amount,
    })),
    [
      {
        allocationKey: 'planning:basic-equipment',
        purpose: 'BASIC_EQUIPMENT',
        amount: { currency: 'TWD', minorUnits: '15000' },
      },
      {
        allocationKey: 'planning:initial-inventory',
        purpose: 'INITIAL_INVENTORY',
        amount: { currency: 'TWD', minorUnits: '3200' },
      },
    ],
  );
  assert.equal(
    BigInt(snapshot.leaseDeposit.amount.minorUnits) +
      BigInt(snapshot.planningAllocations[1]!.amount.minorUnits),
    5000n,
  );
  assert.equal(snapshot.settlementCash.amount.minorUnits, '32000');
});

test('registry exponent 0/2 converts all display-major values without Number arithmetic', () => {
  const twd = createScenario('DEFAULT_SMALL_SHOP', 'TWD');
  const usd = createScenario('DEFAULT_SMALL_SHOP', 'USD');

  assert.deepEqual(twd.settlementCurrency, { code: 'TWD', minorUnitExponent: 0 });
  assert.deepEqual(usd.settlementCurrency, { code: 'USD', minorUnitExponent: 2 });
  assert.equal(twd.equipmentBundles[0]?.originalCost.minorUnits, '32000');
  assert.equal(usd.equipmentBundles[0]?.originalCost.minorUnits, '3200000');
  assert.equal(usd.loans[0]?.openingPrincipal.minorUnits, '3500000');
  assert.equal(usd.npcContracts[0]?.salary.minorUnits, '55000');
});

test('equipment snapshots preserve straight-line arithmetic and the sole E-04 modifiers', () => {
  const basic = createScenario('DEFAULT_SMALL_SHOP').equipmentBundles[0]!;
  const aged = createScenario('TROUBLED_SHOP').equipmentBundles[0]!;

  assert.deepEqual(
    [
      basic.originalCost.minorUnits,
      basic.accumulatedDepreciation.minorUnits,
      basic.bookValue.minorUnits,
      basic.residualValue.minorUnits,
      basic.depreciationPerCompletedBusinessDay.minorUnits,
      basic.depreciatedCompletedBusinessDays,
      basic.remainingCompletedBusinessDays,
      basic.capacityMultiplier,
      basic.qualityModifier,
    ],
    ['32000', '4000', '28000', '8000', '200', 20, 100, '1.00', 0],
  );
  assert.deepEqual(
    [
      aged.originalCost.minorUnits,
      aged.accumulatedDepreciation.minorUnits,
      aged.bookValue.minorUnits,
      aged.residualValue.minorUnits,
      aged.depreciationPerCompletedBusinessDay.minorUnits,
      aged.depreciatedCompletedBusinessDays,
      aged.remainingCompletedBusinessDays,
      aged.capacityMultiplier,
      aged.qualityModifier,
    ],
    ['40000', '15000', '25000', '4000', '300', 50, 70, '0.85', -10],
  );
  assert.doesNotThrow(() => assertEquipmentContract(basic));
  assert.doesNotThrow(() => assertEquipmentContract(aged));
  assert.throws(
    () =>
      assertEquipmentContract({
        ...aged,
        qualityModifier: -8,
      } as unknown as EquipmentSnapshot),
    /operating modifiers/,
  );
});

test('four NPC opening contracts lock role, pay, all periods, day 1-30, and zero incentives', () => {
  const defaultContracts = createScenario('DEFAULT_SMALL_SHOP').npcContracts;
  const troubledContracts = createScenario('TROUBLED_SHOP').npcContracts;
  const allContracts = [...defaultContracts, ...troubledContracts];

  assert.deepEqual(
    defaultContracts.map(({ contractKey, npcKey, role, salary, capability, morale }) => ({
      contractKey,
      npcKey,
      role,
      salary: salary.minorUnits,
      capability,
      morale,
    })),
    [
      {
        contractKey: 'npc-contract:cashier:1',
        npcKey: 'npc:cashier:1',
        role: 'CASHIER',
        salary: '550',
        capability: 'MEDIUM',
        morale: 'NORMAL',
      },
      {
        contractKey: 'npc-contract:kitchen:1',
        npcKey: 'npc:kitchen:1',
        role: 'KITCHEN',
        salary: '650',
        capability: 'MEDIUM',
        morale: 'NORMAL',
      },
    ],
  );
  assert.deepEqual(
    troubledContracts.map((contract) => contract.salary.minorUnits),
    ['650', '750'],
  );
  for (const contract of allContracts) {
    assert.equal(contract.shiftCoverage, 'ALL_LOCKED_SERVICE_PERIODS');
    assert.equal(contract.salaryUnit, 'PER_COMPLETED_SCHEDULED_DAY');
    assert.equal(contract.effectiveCompletedBusinessDay, 1);
    assert.equal(contract.endCompletedBusinessDay, 30);
    assert.equal(contract.bonusType, 'NONE');
    assert.equal(contract.bonusAmount.minorUnits, '0');
    assert.equal(contract.profitShareBps, 0);
    assert.equal(contract.termsVersion, 'mvp-e01-opening-v2');
  }
});

test('five reputation dimensions and all three leases retain their locked baselines', () => {
  const snapshots = [
    createScenario('EMPTY_PREMISES'),
    createScenario('DEFAULT_SMALL_SHOP'),
    createScenario('TROUBLED_SHOP'),
  ];

  assert.deepEqual(
    snapshots.map((snapshot) => ({
      dimensions: Object.values(snapshot.reputation.dimensions),
      overall: snapshot.reputation.overall,
    })),
    [
      { dimensions: [50, 50, 50, 50, 50], overall: 50 },
      { dimensions: [50, 50, 50, 50, 50], overall: 50 },
      { dimensions: [30, 30, 30, 30, 30], overall: 30 },
    ],
  );
  assert.deepEqual(
    snapshots.map((snapshot) => [
      snapshot.lease.dailyRent.minorUnits,
      snapshot.leaseDeposit.amount.minorUnits,
    ]),
    [
      ['900', '1800'],
      ['1000', '2000'],
      ['700', '1400'],
    ],
  );
  for (const snapshot of snapshots) {
    assert.equal(snapshot.lease.leaseKey, 'lease:opening:1');
    assert.match(snapshot.lease.premisesKey, /^premises:/);
    assert.equal(snapshot.lease.effectiveCompletedBusinessDay, 1);
    assert.equal(snapshot.lease.endCompletedBusinessDay, 30);
    assert.equal(snapshot.lease.rentAdjustmentWithinTerm, 'PROHIBITED');
    assert.equal(snapshot.lease.renewalRentIncreaseCapBps, 1000);
    assert.equal(snapshot.lease.renewalNoticeCompletedBusinessDays, 5);
    assert.equal(snapshot.lease.renewalRequiresPlayerConfirmation, true);
  }
});

test('both loans have immutable 20-installment schedules, 500 bps late fee, and one first-miss grace', () => {
  const defaultLoan = createScenario('DEFAULT_SMALL_SHOP').loans[0]!;
  const troubledLoan = createScenario('TROUBLED_SHOP').loans[0]!;

  for (const [loan, expectedPrincipal, expectedInstallment, expectedFee] of [
    [defaultLoan, 35000n, '1750', '88'],
    [troubledLoan, 55000n, '2750', '138'],
  ] as const) {
    assert.equal(loan.liabilityKey, 'loan:opening:1');
    assert.equal(loan.installments.length, 20);
    assert.deepEqual(
      loan.installments.map((installment) => installment.dueCompletedBusinessDay),
      Array.from({ length: 20 }, (_, index) => (index + 1) * 5),
    );
    assert.equal(
      loan.installments.reduce(
        (sum, installment) => sum + BigInt(installment.principal.minorUnits),
        0n,
      ),
      expectedPrincipal,
    );
    assert.ok(
      loan.installments.every(
        (installment) =>
          installment.principal.minorUnits === expectedInstallment &&
          installment.interest.minorUnits === '0' &&
          installment.total.minorUnits === expectedInstallment &&
          installment.status === 'SCHEDULED',
      ),
    );
    assert.equal(loan.annualInterestBps, 0);
    assert.deepEqual(loan.lateFeePolicy, {
      basisPoints: 500,
      base: 'UNPAID_INSTALLMENT',
      rounding: 'ROUND_HALF_UP_MINOR_UNITS',
      chargedOncePerInstallment: true,
      compounds: false,
    });
    assert.deepEqual(loan.firstMissGracePolicy, {
      eligibleMissedDueCount: 1,
      graceCompletedBusinessDays: 1,
      lateFeeRecordedOnMissedDueDay: true,
      additionalFeeDuringGrace: false,
    });
    assert.equal(calculateOpeningInstallmentLateFee(loan.installments[0]!).minorUnits, expectedFee);
    assert.equal(Object.isFrozen(loan.installments), true);
    assert.equal(Object.isFrozen(loan.installments[0]), true);
  }
});

test('troubled shop cash covers about ten worst target-loss days', () => {
  const snapshot = createScenario('TROUBLED_SHOP');
  assert.ok(
    BigInt(snapshot.settlementCash.amount.minorUnits) >=
      -BigInt(snapshot.economicTargets.firstTenCompletedDaysProfitRange.min.minorUnits) * 10n,
  );
});

test('snapshot is deeply immutable and isolated from caller-owned input/version objects', () => {
  const input = {
    scenario: 'TROUBLED_SHOP',
    operatingMode: 'LIGHTWEIGHT_REALTIME',
    currency: 'TWD',
  };
  const versions = { ...MVP_OPENING_VERSIONS };
  const snapshot = createOpeningSnapshot(input, versions);

  input.scenario = 'EMPTY_PREMISES';
  versions.simulationRuleVersion = 'caller-mutated';

  assert.equal(snapshot.scenario, 'TROUBLED_SHOP');
  assert.equal(snapshot.simulationRuleVersion, 'mvp-e01-v1');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.npcContracts), true);
  assert.equal(Object.isFrozen(snapshot.npcContracts[0]?.salary), true);
  assert.equal(Reflect.set(snapshot.settlementCash.amount, 'minorUnits', '1'), false);
  assert.equal(Reflect.set(snapshot.lease, 'endCompletedBusinessDay', 1), false);
});

test('rejects unknown scenario/mode/currency, client exponent/version fields, and every unknown server version', () => {
  const validInput = {
    scenario: 'EMPTY_PREMISES',
    operatingMode: 'STRATEGY',
    currency: 'TWD',
  };
  assert.throws(
    () => createOpeningSnapshot({ ...validInput, scenario: 'UNKNOWN' }, MVP_OPENING_VERSIONS),
    /scenario/,
  );
  assert.throws(
    () => createOpeningSnapshot({ ...validInput, operatingMode: 'SANDBOX' }, MVP_OPENING_VERSIONS),
    /operating mode/,
  );
  assert.throws(
    () => createOpeningSnapshot({ ...validInput, currency: 'EUR' }, MVP_OPENING_VERSIONS),
    /not supported/,
  );
  assert.throws(
    () =>
      createOpeningSnapshot(
        { ...validInput, minorUnitExponent: 2 } as unknown as typeof validInput,
        MVP_OPENING_VERSIONS,
      ),
    /server-owned/,
  );
  assert.throws(
    () =>
      createOpeningSnapshot(
        { ...validInput, simulationRuleVersion: 'client-choice' } as unknown as typeof validInput,
        MVP_OPENING_VERSIONS,
      ),
    /server-owned/,
  );

  for (const versionKey of Object.keys(MVP_OPENING_VERSIONS) as (keyof OpeningVersionSelection)[]) {
    assert.throws(
      () =>
        createOpeningSnapshot(validInput, {
          ...MVP_OPENING_VERSIONS,
          [versionKey]: 'unknown-version',
        }),
      /unknown/,
    );
  }
  const missingVersion = { ...MVP_OPENING_VERSIONS } as Record<string, string>;
  delete missingVersion.currencyMetadataVersion;
  assert.throws(
    () => createOpeningSnapshot(validInput, missingVersion as OpeningVersionSelection),
    /exactly the four/,
  );
});

test('canonical payload and SHA-256 are byte-identical and reject silent version/hash drift', () => {
  const first = createScenario('TROUBLED_SHOP');
  const second = createScenario('TROUBLED_SHOP');
  const firstPayload = serializeOpeningSnapshotPayload(first);
  const secondPayload = serializeOpeningSnapshotPayload(second);

  assert.equal(firstPayload, secondPayload);
  assert.equal(first.openingSnapshotHash, second.openingSnapshotHash);
  assert.equal(
    first.openingSnapshotHash,
    createHash('sha256').update(firstPayload, 'utf8').digest('hex'),
  );
  assert.match(first.openingSnapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(firstPayload.includes('openingSnapshotHash'), false);
  assert.equal(firstPayload.includes('createdAt'), false);
  assert.equal(firstPayload.includes('rowId'), false);
  assert.equal(firstPayload.includes('uuid'), false);
  assert.deepEqual(
    first.npcContracts.map((contract) => contract.contractKey),
    ['npc-contract:cashier:1', 'npc-contract:kitchen:1'],
  );
  assert.deepEqual(
    first.loans[0]?.installments.map((installment) => installment.sequence),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  assert.doesNotThrow(() => assertOpeningSnapshotSupported(first));
  assert.throws(
    () =>
      assertOpeningSnapshotSupported({
        ...first,
        simulationRuleVersion: 'unknown-version',
      }),
    /unknown simulation rule version/,
  );
  assert.throws(
    () => assertOpeningSnapshotSupported({ ...first, openingSnapshotHash: '0'.repeat(64) }),
    /hash/,
  );
  assert.throws(
    () =>
      assertOpeningSnapshotSupported({
        ...first,
        settlementCurrency: { ...first.settlementCurrency, minorUnitExponent: 2 },
      }),
    /currency exponent/,
  );
});
