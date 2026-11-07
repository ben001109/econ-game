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
  BUSINESS_DAY_OPENED_EVENT_TYPE,
  OPEN_BUSINESS_DAY,
  createOpenBusinessDayCommandHandler,
} from './open-business-day-command.js';
import { gameplaySaveScopedCommandAuthorizationPolicy } from './gameplay-command-authorization-policy.js';
import {
  MVP_FIRST_DAY_MARKET_SEED_VERSION,
  provideCanonicalFirstDayPreopenArtifacts,
} from './preopen-day-authority-provider.js';
import { parseConfigurePreopenDayIntent } from './preopen-day-contract.js';
import { createPreopenDayPlan } from './preopen-day-plan.js';

const CONFIGURE_COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const OPEN_COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const DEMAND_SEED = 'server-demand-seed-1';
const MARKET_SEED = 'independent-market-seed-1';

const context: TrustedCommandContext = Object.freeze({
  actorId: 'player-1',
  tenantId: 'restaurant-1',
  saveId: 'save-1',
  roles: ['OWNER'],
  membershipId: 'membership-1',
  branchScope: { kind: 'all' as const },
  principal: { type: 'web' as const },
});

function createConfiguredAuthority(
  scenario: 'DEFAULT_SMALL_SHOP' | 'EMPTY_PREMISES' = 'DEFAULT_SMALL_SHOP',
) {
  const openingSnapshot = createOpeningSnapshot(
    { scenario, operatingMode: 'STRATEGY', currency: 'TWD' },
    MVP_OPENING_VERSIONS,
  );
  const empty = scenario === 'EMPTY_PREMISES';
  const capacity = empty ? 0 : 305;
  const storageKind = empty ? 'NONE' : 'BASIC';
  const snapshotId = `preopen:${CONFIGURE_COMMAND_ID}`;
  const artifacts = provideCanonicalFirstDayPreopenArtifacts({
    command: {
      commandId: CONFIGURE_COMMAND_ID,
      preopenSnapshotId: snapshotId,
      businessDay: 1,
      currentLayoutRevision: 0,
    },
    save: {
      id: 'save-1',
      scenario,
      operatingMode: 'STRATEGY',
      servicePeriodPlan: 'TWO_PERIODS',
      demandSeed: DEMAND_SEED,
      simulationRuleVersion: openingSnapshot.simulationRuleVersion,
      settlementCurrency: 'TWD',
      openingSnapshot,
      openingSnapshotHash: openingSnapshot.openingSnapshotHash,
    },
    marketSeedAuthority: {
      saveId: 'save-1',
      seed: MARKET_SEED,
      seedVersion: MVP_FIRST_DAY_MARKET_SEED_VERSION,
    },
    inventoryPoolAuthorities: [
      {
        saveId: 'save-1',
        pool: 'DURABLE',
        revision: 1,
        capacityPoints: capacity,
        storageBundleVersion: 'mvp-storage/v1',
        storageBundleKind: storageKind,
      },
      {
        saveId: 'save-1',
        pool: 'PERISHABLE',
        revision: 1,
        capacityPoints: capacity,
        storageBundleVersion: 'mvp-storage/v1',
        storageBundleKind: storageKind,
      },
    ],
    spotPurchaseIdFactory: {
      create: ({ ingredientId }) => ({
        transactionId: `spot-transaction:${ingredientId}`,
        purchaseId: `spot-purchase:${ingredientId}`,
      }),
    },
  });
  const plan = createPreopenDayPlan(
    parseConfigurePreopenDayIntent({
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
        width: empty ? 9 : 10,
        height: empty ? 8 : 9,
        servicePoint: { x: 0, y: 0 },
        fixtures: [
          { fixtureId: 'walkway-1', kind: 'WALKWAY', x: 1, y: 0 },
          { fixtureId: 'seat-1', kind: 'SEAT', x: 2, y: 0 },
          { fixtureId: 'waiting-1', kind: 'WAITING_ZONE', x: 1, y: 1 },
        ],
      },
      spotPurchaseDeltas: [],
    }),
    artifacts,
  );
  return {
    openingSnapshot,
    plan,
    storageKind,
    capacity,
  };
}

function openCommand(
  database: OpenDatabase,
  overrides: Partial<CommandEnvelope> = {},
): CommandEnvelope {
  return {
    schemaVersion: COMMAND_ENVELOPE_VERSION,
    commandId: OPEN_COMMAND_ID,
    idempotencyKey: 'open-business-day-1',
    commandType: OPEN_BUSINESS_DAY,
    aggregateId: 'save-1',
    expectedVersion: 2,
    payload: {
      preopenSnapshotId: database.snapshot.id,
      preopenSnapshotHash: database.snapshot.snapshotHash,
    },
    ...overrides,
  };
}

type Receipt = Readonly<{
  commandId: string;
  fingerprint: string;
  snapshot: unknown;
}>;

type BusinessDayRecord = {
  id: string;
  status: 'PREOPEN' | 'OPEN';
  openedByCommandId: string | null;
  consumedPreopenSnapshotId: string | null;
  openSnapshot: Readonly<Record<string, unknown>> | null;
  openSnapshotHash: string | null;
  openedAt: string | null;
};

type SnapshotRecord = Readonly<{
  id: string;
  commandId: string;
  payload: Readonly<Record<string, unknown>>;
  snapshotHash: string;
  snapshotSchemaVersion: string;
  simulationRuleVersion: string;
}>;

type OutboxRecord = Readonly<{
  id: string;
  transactionId: unknown;
  commandId: string;
  eventType: string;
  eventVersion: number;
  payload: Readonly<Record<string, unknown>>;
}>;

type OpenState = {
  version: number;
  receipts: Map<string, Receipt>;
  businessDay: BusinessDayRecord;
  snapshot: SnapshotRecord;
  outbox: OutboxRecord[];
};

class OpenDatabase implements D03Database {
  readonly configured;
  scopeAllowed = true;
  authorityAvailable = true;
  failTransition = false;
  readonly calls: { query: string; values: readonly unknown[] }[] = [];
  private state: OpenState;

  constructor(scenario: 'DEFAULT_SMALL_SHOP' | 'EMPTY_PREMISES' = 'DEFAULT_SMALL_SHOP') {
    this.configured = createConfiguredAuthority(scenario);
    this.state = {
      version: 2,
      receipts: new Map(),
      businessDay: {
        id: `business-day:${CONFIGURE_COMMAND_ID}`,
        status: 'PREOPEN',
        openedByCommandId: null,
        consumedPreopenSnapshotId: null,
        openSnapshot: null,
        openSnapshotHash: null,
        openedAt: null,
      },
      snapshot: {
        id: this.configured.plan.privateEnvelope.preopenSnapshotId,
        commandId: CONFIGURE_COMMAND_ID,
        payload: this.configured.plan.privateEnvelope,
        snapshotHash: this.configured.plan.privateEnvelope.preopenSnapshotHash,
        snapshotSchemaVersion: this.configured.plan.privateEnvelope.envelopeVersion,
        simulationRuleVersion: this.configured.openingSnapshot.simulationRuleVersion,
      },
      outbox: [],
    };
  }

  get version() {
    return this.state.version;
  }

  get receiptCount() {
    return this.state.receipts.size;
  }

  get businessDay() {
    return this.state.businessDay;
  }

  get snapshot() {
    return this.state.snapshot;
  }

  get outbox() {
    return this.state.outbox;
  }

  setBusinessDayState(status: 'PREOPEN' | 'OPEN', consumed = false) {
    this.state.businessDay = {
      ...this.state.businessDay,
      status,
      ...(consumed
        ? {
            openedByCommandId: 'prior-open-command',
            consumedPreopenSnapshotId: this.state.snapshot.id,
            openSnapshot: this.state.snapshot.payload,
            openSnapshotHash: this.state.snapshot.snapshotHash,
            openedAt: '2026-08-23T00:00:00.000Z',
          }
        : {}),
    };
  }

  replaceSnapshot(snapshot: SnapshotRecord) {
    this.state.snapshot = snapshot;
  }

  async $transaction<T>(operation: (transaction: D03Queryable) => Promise<T>): Promise<T> {
    const next = cloneState(this.state);
    const transaction: D03Queryable = {
      $queryRawUnsafe: async <R>(query: string, ...values: readonly unknown[]): Promise<R> => {
        this.calls.push({ query, values });
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
        if (query.includes('/* open-business-day:scope */')) {
          if (!this.authorityAvailable) return [] as R;
          const day = next.businessDay;
          const snapshot = next.snapshot;
          return [
            {
              saveId: 'save-1',
              openingScenario: this.configured.openingSnapshot.scenario,
              operatingMode: this.configured.openingSnapshot.operatingMode,
              saveServicePeriodPlan: 'TWO_PERIODS',
              demandSeed: DEMAND_SEED,
              saveSimulationRuleVersion: this.configured.openingSnapshot.simulationRuleVersion,
              openingSnapshot: this.configured.openingSnapshot,
              openingSnapshotHash: this.configured.openingSnapshot.openingSnapshotHash,
              businessDayId: day.id,
              businessDayStatus: day.status,
              businessDayServicePeriodPlan: 'TWO_PERIODS',
              businessDaySimulationRuleVersion:
                this.configured.openingSnapshot.simulationRuleVersion,
              openedByCommandId: day.openedByCommandId,
              consumedPreopenSnapshotId: day.consumedPreopenSnapshotId,
              openSnapshot: day.openSnapshot,
              openSnapshotHash: day.openSnapshotHash,
              openedAt: day.openedAt,
              preopenSnapshotId: snapshot.id,
              preopenRevision: 1,
              preopenCommandId: snapshot.commandId,
              preopenSnapshotSchemaVersion: snapshot.snapshotSchemaVersion,
              preopenSimulationRuleVersion: snapshot.simulationRuleVersion,
              preopenPayload: snapshot.payload,
              preopenSnapshotHash: snapshot.snapshotHash,
            },
          ] as R;
        }
        if (query.includes('/* open-business-day:inventory-pools */')) {
          const base = {
            saveId: 'save-1',
            revision: 1,
            capacityPoints: BigInt(this.configured.capacity),
            storageBundleVersion: 'mvp-storage/v1',
            storageBundleKind: this.configured.storageKind,
          };
          return [
            { ...base, pool: 'DURABLE' },
            { ...base, pool: 'PERISHABLE' },
          ] as R;
        }
        if (query.includes('/* open-business-day:transition */')) {
          if (this.failTransition) throw new Error('injected open transition failure');
          const day = next.businessDay;
          if (day.status !== 'PREOPEN' || day.openedByCommandId !== null) return [] as R;
          const privatePayload = JSON.parse(String(values[5])) as Readonly<Record<string, unknown>>;
          if (
            values[4] !== next.snapshot.id ||
            values[6] !== next.snapshot.snapshotHash ||
            JSON.stringify(privatePayload) !== JSON.stringify(next.snapshot.payload)
          ) {
            throw Object.assign(new Error('trigger rejected mismatched immutable snapshot'), {
              code: '23514',
            });
          }
          next.businessDay = {
            ...day,
            status: 'OPEN',
            openedByCommandId: String(values[3]),
            consumedPreopenSnapshotId: String(values[4]),
            openSnapshot: privatePayload,
            openSnapshotHash: String(values[6]),
            openedAt: '2026-08-23T00:00:00.000Z',
          };
          return [
            {
              businessDayId: day.id,
              status: 'OPEN',
              consumedPreopenSnapshotId: values[4],
              openSnapshotHash: values[6],
            },
          ] as R;
        }
        if (query.includes('INSERT INTO "OutboxEvent"')) {
          next.outbox.push({
            id: String(values[0]),
            transactionId: values[3],
            commandId: String(values[4]),
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
        if (query.includes('LedgerTransaction') || query.includes('LedgerLine')) {
          throw new Error('OPEN_BUSINESS_DAY must not write a ledger movement');
        }
        throw new Error(`unexpected query: ${query}`);
      },
    };
    const result = await operation(transaction);
    this.state = next;
    return result;
  }
}

function cloneState(state: OpenState): OpenState {
  return {
    version: state.version,
    receipts: new Map(state.receipts),
    businessDay: { ...state.businessDay },
    snapshot: state.snapshot,
    outbox: [...state.outbox],
  };
}

function dispatch(database: OpenDatabase, command: CommandEnvelope) {
  return new CommandDispatcher(
    [createOpenBusinessDayCommandHandler()],
    new PostgresDurableCommandExecutionStore(database),
  ).dispatch({
    context,
    target: { saveId: 'save-1', commandType: OPEN_BUSINESS_DAY },
    envelope: command,
  });
}

test('OPEN atomically consumes the exact immutable snapshot and emits only safe public evidence', async () => {
  const database = new OpenDatabase();
  const immutableBefore = JSON.stringify(database.snapshot);
  const response = await dispatch(database, openCommand(database));

  assert.equal(response.status, 200);
  assert.equal(response.body.aggregateVersion, 3);
  assert.equal(database.version, 3);
  assert.equal(database.receiptCount, 1);
  assert.equal(database.businessDay.status, 'OPEN');
  assert.equal(database.businessDay.openedByCommandId, OPEN_COMMAND_ID);
  assert.equal(database.businessDay.consumedPreopenSnapshotId, database.snapshot.id);
  assert.equal(database.businessDay.openSnapshotHash, database.snapshot.snapshotHash);
  assert.deepEqual(database.businessDay.openSnapshot, database.snapshot.payload);
  assert.equal(JSON.stringify(database.snapshot), immutableBefore);

  const result = response.body.result as Readonly<Record<string, unknown>>;
  assert.deepEqual(Object.keys(result).sort(), [
    'businessDay',
    'competitiveSave',
    'demandForecast',
    'preopenDaySnapshot',
  ]);
  const serializedResult = JSON.stringify(result);
  for (const secret of [DEMAND_SEED, MARKET_SEED, 'demandSchedule', 'recipePreferenceOrder']) {
    assert.equal(serializedResult.includes(secret), false, `${secret} leaked to public result`);
  }

  assert.equal(database.outbox.length, 1);
  const outbox = database.outbox[0]!;
  assert.equal(outbox.id, OPEN_COMMAND_ID);
  assert.equal(outbox.transactionId, null);
  assert.equal(outbox.commandId, OPEN_COMMAND_ID);
  assert.equal(outbox.eventType, BUSINESS_DAY_OPENED_EVENT_TYPE);
  assert.equal(outbox.eventVersion, 1);
  assert.deepEqual(Object.keys(outbox.payload).sort(), [
    'businessDay',
    'businessDayId',
    'preopenSnapshotHash',
    'preopenSnapshotId',
    'schemaVersion',
    'simulationRuleVersion',
  ]);
  const serializedOutbox = JSON.stringify(outbox.payload);
  for (const secret of [DEMAND_SEED, MARKET_SEED, 'inventory', 'cash', 'groups']) {
    assert.equal(serializedOutbox.includes(secret), false, `${secret} leaked to outbox`);
  }
  assert.equal(
    database.calls.some(({ query }) => query.includes('LedgerTransaction')),
    false,
  );
  const openQueries = database.calls
    .map(({ query }) => query)
    .filter((query) => query.includes('open-business-day:'));
  assert.equal(openQueries[0]?.includes('FOR UPDATE OF day'), true);
  assert.equal(openQueries[0]?.includes('FOR SHARE OF save, membership, snapshot'), true);
  assert.equal(openQueries[1]?.includes('FOR SHARE OF pool'), true);
  assert.equal(openQueries[2]?.includes('open-business-day:transition'), true);
});

test('D03 idempotency replays once and stale version rejects before OPEN authority reads', async () => {
  const database = new OpenDatabase();
  const first = await dispatch(database, openCommand(database));
  const replay = await dispatch(
    database,
    openCommand(database, { commandId: '33333333-3333-4333-8333-333333333333' }),
  );
  assert.deepEqual(replay, first);
  assert.equal(database.outbox.length, 1);

  const readsBefore = database.calls.filter(({ query }) =>
    query.includes('open-business-day:scope'),
  ).length;
  await assert.rejects(
    dispatch(
      database,
      openCommand(database, {
        commandId: '44444444-4444-4444-8444-444444444444',
        idempotencyKey: 'open-stale',
        expectedVersion: 2,
      }),
    ),
    (error) =>
      error instanceof CommandError &&
      error.status === 409 &&
      error.code === 'EXPECTED_VERSION_CONFLICT',
  );
  assert.equal(
    database.calls.filter(({ query }) => query.includes('open-business-day:scope')).length,
    readsBefore,
  );
});

test('strict input and snapshot pins reject without OPEN transition or outbox side effects', async () => {
  for (const payload of [
    { preopenSnapshotId: 'other-scope-snapshot', preopenSnapshotHash: 'a'.repeat(64) },
    {
      preopenSnapshotId: `preopen:${CONFIGURE_COMMAND_ID}`,
      preopenSnapshotHash: 'b'.repeat(64),
    },
    {
      preopenSnapshotId: `preopen:${CONFIGURE_COMMAND_ID}`,
      preopenSnapshotHash: 'a'.repeat(64),
      demandSeed: 'client-forged',
    },
  ]) {
    const database = new OpenDatabase();
    await assert.rejects(
      dispatch(database, openCommand(database, { payload })),
      (error) =>
        error instanceof CommandError &&
        error.status === 422 &&
        (error.code === 'PREOPEN_SNAPSHOT_PIN_MISMATCH' ||
          error.code === 'OPEN_BUSINESS_DAY_INTENT_INVALID'),
    );
    assert.equal(database.receiptCount, 0);
    assert.equal(database.businessDay.status, 'PREOPEN');
    assert.equal(database.outbox.length, 0);
    assert.equal(
      database.calls.some(({ query }) => query.includes('open-business-day:transition')),
      false,
    );
  }
});

test('tampered private payload and failed transition roll back receipt, day, version, and outbox', async () => {
  const tampered = new OpenDatabase();
  tampered.replaceSnapshot({
    ...tampered.snapshot,
    payload: {
      ...tampered.snapshot.payload,
      demandSchedule: {
        ...(tampered.snapshot.payload.demandSchedule as Readonly<Record<string, unknown>>),
        demandSeed: 'tampered-seed',
      },
    },
  });
  await assert.rejects(
    dispatch(tampered, openCommand(tampered)),
    (error) =>
      error instanceof CommandError &&
      error.status === 503 &&
      error.code === 'PREOPEN_SNAPSHOT_AUTHORITY_INVALID',
  );
  assert.equal(tampered.receiptCount, 0);
  assert.equal(tampered.businessDay.status, 'PREOPEN');
  assert.equal(tampered.version, 2);
  assert.equal(tampered.outbox.length, 0);

  const failed = new OpenDatabase();
  failed.failTransition = true;
  await assert.rejects(dispatch(failed, openCommand(failed)), /injected open transition failure/);
  assert.equal(failed.receiptCount, 0);
  assert.equal(failed.businessDay.status, 'PREOPEN');
  assert.equal(failed.version, 2);
  assert.equal(failed.outbox.length, 0);
});

test('non-PREOPEN or already consumed day cannot be reopened or overwritten', async () => {
  for (const consumed of [false, true]) {
    const database = new OpenDatabase();
    database.setBusinessDayState('OPEN', consumed);
    await assert.rejects(
      dispatch(database, openCommand(database)),
      (error) =>
        error instanceof CommandError &&
        error.status === 409 &&
        error.code === 'BUSINESS_DAY_NOT_PREOPEN',
    );
    assert.equal(database.receiptCount, 0);
    assert.equal(database.version, 2);
    assert.equal(database.outbox.length, 0);
  }
});

test('EMPTY NONE/0 authority cannot open and no BASIC installation is invented', async () => {
  const database = new OpenDatabase('EMPTY_PREMISES');
  await assert.rejects(
    dispatch(database, openCommand(database)),
    (error) =>
      error instanceof CommandError &&
      error.status === 422 &&
      error.code === 'OPEN_STORAGE_NOT_INSTALLED',
  );
  assert.equal(database.receiptCount, 0);
  assert.equal(database.businessDay.status, 'PREOPEN');
  assert.equal(database.outbox.length, 0);
  assert.equal(
    database.calls.some(({ query }) => query.includes('open-business-day:transition')),
    false,
  );
});

test('normal composition, RBAC, durable scope, and unknown command handling fail closed', async () => {
  assert.equal(
    gameplaySaveScopedCommandAuthorizationPolicy.isAllowed(OPEN_BUSINESS_DAY, 'OWNER'),
    true,
  );
  assert.equal(
    gameplaySaveScopedCommandAuthorizationPolicy.isAllowed(OPEN_BUSINESS_DAY, 'MANAGER'),
    true,
  );
  assert.equal(
    gameplaySaveScopedCommandAuthorizationPolicy.isAllowed(OPEN_BUSINESS_DAY, 'CASHIER'),
    false,
  );
  assert.equal(
    gameplaySaveScopedCommandAuthorizationPolicy.isAllowed('UNKNOWN_OPEN', 'OWNER'),
    false,
  );
  const compositionSource = readFileSync(new URL('../app-composition.ts', import.meta.url), 'utf8');
  assert.match(compositionSource, /createOpenBusinessDayCommandHandler\(\)/);

  const denied = new OpenDatabase();
  denied.scopeAllowed = false;
  await assert.rejects(
    dispatch(denied, openCommand(denied)),
    (error) =>
      error instanceof CommandError &&
      error.status === 403 &&
      error.code === 'LEDGER_SCOPE_FORBIDDEN',
  );
  assert.equal(denied.receiptCount, 0);
  assert.equal(
    denied.calls.some(({ query }) => query.includes('open-business-day:scope')),
    false,
  );

  const unknownDatabase = new OpenDatabase();
  const unknown = { ...openCommand(unknownDatabase), commandType: 'UNKNOWN_OPEN' };
  await assert.rejects(
    new CommandDispatcher(
      [createOpenBusinessDayCommandHandler()],
      new PostgresDurableCommandExecutionStore(unknownDatabase),
    ).dispatch({
      context,
      target: { saveId: 'save-1', commandType: 'UNKNOWN_OPEN' },
      envelope: unknown,
    }),
    (error) =>
      error instanceof CommandError && error.status === 422 && error.code === 'UNKNOWN_COMMAND',
  );
  assert.equal(unknownDatabase.calls.length, 0);
});
