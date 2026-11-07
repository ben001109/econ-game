import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  COMMAND_ENVELOPE_VERSION,
  CommandError,
  type CommandEnvelope,
  type TrustedCommandContext,
} from '../commands/command-contract.js';
import { CommandDispatcher } from '../commands/command-dispatcher.js';
import type { D03Database, D03Queryable } from '../domains/ledger/postgres-ledger-store.js';
import { PostgresDurableCommandExecutionStore } from '../domains/ledger/postgres-ledger-store.js';
import { createOpeningSnapshot } from '../domains/opening-scenario/snapshot.js';
import { MVP_OPENING_VERSIONS } from '../domains/opening-scenario/registry.js';
import {
  CONFIGURE_PREOPEN_DAY,
  PREOPEN_DAY_CONFIGURED_EVENT_TYPE,
  createConfigurePreopenDayCommandHandler,
} from './configure-preopen-day-command.js';
import { gameplaySaveScopedCommandAuthorizationPolicy } from './gameplay-command-authorization-policy.js';
import { MVP_FIRST_DAY_MARKET_SEED_VERSION } from './preopen-day-authority-provider.js';

const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const DEMAND_SEED = 'server-demand-seed-1';
const MARKET_SEED = 'independent-market-seed-1';
const openingSnapshot = createOpeningSnapshot(
  { scenario: 'DEFAULT_SMALL_SHOP', operatingMode: 'STRATEGY', currency: 'TWD' },
  MVP_OPENING_VERSIONS,
);
const context: TrustedCommandContext = Object.freeze({
  actorId: 'player-1',
  tenantId: 'restaurant-1',
  saveId: 'save-1',
  roles: ['OWNER'],
  membershipId: 'membership-1',
  branchScope: { kind: 'all' as const },
  principal: { type: 'web' as const },
});

function validPayload() {
  return {
    menuChoice: {
      themeId: 'bistro',
      recipeVersionIds: [
        'bistro-chicken-rice-v1',
        'bistro-greens-rice-v1',
        'bistro-herb-chicken-v1',
      ],
      priceModifierPercentByRecipe: {
        'bistro-chicken-rice-v1': 0,
        'bistro-greens-rice-v1': -1,
        'bistro-herb-chicken-v1': 1,
      },
      enabledSubstitutionIds: ['bistro-chicken-rice-greens-v1'],
    },
    floorPlan: {
      width: 10,
      height: 9,
      servicePoint: { x: 0, y: 0 },
      fixtures: [
        { fixtureId: 'walkway-1', kind: 'WALKWAY', x: 1, y: 0 },
        { fixtureId: 'seat-1', kind: 'SEAT', x: 2, y: 0 },
        { fixtureId: 'waiting-1', kind: 'WAITING_ZONE', x: 1, y: 1 },
      ],
    },
    spotPurchaseDeltas: [{ ingredientId: 'bistro-rice', quantityPoints: 2 }],
  } as const;
}

function configureCommand(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    schemaVersion: COMMAND_ENVELOPE_VERSION,
    commandId: COMMAND_ID,
    idempotencyKey: 'configure-preopen-1',
    commandType: CONFIGURE_PREOPEN_DAY,
    aggregateId: 'save-1',
    expectedVersion: 1,
    payload: validPayload(),
    ...overrides,
  };
}

type Receipt = Readonly<{
  commandId: string;
  fingerprint: string;
  snapshot: unknown;
}>;

type BusinessDayRecord = Readonly<{
  id: string;
  restaurantId: string;
  saveId: string;
  businessDay: 1;
  status: 'PREOPEN';
  servicePeriodPlan: string;
  simulationRuleVersion: string;
  commandId: string;
}>;

type PreopenSnapshotRecord = Readonly<{
  id: string;
  restaurantId: string;
  saveId: string;
  businessDay: 1;
  revision: 1;
  commandId: string;
  schemaVersion: string;
  simulationRuleVersion: string;
  payload: Readonly<Record<string, unknown>>;
  snapshotHash: string;
}>;

type OutboxRecord = Readonly<{
  id: string;
  restaurantId: string;
  saveId: string;
  transactionId: unknown;
  commandId: string;
  sequence: number;
  aggregateVersion: number;
  eventType: string;
  eventVersion: number;
  payload: Readonly<Record<string, unknown>>;
}>;

type LedgerTransactionRecord = Readonly<{
  id: string;
  restaurantId: string;
  saveId: string;
  commandId: string;
  actorId: string;
  kind: string;
  currency: string;
  reason: string;
  reversesTransactionId: unknown;
}>;

type LedgerLineRecord = Readonly<{
  transactionId: string;
  restaurantId: string;
  saveId: string;
  sequence: number;
  accountCode: string;
  direction: string;
  amountMinor: string;
}>;

type ConfigureState = {
  version: number;
  receipts: Map<string, Receipt>;
  businessDays: BusinessDayRecord[];
  snapshots: PreopenSnapshotRecord[];
  ledgerTransactions: LedgerTransactionRecord[];
  ledgerLines: LedgerLineRecord[];
  outbox: OutboxRecord[];
};

class ConfigureDatabase implements D03Database {
  scopeAllowed = true;
  authorityAvailable = true;
  failSnapshotInsert = false;
  failLedgerLineInsert = false;
  authoritySnapshot = openingSnapshot;
  readonly calls: Readonly<{ query: string; values: readonly unknown[] }>[] = [];
  private state: ConfigureState = {
    version: 1,
    receipts: new Map(),
    businessDays: [],
    snapshots: [],
    ledgerTransactions: [],
    ledgerLines: [],
    outbox: [],
  };

  get version() {
    return this.state.version;
  }

  get receiptCount() {
    return this.state.receipts.size;
  }

  get businessDays(): readonly BusinessDayRecord[] {
    return this.state.businessDays;
  }

  get snapshots(): readonly PreopenSnapshotRecord[] {
    return this.state.snapshots;
  }

  get ledgerTransactions(): readonly LedgerTransactionRecord[] {
    return this.state.ledgerTransactions;
  }

  get ledgerLines(): readonly LedgerLineRecord[] {
    return this.state.ledgerLines;
  }

  get outbox(): readonly OutboxRecord[] {
    return this.state.outbox;
  }

  async $transaction<T>(operation: (transaction: D03Queryable) => Promise<T>): Promise<T> {
    const next = cloneState(this.state);
    const transaction: D03Queryable = {
      $queryRawUnsafe: async <R>(query: string, ...values: readonly unknown[]): Promise<R> => {
        (this.calls as { query: string; values: readonly unknown[] }[]).push({ query, values });
        if (query.includes('INSERT INTO "IdempotencyRecord"')) {
          const key = JSON.stringify([values[3], values[4]]);
          if (next.receipts.has(key)) return [] as R;
          next.receipts.set(key, {
            commandId: String(values[0]),
            fingerprint: String(values[5]),
            snapshot: undefined,
          });
          return [{ id: values[0] }] as R;
        }
        if (query.includes('SELECT "id" AS "commandId"')) {
          const receipt = next.receipts.get(JSON.stringify([values[0], values[1]]));
          if (!receipt) throw new Error('missing stored receipt');
          return [
            {
              commandId: receipt.commandId,
              requestFingerprint: receipt.fingerprint,
              status: 'COMPLETED',
              responseSnapshot: receipt.snapshot,
            },
          ] as R;
        }
        if (query.includes('SELECT save."version"')) {
          return (this.scopeAllowed ? [{ version: next.version }] : []) as R;
        }
        if (query.includes('/* configure-preopen-day:scope */')) {
          if (!this.authorityAvailable) return [] as R;
          const existingDay = next.businessDays[0];
          const existingSnapshotCount = next.snapshots.length;
          return [
            {
              saveId: 'save-1',
              openingScenario: 'DEFAULT_SMALL_SHOP',
              operatingMode: 'STRATEGY',
              servicePeriodPlan: 'TWO_PERIODS',
              demandSeed: DEMAND_SEED,
              simulationRuleVersion: this.authoritySnapshot.simulationRuleVersion,
              settlementCurrency: 'TWD',
              openingSnapshot: this.authoritySnapshot,
              openingSnapshotHash: this.authoritySnapshot.openingSnapshotHash,
              existingBusinessDayId: existingDay?.id ?? null,
              existingBusinessDayStatus: existingDay?.status ?? null,
              existingPreopenSnapshotCount: existingSnapshotCount,
            },
          ] as R;
        }
        if (query.includes('/* configure-preopen-day:authority */')) {
          if (!this.authorityAvailable) return [] as R;
          const base = {
            marketSaveId: 'save-1',
            marketSeed: MARKET_SEED,
            marketSeedVersion: MVP_FIRST_DAY_MARKET_SEED_VERSION,
          };
          return [
            {
              ...base,
              poolSaveId: 'save-1',
              pool: 'DURABLE',
              revision: 1,
              capacityPoints: 305n,
              storageBundleVersion: 'mvp-storage/v1',
              storageBundleKind: 'BASIC',
            },
            {
              ...base,
              poolSaveId: 'save-1',
              pool: 'PERISHABLE',
              revision: 1,
              capacityPoints: 305n,
              storageBundleVersion: 'mvp-storage/v1',
              storageBundleKind: 'BASIC',
            },
          ] as R;
        }
        if (query.includes('/* configure-preopen-day:create-business-day */')) {
          if (next.businessDays.length > 0) return [] as R;
          const day: BusinessDayRecord = {
            id: String(values[0]),
            restaurantId: String(values[1]),
            saveId: String(values[2]),
            businessDay: 1,
            status: 'PREOPEN',
            servicePeriodPlan: String(values[3]),
            simulationRuleVersion: String(values[4]),
            commandId: String(values[5]),
          };
          next.businessDays.push(day);
          return [{ businessDayId: day.id }] as R;
        }
        if (query.includes('/* configure-preopen-day:create-snapshot */')) {
          if (this.failSnapshotInsert) throw new Error('injected snapshot insert failure');
          if (next.businessDays.length !== 1) {
            throw new Error('snapshot insert must observe the earlier business day insert');
          }
          if (next.snapshots.length > 0) return [] as R;
          const payload = JSON.parse(String(values[6])) as Readonly<Record<string, unknown>>;
          const snapshot: PreopenSnapshotRecord = {
            id: String(values[0]),
            restaurantId: String(values[1]),
            saveId: String(values[2]),
            businessDay: 1,
            revision: 1,
            commandId: String(values[3]),
            schemaVersion: String(values[4]),
            simulationRuleVersion: String(values[5]),
            payload,
            snapshotHash: String(values[7]),
          };
          next.snapshots.push(snapshot);
          return [
            {
              preopenSnapshotId: snapshot.id,
              snapshotHash: snapshot.snapshotHash,
              payloadHash: payload.preopenSnapshotHash,
            },
          ] as R;
        }
        if (query.includes('INSERT INTO "LedgerTransaction"')) {
          next.ledgerTransactions.push({
            id: String(values[0]),
            restaurantId: String(values[1]),
            saveId: String(values[2]),
            commandId: String(values[0]),
            actorId: String(values[3]),
            kind: String(values[4]),
            currency: String(values[5]),
            reason: String(values[6]),
            reversesTransactionId: values[7],
          });
          return [] as R;
        }
        if (query.includes('INSERT INTO "LedgerLine"')) {
          if (this.failLedgerLineInsert) throw new Error('injected ledger line insert failure');
          next.ledgerLines.push({
            transactionId: String(values[0]),
            restaurantId: String(values[1]),
            saveId: String(values[2]),
            sequence: Number(values[3]),
            accountCode: String(values[4]),
            direction: String(values[5]),
            amountMinor: String(values[6]),
          });
          return [] as R;
        }
        if (query.includes('INSERT INTO "OutboxEvent"')) {
          next.outbox.push({
            id: String(values[0]),
            restaurantId: String(values[1]),
            saveId: String(values[2]),
            transactionId: values[3],
            commandId: String(values[4]),
            sequence: Number(values[5]),
            aggregateVersion: Number(values[6]),
            eventType: String(values[7]),
            eventVersion: Number(values[8]),
            payload: JSON.parse(String(values[9])) as Readonly<Record<string, unknown>>,
          });
          return [] as R;
        }
        if (query.includes('UPDATE "CompetitiveSave"')) {
          if (next.version !== Number(values[2])) return [] as R;
          next.version = Number(values[3]);
          return [{ version: next.version }] as R;
        }
        if (query.includes('UPDATE "IdempotencyRecord"')) {
          const entry = [...next.receipts.entries()].find(
            ([, receipt]) => receipt.commandId === values[0],
          );
          if (!entry) throw new Error('missing command receipt');
          next.receipts.set(entry[0], {
            ...entry[1],
            snapshot: JSON.parse(String(values[1])) as unknown,
          });
          return [] as R;
        }
        throw new Error(`unexpected query: ${query}`);
      },
    };
    const result = await operation(transaction);
    this.state = next;
    return result;
  }
}

function cloneState(state: ConfigureState): ConfigureState {
  return {
    version: state.version,
    receipts: new Map(state.receipts),
    businessDays: [...state.businessDays],
    snapshots: [...state.snapshots],
    ledgerTransactions: [...state.ledgerTransactions],
    ledgerLines: [...state.ledgerLines],
    outbox: [...state.outbox],
  };
}

function dispatch(database: ConfigureDatabase, command: CommandEnvelope) {
  const dispatcher = new CommandDispatcher(
    [createConfigurePreopenDayCommandHandler()],
    new PostgresDurableCommandExecutionStore(database),
  );
  return dispatcher.dispatch({
    context,
    target: { saveId: 'save-1', commandType: CONFIGURE_PREOPEN_DAY },
    envelope: command,
  });
}

test('normal durable composition registers CONFIGURE and atomically persists one immutable first-day plan', async () => {
  const database = new ConfigureDatabase();
  const response = await dispatch(database, configureCommand());

  assert.equal(response.status, 200);
  const body = response.body;
  assert.equal(body.aggregateVersion, 2);
  const result = body.result as Readonly<Record<string, unknown>>;
  assert.deepEqual(Object.keys(result).sort(), ['competitiveSave', 'preopenDaySnapshot']);
  assert.deepEqual(result.competitiveSave, { id: 'save-1', version: 2 });
  assert.equal(database.version, 2);
  assert.equal(database.receiptCount, 1);
  assert.equal(database.businessDays.length, 1);
  assert.deepEqual(database.businessDays[0], {
    id: `business-day:${COMMAND_ID}`,
    restaurantId: 'restaurant-1',
    saveId: 'save-1',
    businessDay: 1,
    status: 'PREOPEN',
    servicePeriodPlan: 'TWO_PERIODS',
    simulationRuleVersion: openingSnapshot.simulationRuleVersion,
    commandId: COMMAND_ID,
  });
  assert.equal(database.snapshots.length, 1);
  const snapshot = database.snapshots[0]!;
  assert.equal(snapshot.id, `preopen:${COMMAND_ID}`);
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.commandId, COMMAND_ID);
  assert.equal(snapshot.payload.preopenSnapshotHash, snapshot.snapshotHash);
  assert.equal(snapshot.payload.preopenSnapshotId, snapshot.id);
  assert.equal(snapshot.payload.saveId, 'save-1');
  assert.equal(
    (snapshot.payload.demandSchedule as Readonly<{ demandSeed: string }>).demandSeed,
    DEMAND_SEED,
    'private replay seed belongs only in the private snapshot',
  );

  assert.deepEqual(database.ledgerTransactions, [
    {
      id: COMMAND_ID,
      restaurantId: 'restaurant-1',
      saveId: 'save-1',
      commandId: COMMAND_ID,
      actorId: 'player-1',
      kind: 'POSTING',
      currency: 'TWD',
      reason: `MVP Day 1 pre-open procurement from ${snapshot.snapshotHash}`,
      reversesTransactionId: null,
    },
  ]);
  assert.deepEqual(database.ledgerLines, [
    {
      transactionId: COMMAND_ID,
      restaurantId: 'restaurant-1',
      saveId: 'save-1',
      sequence: 0,
      accountCode: 'ASSET:INVENTORY',
      direction: 'DEBIT',
      amountMinor: '60',
    },
    {
      transactionId: COMMAND_ID,
      restaurantId: 'restaurant-1',
      saveId: 'save-1',
      sequence: 1,
      accountCode: 'CASH:SETTLEMENT',
      direction: 'CREDIT',
      amountMinor: '60',
    },
  ]);
  const debit = database.ledgerLines
    .filter((line) => line.direction === 'DEBIT')
    .reduce((total, line) => total + BigInt(line.amountMinor), 0n);
  const credit = database.ledgerLines
    .filter((line) => line.direction === 'CREDIT')
    .reduce((total, line) => total + BigInt(line.amountMinor), 0n);
  assert.equal(debit, credit);
  assert.equal(debit, 60n);

  assert.equal(database.outbox.length, 1);
  const outbox = database.outbox[0]!;
  assert.equal(outbox.id, COMMAND_ID);
  assert.equal(outbox.transactionId, COMMAND_ID);
  assert.equal(outbox.commandId, COMMAND_ID);
  assert.equal(outbox.eventType, PREOPEN_DAY_CONFIGURED_EVENT_TYPE);
  assert.equal(outbox.eventVersion, 1);
  assert.deepEqual(Object.keys(outbox.payload).sort(), [
    'businessDay',
    'preopenSnapshotHash',
    'preopenSnapshotId',
    'schemaVersion',
    'simulationRuleVersion',
    'snapshotSchemaVersion',
  ]);
  const publicEvent = JSON.stringify(outbox.payload);
  for (const secret of [
    DEMAND_SEED,
    MARKET_SEED,
    'demandSchedule',
    'inventoryProcurement',
    'openingSnapshot',
    'recipePreferenceOrder',
  ]) {
    assert.equal(publicEvent.includes(secret), false, `${secret} leaked into the outbox`);
  }
  for (const privateLedgerField of [
    'ASSET:INVENTORY',
    'CASH:SETTLEMENT',
    'amountMinor',
    'ledgerSummary',
  ]) {
    assert.equal(
      JSON.stringify(response).includes(privateLedgerField),
      false,
      `${privateLedgerField} leaked into the client response`,
    );
    assert.equal(
      publicEvent.includes(privateLedgerField),
      false,
      `${privateLedgerField} leaked into the outbox payload`,
    );
  }
});

test('zero spot purchases deliberately create no empty ledger transaction', async () => {
  const database = new ConfigureDatabase();
  const response = await dispatch(
    database,
    configureCommand({
      payload: { ...validPayload(), spotPurchaseDeltas: [] },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(database.snapshots.length, 1);
  assert.equal(database.ledgerTransactions.length, 0);
  assert.equal(database.ledgerLines.length, 0);
  assert.equal(database.outbox.length, 1);
  assert.equal(database.outbox[0]?.transactionId, null);
});

test('strict input rejection rolls back receipt and performs no gameplay/outbox writes', async () => {
  const database = new ConfigureDatabase();
  await assert.rejects(
    dispatch(
      database,
      configureCommand({
        payload: { ...validPayload(), demandSeed: 'client-forged-authority' },
      }),
    ),
    (error) =>
      error instanceof CommandError &&
      error.status === 422 &&
      error.code === 'PREOPEN_CONFIGURATION_INVALID',
  );
  assert.equal(database.receiptCount, 0);
  assert.equal(database.businessDays.length, 0);
  assert.equal(database.snapshots.length, 0);
  assert.equal(database.ledgerTransactions.length, 0);
  assert.equal(database.ledgerLines.length, 0);
  assert.equal(database.outbox.length, 0);
  assert.equal(
    database.calls.some(({ query }) => query.includes('configure-preopen-day:authority')),
    false,
  );
});

test('snapshot insertion follows BusinessDay insertion and failure rolls both writes back', async () => {
  const database = new ConfigureDatabase();
  database.failSnapshotInsert = true;
  await assert.rejects(dispatch(database, configureCommand()), /injected snapshot insert failure/);
  const gameplayInserts = database.calls
    .map(({ query }) => query)
    .filter((query) => query.includes('configure-preopen-day:create-'));
  assert.equal(gameplayInserts.length, 2);
  assert.equal(gameplayInserts[0]?.includes('create-business-day'), true);
  assert.equal(gameplayInserts[1]?.includes('create-snapshot'), true);
  assert.equal(database.receiptCount, 0);
  assert.equal(database.businessDays.length, 0);
  assert.equal(database.snapshots.length, 0);
  assert.equal(database.ledgerTransactions.length, 0);
  assert.equal(database.ledgerLines.length, 0);
  assert.equal(database.outbox.length, 0);
  assert.equal(database.version, 1);
});

test('ledger insertion failure rolls back receipt, plan, ledger, outbox, and save version', async () => {
  const database = new ConfigureDatabase();
  database.failLedgerLineInsert = true;
  await assert.rejects(
    dispatch(database, configureCommand()),
    /injected ledger line insert failure/,
  );
  assert.equal(database.receiptCount, 0);
  assert.equal(database.businessDays.length, 0);
  assert.equal(database.snapshots.length, 0);
  assert.equal(database.ledgerTransactions.length, 0);
  assert.equal(database.ledgerLines.length, 0);
  assert.equal(database.outbox.length, 0);
  assert.equal(database.version, 1);
});

test('D03 idempotency replays once while stale and different commands cannot overwrite day one', async () => {
  const database = new ConfigureDatabase();
  const first = await dispatch(database, configureCommand());
  assert.equal(first.status, 200);

  const replayed = await dispatch(
    database,
    configureCommand({ commandId: '22222222-2222-4222-8222-222222222222' }),
  );
  assert.equal(replayed.status, 200);
  assert.deepEqual(replayed, first);
  assert.equal(database.businessDays.length, 1);
  assert.equal(database.snapshots.length, 1);
  assert.equal(database.ledgerTransactions.length, 1);
  assert.equal(database.ledgerLines.length, 2);
  assert.equal(database.outbox.length, 1);

  const authorityReadsBeforeStale = database.calls.filter(({ query }) =>
    query.includes('configure-preopen-day:authority'),
  ).length;
  await assert.rejects(
    dispatch(
      database,
      configureCommand({
        commandId: '33333333-3333-4333-8333-333333333333',
        idempotencyKey: 'configure-preopen-stale',
      }),
    ),
    (error) =>
      error instanceof CommandError &&
      error.status === 409 &&
      error.code === 'EXPECTED_VERSION_CONFLICT',
  );
  assert.equal(
    database.calls.filter(({ query }) => query.includes('configure-preopen-day:authority')).length,
    authorityReadsBeforeStale,
  );

  await assert.rejects(
    dispatch(
      database,
      configureCommand({
        commandId: '44444444-4444-4444-8444-444444444444',
        idempotencyKey: 'configure-preopen-different',
        expectedVersion: 2,
      }),
    ),
    (error) =>
      error instanceof CommandError &&
      error.status === 409 &&
      error.code === 'PREOPEN_DAY_ALREADY_CONFIGURED',
  );
  assert.equal(database.receiptCount, 1, 'failed commands must roll their receipts back');
  assert.equal(database.businessDays.length, 1);
  assert.equal(database.snapshots.length, 1);
  assert.equal(database.ledgerTransactions.length, 1);
  assert.equal(database.ledgerLines.length, 2);
  assert.equal(database.outbox.length, 1);
});

test('forged opening accounting authority is rejected before gameplay or ledger writes', async () => {
  const database = new ConfigureDatabase();
  database.authoritySnapshot = Object.freeze({
    ...openingSnapshot,
    settlementCash: Object.freeze({
      ...openingSnapshot.settlementCash,
      amount: Object.freeze({
        ...openingSnapshot.settlementCash.amount,
        minorUnits: '999999999',
      }),
    }),
  });

  await assert.rejects(
    dispatch(database, configureCommand()),
    (error) =>
      error instanceof CommandError &&
      error.status === 503 &&
      error.code === 'PREOPEN_AUTHORITY_INVALID',
  );
  assert.equal(database.receiptCount, 0);
  assert.equal(database.businessDays.length, 0);
  assert.equal(database.snapshots.length, 0);
  assert.equal(database.ledgerTransactions.length, 0);
  assert.equal(database.ledgerLines.length, 0);
  assert.equal(database.outbox.length, 0);
  assert.equal(database.version, 1);
});

test('RBAC and durable scope both fail closed before authority lookup or writes', async () => {
  assert.equal(
    gameplaySaveScopedCommandAuthorizationPolicy.isAllowed(CONFIGURE_PREOPEN_DAY, 'OWNER'),
    true,
  );
  assert.equal(
    gameplaySaveScopedCommandAuthorizationPolicy.isAllowed(CONFIGURE_PREOPEN_DAY, 'MANAGER'),
    true,
  );
  assert.equal(
    gameplaySaveScopedCommandAuthorizationPolicy.isAllowed(CONFIGURE_PREOPEN_DAY, 'CASHIER'),
    false,
  );
  const compositionSource = readFileSync(new URL('../app-composition.ts', import.meta.url), 'utf8');
  assert.match(compositionSource, /createConfigurePreopenDayCommandHandler\(\)/);

  const scopedDatabase = new ConfigureDatabase();
  scopedDatabase.scopeAllowed = false;
  await assert.rejects(
    dispatch(scopedDatabase, configureCommand()),
    (error) =>
      error instanceof CommandError &&
      error.status === 403 &&
      error.code === 'LEDGER_SCOPE_FORBIDDEN',
  );
  assert.equal(scopedDatabase.receiptCount, 0);
  assert.equal(
    scopedDatabase.calls.some(({ query }) => query.includes('configure-preopen-day:authority')),
    false,
  );
  assert.equal(scopedDatabase.businessDays.length, 0);
  assert.equal(scopedDatabase.snapshots.length, 0);
  assert.equal(scopedDatabase.ledgerTransactions.length, 0);
  assert.equal(scopedDatabase.ledgerLines.length, 0);
  assert.equal(scopedDatabase.outbox.length, 0);
});
