import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandError } from '../commands/command-contract.js';
import type { D03Database, D03Queryable } from '../domains/ledger/postgres-ledger-store.js';
import {
  PrismaPreopenConfigurationChoicesRepository,
  type PreopenConfigurationChoicesScope,
} from './prisma-preopen-configuration-choices-repository.js';

type Call = Readonly<{ query: string; values: readonly unknown[] }>;

function scopeRow(role: 'OWNER' | 'MANAGER' = 'OWNER') {
  return {
    playerId: 'player-1',
    membershipId: 'membership-1',
    tenantId: 'restaurant-1',
    saveId: 'save-1',
    role,
  };
}

function authorityRows(
  overrides: Readonly<Record<string, unknown>> = {},
): readonly Readonly<Record<string, unknown>>[] {
  const common = {
    ...scopeRow(),
    expectedVersion: 1,
    openingScenario: 'DEFAULT_SMALL_SHOP',
    operatingMode: 'STRATEGY',
    servicePeriodPlan: 'TWO_PERIODS',
    simulationRuleVersion: 'mvp-e01-v1',
    settlementCurrency: 'TWD',
    businessDayId: null,
    preopenSnapshotCount: 0,
    poolRevision: 1,
    storageBundleVersion: 'mvp-storage/v1',
    storageBundleKind: 'BASIC',
    poolSaveId: 'save-1',
    ...overrides,
  };
  return [
    { ...common, pool: 'DURABLE', capacityPoints: 305, ...overrides },
    { ...common, pool: 'PERISHABLE', capacityPoints: 305, ...overrides },
  ];
}

function fakeDatabase(
  input: Readonly<{ scopeRows?: readonly unknown[]; authorityRows?: readonly unknown[] }>,
) {
  const calls: Call[] = [];
  const transaction: D03Queryable = {
    async $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T> {
      calls.push({ query, values });
      if (query.includes('preopen-configuration-choices:scope')) {
        return (input.scopeRows ?? [scopeRow()]) as T;
      }
      if (query.includes('preopen-configuration-choices:authority')) {
        return (input.authorityRows ?? authorityRows()) as T;
      }
      throw new Error('unexpected query');
    },
  };
  const database: D03Database = {
    async $transaction<T>(operation: (value: D03Queryable) => Promise<T>): Promise<T> {
      return operation(transaction);
    },
  };
  return { calls, database };
}

const ownerScope: PreopenConfigurationChoicesScope = Object.freeze({
  ...scopeRow(),
  role: 'OWNER',
});

test('resolves OWNER and MANAGER scope with non-leaky parameterized read-only SQL', async () => {
  for (const role of ['OWNER', 'MANAGER'] as const) {
    const opened = fakeDatabase({ scopeRows: [scopeRow(role)] });
    const repository = new PrismaPreopenConfigurationChoicesRepository(opened.database);
    assert.deepEqual(await repository.resolveScope('player-1', 'save-1'), scopeRow(role));
    const call = opened.calls[0]!;
    assert.deepEqual(call.values, ['player-1', 'save-1']);
    assert.match(call.query, /membership\."revokedAt" IS NULL/);
    assert.match(call.query, /membership\."role" IN \('OWNER', 'MANAGER'\)/);
    assert.match(call.query, /save\."retiredAt" IS NULL/);
    assert.doesNotMatch(call.query, /\b(?:INSERT|UPDATE|DELETE|FOR\s+(?:UPDATE|SHARE))\b/i);
  }
});

test('returns no scope for nonexistent, cross-tenant, revoked, retired, or CASHIER-shaped misses', async () => {
  const opened = fakeDatabase({ scopeRows: [] });
  const repository = new PrismaPreopenConfigurationChoicesRepository(opened.database);
  assert.equal(await repository.resolveScope('player-other', 'save-1'), undefined);
  assert.equal(opened.calls.length, 1);
});

test('loads only exact scalar authority and validates both persisted storage rows', async () => {
  const opened = fakeDatabase({ authorityRows: authorityRows() });
  const repository = new PrismaPreopenConfigurationChoicesRepository(opened.database);
  const result = await repository.loadAuthority(ownerScope);
  assert.deepEqual(result, {
    scope: ownerScope,
    authority: {
      save: {
        id: 'save-1',
        expectedVersion: 1,
        phase: 'CONFIGURE_REQUIRED',
        scenario: 'DEFAULT_SMALL_SHOP',
        operatingMode: 'STRATEGY',
        servicePeriodPlan: 'TWO_PERIODS',
        simulationRuleVersion: 'mvp-e01-v1',
        settlementCurrency: 'TWD',
      },
    },
  });
  const call = opened.calls[0]!;
  assert.deepEqual(call.values, ['save-1', 'restaurant-1', 'membership-1', 'player-1']);
  assert.match(call.query, /"InventoryPoolState"/);
  assert.match(call.query, /"openingSnapshot" #>> '\{settlementCurrency,code\}'/);
  assert.doesNotMatch(call.query, /\b(?:INSERT|UPDATE|DELETE|FOR\s+(?:UPDATE|SHARE))\b/i);
});

test('fails with a scoped 409 only when Day 1 is no longer configurable', async () => {
  const opened = fakeDatabase({
    authorityRows: authorityRows({ businessDayId: 'day-1' }),
  });
  const repository = new PrismaPreopenConfigurationChoicesRepository(opened.database);
  await assert.rejects(
    () => repository.loadAuthority(ownerScope),
    (error: unknown) =>
      error instanceof CommandError &&
      error.status === 409 &&
      error.code === 'PREOPEN_CONFIGURATION_PHASE_UNAVAILABLE',
  );
});

test('malformed phase scalars are unavailable rather than presented as a user conflict', async () => {
  const opened = fakeDatabase({ authorityRows: authorityRows({ businessDayId: undefined }) });
  const repository = new PrismaPreopenConfigurationChoicesRepository(opened.database);
  await assert.rejects(
    () => repository.loadAuthority(ownerScope),
    (error: unknown) =>
      error instanceof CommandError &&
      error.status === 503 &&
      error.code === 'PREOPEN_CONFIGURATION_CHOICES_UNAVAILABLE',
  );
});

test('fails closed on missing, duplicated, stale, or mismatched storage authority', async () => {
  for (const rows of [
    authorityRows().slice(0, 1),
    [authorityRows()[0], authorityRows()[0]],
    authorityRows({ poolRevision: 2 }),
    authorityRows({ capacityPoints: 999 }),
    authorityRows({ storageBundleVersion: 'forged' }),
  ]) {
    const opened = fakeDatabase({ authorityRows: rows });
    const repository = new PrismaPreopenConfigurationChoicesRepository(opened.database);
    await assert.rejects(
      () => repository.loadAuthority(ownerScope),
      (error: unknown) =>
        error instanceof CommandError &&
        error.status === 503 &&
        error.code === 'PREOPEN_CONFIGURATION_CHOICES_UNAVAILABLE',
    );
  }
});

test('reasserted membership disappearance after audit stays a non-leaky miss', async () => {
  const opened = fakeDatabase({ authorityRows: [] });
  const repository = new PrismaPreopenConfigurationChoicesRepository(opened.database);
  assert.equal(await repository.loadAuthority(ownerScope), undefined);
});
