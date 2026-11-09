import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMAND_ENVELOPE_VERSION,
  CommandError,
  type CommandEnvelope,
  type TrustedCommandContext,
} from '../commands/command-contract.js';
import { CommandDispatcher } from '../commands/command-dispatcher.js';
import {
  PostgresDurableCommandExecutionStore,
  type D03Database,
  type D03Queryable,
} from '../domains/ledger/postgres-ledger-store.js';
import { createOpeningSnapshot } from '../domains/opening-scenario/snapshot.js';
import { MVP_OPENING_VERSIONS } from '../domains/opening-scenario/registry.js';
import {
  ADVANCE_SERVICE_PERIOD,
  SERVICE_PERIOD_COMPLETED_EVENT_TYPE,
  createAdvanceServicePeriodCommandHandler,
} from './advance-service-period-command.js';
import {
  MVP_FIRST_DAY_MARKET_SEED_VERSION,
  provideCanonicalFirstDayPreopenArtifacts,
} from './preopen-day-authority-provider.js';
import { parseConfigurePreopenDayIntent } from './preopen-day-contract.js';
import { createPreopenDayPlan } from './preopen-day-plan.js';

const LUNCH_ID = '33333333-3333-4333-8333-333333333333';
const DINNER_ID = '44444444-4444-4444-8444-444444444444';
const DEMAND_SEED = 'server-demand-seed-advance';
const MARKET_SEED = 'independent-market-seed-advance';
const context: TrustedCommandContext = Object.freeze({
  actorId: 'player-1',
  tenantId: 'restaurant-1',
  saveId: 'save-1',
  roles: ['OWNER'],
  membershipId: 'membership-1',
  branchScope: { kind: 'all' as const },
  principal: { type: 'web' as const },
});

function configured() {
  const openingSnapshot = createOpeningSnapshot(
    { scenario: 'DEFAULT_SMALL_SHOP', operatingMode: 'STRATEGY', currency: 'TWD' },
    MVP_OPENING_VERSIONS,
  );
  const artifacts = provideCanonicalFirstDayPreopenArtifacts({
    command: {
      commandId: '11111111-1111-4111-8111-111111111111',
      preopenSnapshotId: 'preopen:advance',
      businessDay: 1,
      currentLayoutRevision: 0,
    },
    save: {
      id: 'save-1',
      scenario: 'DEFAULT_SMALL_SHOP',
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
        capacityPoints: 305,
        storageBundleVersion: 'mvp-storage/v1',
        storageBundleKind: 'BASIC',
      },
      {
        saveId: 'save-1',
        pool: 'PERISHABLE',
        revision: 1,
        capacityPoints: 305,
        storageBundleVersion: 'mvp-storage/v1',
        storageBundleKind: 'BASIC',
      },
    ],
    spotPurchaseIdFactory: {
      create: ({ ingredientId }) => ({
        transactionId: `spot-tx:${ingredientId}`,
        purchaseId: `spot-buy:${ingredientId}`,
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
          'bistro-greens-rice-v1': 0,
          'bistro-herb-chicken-v1': 0,
        },
        enabledSubstitutionIds: ['bistro-chicken-rice-greens-v1'],
      },
      floorPlan: {
        width: 10,
        height: 9,
        servicePoint: { x: 1, y: 0 },
        fixtures: [
          ...Array.from({ length: 8 }, (_, index) => ({
            fixtureId: `walkway-${index + 1}`,
            kind: 'WALKWAY',
            x: 1,
            y: index + 1,
          })),
          ...Array.from({ length: 9 }, (_, index) => ({
            fixtureId: `seat-${index + 1}`,
            kind: 'SEAT',
            x: 2,
            y: index,
          })),
          ...Array.from({ length: 4 }, (_, index) => ({
            fixtureId: `waiting-${index + 1}`,
            kind: 'WAITING_ZONE',
            x: 0,
            y: index + 1,
          })),
        ],
      },
      spotPurchaseDeltas: [
        'bistro-rice',
        'bistro-sauce',
        'bistro-chicken',
        'bistro-greens',
        'bistro-herbs',
      ].map((ingredientId) => ({ ingredientId, quantityPoints: 20 })),
    }),
    artifacts,
  );
  return { openingSnapshot, plan };
}

type Receipt = { commandId: string; fingerprint: string; snapshot: unknown };
type Stock = {
  id: string;
  itemId: string;
  ingredientId: string;
  pool: string;
  version: number;
  onHand: number;
  reserved: number;
  cost: string;
};
type Audit = {
  commandId: string;
  commandSequence: number;
  ingredientId: string;
  metadata: Record<string, unknown>;
};
type Execution = {
  id: string;
  ordinal: number;
  periodKey: string;
  commandId: string;
  rule: string;
  input: Record<string, unknown>;
  inputHash: string;
  result: Record<string, unknown>;
  resultHash: string;
};
type State = {
  version: number;
  receipts: Map<string, Receipt>;
  dayStatus: 'OPEN' | 'SERVICE_COMPLETE';
  items: Map<string, Record<string, unknown>>;
  stocks: Map<string, Stock>;
  audits: Audit[];
  executions: Execution[];
  outbox: Record<string, unknown>[];
};

class AdvanceDatabase implements D03Database {
  readonly fixture = configured();
  readonly calls: string[] = [];
  failAt: string | undefined;
  private state: State = {
    version: 3,
    receipts: new Map(),
    dayStatus: 'OPEN',
    items: new Map(),
    stocks: new Map(),
    audits: [],
    executions: [],
    outbox: [],
  };
  get snapshot() {
    return structuredClone(this.state);
  }
  async $transaction<T>(operation: (transaction: D03Queryable) => Promise<T>): Promise<T> {
    const next = clone(this.state);
    const transaction: D03Queryable = {
      $queryRawUnsafe: async <R>(query: string, ...values: readonly unknown[]): Promise<R> => {
        this.calls.push(query);
        if (this.failAt && query.includes(this.failAt)) throw new Error(`injected ${this.failAt}`);
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
          const receipt = next.receipts.get(JSON.stringify([values[0], values[1]]))!;
          return [
            {
              commandId: receipt.commandId,
              requestFingerprint: receipt.fingerprint,
              status: 'COMPLETED',
              responseSnapshot: receipt.snapshot,
            },
          ] as R;
        }
        if (query.includes('SELECT save."version"')) return [{ version: next.version }] as R;
        if (query.includes('/* advance-service-period:scope */')) return [this.scopeRow(next)] as R;
        if (query.includes('/* advance-service-period:inventory-pools */'))
          return [
            {
              saveId: 'save-1',
              pool: 'DURABLE',
              revision: 1,
              capacityPoints: 305n,
              storageBundleVersion: 'mvp-storage/v1',
              storageBundleKind: 'BASIC',
            },
            {
              saveId: 'save-1',
              pool: 'PERISHABLE',
              revision: 1,
              capacityPoints: 305n,
              storageBundleVersion: 'mvp-storage/v1',
              storageBundleKind: 'BASIC',
            },
          ] as R;
        if (query.includes('/* advance-service-period:executions */'))
          return next.executions.map((entry) => ({
            id: entry.id,
            ordinal: entry.ordinal,
            periodKey: entry.periodKey,
            commandId: entry.commandId,
            simulationRuleVersion: entry.rule,
            inputSnapshot: entry.input,
            inputHash: entry.inputHash,
            resultSnapshot: entry.result,
            resultHash: entry.resultHash,
          })) as R;
        if (query.includes('/* advance-service-period:inventory-stocks */'))
          return [...next.stocks.values()]
            .sort((a, b) => a.ingredientId.localeCompare(b.ingredientId))
            .map((stock) => ({
              id: stock.id,
              inventoryItemId: stock.itemId,
              ingredientId: stock.ingredientId,
              pool: stock.pool,
              version: stock.version,
              onHand: stock.onHand,
              reservedUndelivered: stock.reserved,
              costPoolMinor: stock.cost,
            })) as R;
        if (query.includes('/* advance-service-period:inventory-audits */'))
          return next.audits.map((audit) => ({ ...audit })) as R;
        if (query.includes('/* advance-service-period:ensure-item */')) {
          if (![...next.items.values()].some((item) => item.stableKey === values[2]))
            next.items.set(String(values[0]), {
              id: values[0],
              stableKey: values[2],
              category: values[3],
              unit: 'POINT',
              perishable: values[4],
            });
          return [] as R;
        }
        if (query.includes('/* advance-service-period:validate-item */'))
          return [...next.items.values()].filter((item) => item.stableKey === values[1]) as R;
        if (query.includes('/* advance-service-period:ensure-stock */')) {
          if (!next.stocks.has(String(values[0]))) {
            const item = next.items.get(String(values[3]))!;
            next.stocks.set(String(values[0]), {
              id: String(values[0]),
              itemId: String(values[3]),
              ingredientId: String(item.stableKey),
              pool: item.perishable ? 'PERISHABLE' : 'DURABLE',
              version: 1,
              onHand: Number(values[4]),
              reserved: Number(values[5]),
              cost: String(values[6]),
            });
          }
          return [] as R;
        }
        if (query.includes('/* advance-service-period:validate-stock */')) {
          const stock = next.stocks.get(String(values[2]));
          return stock
            ? ([
                {
                  id: stock.id,
                  inventoryItemId: stock.itemId,
                  onHand: stock.onHand,
                  reservedUndelivered: stock.reserved,
                  costPoolMinor: stock.cost,
                },
              ] as R)
            : ([] as R);
        }
        if (query.includes('/* advance-service-period:mutate-stock */')) {
          const stock = next.stocks.get(String(values[2]))!;
          stock.version += 1;
          stock.onHand += Number(values[3]);
          stock.cost = (BigInt(stock.cost) - BigInt(String(values[4]))).toString();
          return [
            {
              version: stock.version,
              onHand: stock.onHand,
              reservedUndelivered: stock.reserved,
              costPoolMinor: stock.cost,
            },
          ] as R;
        }
        if (query.includes('/* advance-service-period:insert-inventory-audit */')) {
          const stock = next.stocks.get(String(values[3]))!;
          next.audits.push({
            commandId: String(values[5]),
            commandSequence: Number(values[6]),
            ingredientId: stock.ingredientId,
            metadata: JSON.parse(String(values[16])),
          });
          return [{ id: values[0], transactionId: values[4] }] as R;
        }
        if (query.includes('/* advance-service-period:verify-final-stock */')) {
          const stock = next.stocks.get(String(values[2]))!;
          return [
            {
              onHand: stock.onHand,
              reservedUndelivered: stock.reserved,
              costPoolMinor: stock.cost,
            },
          ] as R;
        }
        if (query.includes('/* advance-service-period:insert-execution */')) {
          const entry: Execution = {
            id: String(values[0]),
            ordinal: Number(values[3]),
            periodKey: String(values[4]),
            commandId: String(values[5]),
            rule: String(values[6]),
            input: JSON.parse(String(values[7])),
            inputHash: String(values[8]),
            result: JSON.parse(String(values[9])),
            resultHash: String(values[10]),
          };
          next.executions.push(entry);
          return [
            {
              id: entry.id,
              ordinal: entry.ordinal,
              periodKey: entry.periodKey,
              inputHash: entry.inputHash,
              resultHash: entry.resultHash,
            },
          ] as R;
        }
        if (query.includes('/* advance-service-period:complete-day */')) {
          if (next.dayStatus !== 'OPEN') return [] as R;
          next.dayStatus = 'SERVICE_COMPLETE';
          return [{ id: 'business-day:advance', status: next.dayStatus }] as R;
        }
        if (query.includes('INSERT INTO "OutboxEvent"')) {
          next.outbox.push({
            id: values[0],
            transactionId: values[3],
            commandId: values[4],
            eventType: values[7],
            payload: JSON.parse(String(values[9])),
          });
          return [] as R;
        }
        if (query.includes('UPDATE "CompetitiveSave"')) {
          if (next.version !== Number(values[2])) return [] as R;
          next.version = Number(values[3]);
          return [{ version: next.version }] as R;
        }
        if (query.includes('UPDATE "IdempotencyRecord"')) {
          const found = [...next.receipts.entries()].find(
            ([, receipt]) => receipt.commandId === values[0],
          )!;
          next.receipts.set(found[0], { ...found[1], snapshot: JSON.parse(String(values[1])) });
          return [] as R;
        }
        throw new Error(`unexpected query: ${query}`);
      },
    };
    const result = await operation(transaction);
    this.state = next;
    return result;
  }
  private scopeRow(next: State) {
    const { openingSnapshot, plan } = this.fixture;
    return {
      saveId: 'save-1',
      openingScenario: 'DEFAULT_SMALL_SHOP',
      operatingMode: 'STRATEGY',
      saveServicePeriodPlan: 'TWO_PERIODS',
      demandSeed: DEMAND_SEED,
      saveSimulationRuleVersion: openingSnapshot.simulationRuleVersion,
      openingSnapshot,
      openingSnapshotHash: openingSnapshot.openingSnapshotHash,
      membershipRole: 'OWNER',
      businessDayId: 'business-day:advance',
      businessDayStatus: next.dayStatus,
      businessDayServicePeriodPlan: 'TWO_PERIODS',
      businessDaySimulationRuleVersion: openingSnapshot.simulationRuleVersion,
      consumedPreopenSnapshotId: plan.privateEnvelope.preopenSnapshotId,
      openSnapshotHash: plan.privateEnvelope.preopenSnapshotHash,
      openSnapshotMatches: true,
      preopenSnapshotId: plan.privateEnvelope.preopenSnapshotId,
      preopenRevision: 1,
      preopenCommandId: '11111111-1111-4111-8111-111111111111',
      preopenSnapshotSchemaVersion: plan.privateEnvelope.envelopeVersion,
      preopenSimulationRuleVersion: openingSnapshot.simulationRuleVersion,
      preopenPayload: plan.privateEnvelope,
      preopenSnapshotHash: plan.privateEnvelope.preopenSnapshotHash,
      marketSeed: MARKET_SEED,
    };
  }
}

function clone(state: State): State {
  return {
    version: state.version,
    receipts: new Map([...state.receipts].map(([key, value]) => [key, structuredClone(value)])),
    dayStatus: state.dayStatus,
    items: new Map([...state.items].map(([key, value]) => [key, structuredClone(value)])),
    stocks: new Map([...state.stocks].map(([key, value]) => [key, structuredClone(value)])),
    audits: structuredClone(state.audits),
    executions: structuredClone(state.executions),
    outbox: structuredClone(state.outbox),
  };
}
function command(
  id: string,
  key: string,
  expectedVersion: number,
  period: 'LUNCH' | 'DINNER',
): CommandEnvelope {
  return {
    schemaVersion: COMMAND_ENVELOPE_VERSION,
    commandId: id,
    idempotencyKey: key,
    commandType: ADVANCE_SERVICE_PERIOD,
    aggregateId: 'save-1',
    expectedVersion,
    payload: { businessDay: 1, expectedPeriodKey: period, ownerAssignment: 'KITCHEN' },
  };
}
function dispatch(database: AdvanceDatabase, envelope: CommandEnvelope) {
  return new CommandDispatcher(
    [createAdvanceServicePeriodCommandHandler()],
    new PostgresDurableCommandExecutionStore(database),
  ).dispatch({
    context,
    target: { saveId: 'save-1', commandType: ADVANCE_SERVICE_PERIOD },
    envelope,
  });
}

test('durably advances LUNCH then final DINNER with chained evidence and safe public outbox', async () => {
  const db = new AdvanceDatabase();
  const lunch = await dispatch(db, command(LUNCH_ID, 'advance-lunch', 3, 'LUNCH'));
  const afterLunch = db.snapshot;
  assert.equal(afterLunch.version, 4);
  assert.equal(afterLunch.dayStatus, 'OPEN');
  assert.equal(afterLunch.executions.length, 1);
  assert.ok(afterLunch.stocks.size > 0);
  assert.ok(afterLunch.audits.length > 0);
  const dinner = await dispatch(db, command(DINNER_ID, 'advance-dinner', 4, 'DINNER'));
  const done = db.snapshot;
  assert.equal(dinner.status, 200);
  assert.equal(done.version, 5);
  assert.equal(done.dayStatus, 'SERVICE_COMPLETE');
  assert.equal(done.executions.length, 2);
  assert.equal(done.executions[1]!.input.previousResultHash, done.executions[0]!.resultHash);
  assert.deepEqual(
    done.executions.map((entry) => entry.periodKey),
    ['LUNCH', 'DINNER'],
  );
  assert.deepEqual(
    done.audits.map((entry) => entry.commandSequence),
    done.audits.map((_, index) =>
      index < afterLunch.audits.length ? index : index - afterLunch.audits.length,
    ),
  );
  assert.equal(done.outbox.length, 2);
  assert.equal(done.outbox[1]!.eventType, SERVICE_PERIOD_COMPLETED_EVENT_TYPE);
  const publicBytes = JSON.stringify([lunch.body.result, dinner.body.result, done.outbox]);
  for (const hidden of [
    DEMAND_SEED,
    MARKET_SEED,
    'arrivals',
    'hiddenPatienceTicks',
    'inventoryState',
    'inventoryOutcomes',
    'cogs',
    'events',
  ]) {
    assert.equal(publicBytes.includes(hidden), false, `${hidden} leaked`);
  }
});

test('idempotency replays exactly and stale/invalid period fail before authority writes', async () => {
  const db = new AdvanceDatabase();
  const first = await dispatch(db, command(LUNCH_ID, 'advance-lunch', 3, 'LUNCH'));
  const replay = await dispatch(
    db,
    command('55555555-5555-4555-8555-555555555555', 'advance-lunch', 3, 'LUNCH'),
  );
  assert.deepEqual(replay, first);
  assert.equal(db.snapshot.executions.length, 1);
  assert.equal(db.snapshot.outbox.length, 1);
  const reads = db.calls.filter((query) => query.includes('advance-service-period:scope')).length;
  await assert.rejects(
    dispatch(db, command('66666666-6666-4666-8666-666666666666', 'stale', 3, 'DINNER')),
    (error) => error instanceof CommandError && error.code === 'EXPECTED_VERSION_CONFLICT',
  );
  const invalid = {
    ...command('77777777-7777-4777-8777-777777777777', 'invalid', 4, 'DINNER'),
    payload: { businessDay: 1, expectedPeriodKey: 'BREAKFAST', ownerAssignment: 'NONE' },
  };
  await assert.rejects(
    dispatch(db, invalid),
    (error) =>
      error instanceof CommandError && error.code === 'ADVANCE_SERVICE_PERIOD_INTENT_INVALID',
  );
  assert.equal(
    db.calls.filter((query) => query.includes('advance-service-period:scope')).length,
    reads,
  );
});

test('injected persistence failure rolls back receipt, inventory, audits, execution, day, outbox, and version', async () => {
  const db = new AdvanceDatabase();
  const before = db.snapshot;
  db.failAt = 'advance-service-period:insert-execution';
  await assert.rejects(dispatch(db, command(LUNCH_ID, 'advance-lunch', 3, 'LUNCH')), /injected/);
  assert.deepEqual(db.snapshot, before);
});
