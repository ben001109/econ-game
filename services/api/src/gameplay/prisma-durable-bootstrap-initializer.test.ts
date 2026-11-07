import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandError } from '../commands/command-contract.js';
import { createOpeningSnapshot } from '../domains/opening-scenario/snapshot.js';
import { MVP_OPENING_VERSIONS } from '../domains/opening-scenario/registry.js';
import type {
  BootstrapEpochRecord,
  ServerBootstrapPlanFactory,
  ServerDerivedBootstrapPlan,
} from './initialize-competitive-save.js';
import type {
  BootstrapSerializableDatabase,
  BootstrapSqlTransaction,
} from './prisma-initialize-competitive-save-repository.js';
import { PrismaDurableBootstrapInitializer } from './prisma-durable-bootstrap-initializer.js';
import { assertMvpBootstrapIntent } from './mvp-bootstrap-plan.js';

const FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);
const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_COMMAND_ID = '22222222-2222-4222-8222-222222222222';

type AuthorityRow = Readonly<{
  id: string;
  playerId: string;
  cohortId: string;
  cohortMembershipId: string;
  inviteId: string;
  consentDecisionId: string;
  sourceEligibilityRestaurantId: string;
  policyVersion: string;
  policyDigest: string;
}>;

type Receipt = {
  id: string;
  actorScope: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: string;
  responseSnapshot?: unknown;
};

type MarketSeedAuthorityRecord = Readonly<{
  restaurantId: string;
  saveId: string;
  seed: string;
  seedVersion: string;
  createdByCommandId: string;
}>;

type InventoryPoolStateRecord = Readonly<{
  restaurantId: string;
  saveId: string;
  pool: 'DURABLE' | 'PERISHABLE';
  revision: number;
  capacityPoints: number;
  storageBundleVersion: string;
  storageBundleKind: string;
  updatedByCommandId: string;
}>;

type FakeState = {
  playerExists: boolean;
  playerVersion?: number;
  d05CandidateCount: number;
  d05Active: boolean;
  authority?: AuthorityRow;
  receipts: Receipt[];
  epochs: BootstrapEpochRecord[];
  restaurants: string[];
  memberships: string[];
  saves: string[];
  marketSeedAuthorities: MarketSeedAuthorityRecord[];
  inventoryPoolStates: InventoryPoolStateRecord[];
  audits: string[];
  writeOrder: string[];
  failAt?: 'save' | 'audit';
};

const d05Candidate = Object.freeze({
  playerId: 'player-1',
  cohortId: 'cohort-1',
  cohortMembershipId: 'cohort-membership-1',
  inviteId: 'invite-1',
  consentDecisionId: 'consent-1',
  sourceEligibilityRestaurantId: 'eligibility-restaurant',
  policyVersion: 'policy-v1',
  policyDigest: 'c'.repeat(64),
});

class FakeSerializableDatabase implements BootstrapSerializableDatabase {
  private state: FakeState;
  private queue: Promise<void> = Promise.resolve();
  readonly isolationLevels: string[] = [];

  constructor(overrides: Partial<FakeState> = {}) {
    this.state = {
      playerExists: true,
      d05CandidateCount: 1,
      d05Active: true,
      receipts: [],
      epochs: [],
      restaurants: [],
      memberships: [],
      saves: [],
      marketSeedAuthorities: [],
      inventoryPoolStates: [],
      audits: [],
      writeOrder: [],
      ...overrides,
    };
  }

  async $transaction<T>(
    operation: (transaction: BootstrapSqlTransaction) => Promise<T>,
    options: Readonly<{ isolationLevel: 'Serializable' }>,
  ): Promise<T> {
    let release: () => void = () => undefined;
    const predecessor = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    this.isolationLevels.push(options.isolationLevel);
    const working = structuredClone(this.state);
    try {
      const result = await operation(new FakeSqlTransaction(working));
      this.state = working;
      return result;
    } finally {
      release();
    }
  }

  snapshot(): FakeState {
    return structuredClone(this.state);
  }

  clearActiveEpoch(): void {
    const active = this.state.epochs.find((epoch) => epoch.status === 'ACTIVE');
    if (!active) throw new Error('no active epoch');
    this.state.epochs = this.state.epochs.map((epoch) =>
      epoch.id === active.id ? { ...epoch, status: 'CLEARED' } : epoch,
    );
  }
}

class FakeSqlTransaction implements BootstrapSqlTransaction {
  constructor(private readonly state: FakeState) {}

  async $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T> {
    let rows: readonly unknown[];
    if (query.includes('p0-bootstrap:state-lock')) {
      rows = this.state.playerVersion === undefined ? [] : [{ version: this.state.playerVersion }];
    } else if (query.includes('p0-bootstrap:idempotency-acquire')) {
      const [id, , actorScope, idempotencyKey, requestFingerprint] = values as readonly string[];
      const conflict = this.state.receipts.some(
        (receipt) =>
          receipt.id === id ||
          (receipt.actorScope === actorScope && receipt.idempotencyKey === idempotencyKey),
      );
      if (conflict) {
        rows = [];
      } else {
        this.state.receipts.push({
          id: id!,
          actorScope: actorScope!,
          idempotencyKey: idempotencyKey!,
          requestFingerprint: requestFingerprint!,
          status: 'PROCESSING',
        });
        rows = [{ id }];
      }
    } else if (query.includes('p0-bootstrap:idempotency-lock')) {
      const [actorScope, idempotencyKey] = values as readonly string[];
      rows = this.state.receipts.filter(
        (receipt) =>
          receipt.actorScope === actorScope && receipt.idempotencyKey === idempotencyKey,
      );
    } else if (query.includes('p0-bootstrap:authority-active')) {
      rows = this.state.authority && this.state.d05Active ? [this.state.authority] : [];
    } else if (query.includes('p0-bootstrap:authority-any')) {
      rows = this.state.authority ? [{ id: this.state.authority.id }] : [];
    } else if (query.includes('p0-bootstrap:d05-candidates')) {
      rows = Array.from({ length: this.state.d05CandidateCount }, () => d05Candidate);
    } else if (query.includes('p0-bootstrap:authority-create')) {
      const [
        id,
        playerId,
        cohortId,
        cohortMembershipId,
        inviteId,
        consentDecisionId,
        sourceEligibilityRestaurantId,
        policyVersion,
        policyDigest,
      ] = values as readonly string[];
      this.state.authority = {
        id: id!,
        playerId: playerId!,
        cohortId: cohortId!,
        cohortMembershipId: cohortMembershipId!,
        inviteId: inviteId!,
        consentDecisionId: consentDecisionId!,
        sourceEligibilityRestaurantId: sourceEligibilityRestaurantId!,
        policyVersion: policyVersion!,
        policyDigest: policyDigest!,
      };
      rows = [this.state.authority];
    } else if (query.includes('p0-bootstrap:state-advance')) {
      const [playerId, nextVersion, currentVersion] = values as readonly [string, number, number];
      const matchingEpoch = this.state.epochs.some(
        (epoch) => epoch.playerId === playerId && epoch.playerCommandVersion === nextVersion,
      );
      if (this.state.playerVersion === currentVersion && matchingEpoch) {
        this.state.playerVersion = nextVersion;
        rows = [{ version: nextVersion }];
      } else {
        rows = [];
      }
    } else if (query.includes('WHERE epoch."commandId" = $1')) {
      const [commandId, authorityId, playerId] = values as readonly string[];
      rows = this.state.epochs.filter(
        (epoch) =>
          epoch.commandId === commandId &&
          epoch.authorityId === authorityId &&
          epoch.playerId === playerId,
      );
    } else if (query.includes('WHERE authority."id" = $1')) {
      const [authorityId, playerId] = values as readonly string[];
      rows =
        this.state.authority?.id === authorityId &&
        this.state.authority.playerId === playerId &&
        this.state.d05Active
          ? [this.state.authority]
          : [];
    } else if (query.includes('ORDER BY epoch."epochNumber" DESC')) {
      const [authorityId] = values as readonly string[];
      rows = this.state.epochs
        .filter((epoch) => epoch.authorityId === authorityId)
        .sort((left, right) => right.epochNumber - left.epochNumber)
        .slice(0, 1);
    } else {
      throw new Error(`unhandled fake query: ${query}`);
    }
    return rows as T;
  }

  async $executeRawUnsafe(query: string, ...values: readonly unknown[]): Promise<number> {
    if (query.includes('p0-bootstrap:state-create')) {
      if (this.state.playerExists && this.state.playerVersion === undefined) {
        this.state.playerVersion = 0;
      }
      return 1;
    }
    if (query.includes('p0-bootstrap:idempotency-complete')) {
      const [id, snapshot] = values as readonly [string, string];
      const receipt = this.state.receipts.find((candidate) => candidate.id === id);
      if (!receipt || receipt.status !== 'PROCESSING') return 0;
      receipt.status = 'COMPLETED';
      receipt.responseSnapshot = JSON.parse(snapshot);
      return 1;
    }
    if (query.includes('INSERT INTO "Restaurant"')) {
      this.state.restaurants.push(String(values[0]));
      this.state.writeOrder.push('restaurant');
      return 1;
    }
    if (query.includes('INSERT INTO "RestaurantMembership"')) {
      this.state.memberships.push(String(values[0]));
      this.state.writeOrder.push('membership');
      return 1;
    }
    if (query.includes('INSERT INTO "CompetitiveSave"')) {
      this.state.saves.push(String(values[0]));
      this.state.writeOrder.push('save');
      if (this.state.failAt === 'save') throw new Error('injected save failure');
      return 1;
    }
    if (query.includes('INSERT INTO "MarketSeedAuthority"')) {
      const [restaurantId, saveId, seed, seedVersion, createdByCommandId] =
        values as readonly string[];
      this.state.marketSeedAuthorities.push({
        restaurantId: restaurantId!,
        saveId: saveId!,
        seed: seed!,
        seedVersion: seedVersion!,
        createdByCommandId: createdByCommandId!,
      });
      this.state.writeOrder.push('market-seed');
      return 1;
    }
    if (query.includes('INSERT INTO "InventoryPoolState"')) {
      const [
        restaurantId,
        saveId,
        pool,
        revision,
        capacityPoints,
        storageBundleVersion,
        storageBundleKind,
        updatedByCommandId,
      ] = values as readonly [string, string, 'DURABLE' | 'PERISHABLE', number, number, ...string[]];
      this.state.inventoryPoolStates.push({
        restaurantId,
        saveId,
        pool,
        revision,
        capacityPoints,
        storageBundleVersion: storageBundleVersion!,
        storageBundleKind: storageBundleKind!,
        updatedByCommandId: updatedByCommandId!,
      });
      this.state.writeOrder.push(pool === 'DURABLE' ? 'durable-pool' : 'perishable-pool');
      return 1;
    }
    if (query.includes('INSERT INTO "AuditLog"')) {
      this.state.audits.push(String(values[0]));
      this.state.writeOrder.push('audit');
      if (this.state.failAt === 'audit') throw new Error('injected audit failure');
      return 1;
    }
    if (query.includes('INSERT INTO "BootstrapProvisioningEpoch"')) {
      const [
        id,
        authorityId,
        playerId,
        epochNumber,
        playerCommandVersion,
        predecessorEpochId,
        provisionedRestaurantId,
        ownerMembershipId,
        saveId,
        ownerAuditLogId,
        commandId,
        requestFingerprint,
      ] = values as readonly [string, string, string, number, number, string | null, ...string[]];
      this.state.epochs.push({
        id,
        authorityId,
        playerId,
        epochNumber,
        playerCommandVersion,
        predecessorEpochId,
        status: 'ACTIVE',
        provisionedRestaurantId: provisionedRestaurantId!,
        ownerMembershipId: ownerMembershipId!,
        saveId: saveId!,
        ownerAuditLogId: ownerAuditLogId!,
        commandId: commandId!,
        requestFingerprint: requestFingerprint!,
      });
      this.state.writeOrder.push('epoch');
      return 1;
    }
    throw new Error(`unhandled fake execution: ${query}`);
  }
}

function plan(sequence: number): ServerDerivedBootstrapPlan {
  const openingSnapshot = createOpeningSnapshot(
    { scenario: 'DEFAULT_SMALL_SHOP', operatingMode: 'STRATEGY', currency: 'TWD' },
    MVP_OPENING_VERSIONS,
  );
  return Object.freeze({
    provisionedRestaurantId: `restaurant-${sequence}`,
    restaurantName: `server-name-${sequence}`,
    restaurantTimezone: 'UTC',
    ownerMembershipId: `owner-${sequence}`,
    saveId: `save-${sequence}`,
    ownerAuditLogId: `audit-${sequence}`,
    mode: 'COMPETITIVE',
    openingScenario: 'DEFAULT_SMALL_SHOP',
    operatingMode: 'STRATEGY',
    servicePeriodPlan: 'TWO_PERIOD',
    difficultyGroup: 'server-difficulty',
    demandSeed: `server-seed-${sequence}`,
    simulationRuleVersion: openingSnapshot.simulationRuleVersion,
    openingSnapshot,
    openingSnapshotHash: openingSnapshot.openingSnapshotHash,
    marketSeedAuthority: Object.freeze({
      seed: `independent-market-seed-${sequence}`,
      seedVersion: 'market-seed/v1',
    }),
    inventoryPoolAuthority: Object.freeze({
      revision: 1,
      storageBundleVersion: 'mvp-storage/v1',
      storageBundleKind: 'SMALL_SHOP_BASELINE',
      capacityPoints: Object.freeze({ DURABLE: 120, PERISHABLE: 80 }),
    }),
  });
}

function subject(
  database: FakeSerializableDatabase,
  assertIntentPreflight?: (intent: Parameters<ServerBootstrapPlanFactory>[1]) => void,
) {
  let planCalls = 0;
  const authorities: string[] = [];
  const factory: ServerBootstrapPlanFactory = (context) => {
    planCalls += 1;
    authorities.push(context.authorityId);
    return Object.freeze({ epochId: `epoch-${planCalls}`, plan: plan(planCalls) });
  };
  return {
    initializer: new PrismaDurableBootstrapInitializer(database, factory, assertIntentPreflight),
    planCalls: () => planCalls,
    authorities,
  };
}

function input(overrides: Partial<Parameters<PrismaDurableBootstrapInitializer['initialize']>[0]> = {}) {
  return Object.freeze({
    actorPlayerId: 'player-1',
    aggregateScope: 'bootstrap-player:player-1',
    commandId: COMMAND_ID,
    idempotencyKey: 'idem-1',
    expectedVersion: 0,
    requestFingerprint: FINGERPRINT,
    intent: Object.freeze({
      scenario: 'DEFAULT_SMALL_SHOP',
      operatingMode: 'STRATEGY',
      settlementCurrency: 'TWD',
      servicePeriodPlan: 'TWO_PERIOD',
    }),
    ...overrides,
  });
}

function commandError(status: number, code: string) {
  return (error: unknown) =>
    error instanceof CommandError && error.status === status && error.code === code;
}

test('durable initial success commits one isolated provisioning epoch and terminal receipt', async () => {
  const database = new FakeSerializableDatabase();
  const { initializer, planCalls, authorities } = subject(database);
  const result = await initializer.initialize(input());
  assert.equal(result.aggregateVersion, 1);
  assert.equal(planCalls(), 1);
  assert.match(authorities[0]!, /^[0-9a-f-]{36}$/);
  const state = database.snapshot();
  assert.equal(state.playerVersion, 1);
  assert.deepEqual(state.restaurants, ['restaurant-1']);
  assert.deepEqual(state.memberships, ['owner-1']);
  assert.deepEqual(state.saves, ['save-1']);
  assert.deepEqual(state.marketSeedAuthorities, [
    {
      restaurantId: 'restaurant-1',
      saveId: 'save-1',
      seed: 'independent-market-seed-1',
      seedVersion: 'market-seed/v1',
      createdByCommandId: COMMAND_ID,
    },
  ]);
  assert.deepEqual(state.inventoryPoolStates, [
    {
      restaurantId: 'restaurant-1',
      saveId: 'save-1',
      pool: 'DURABLE',
      revision: 1,
      capacityPoints: 120,
      storageBundleVersion: 'mvp-storage/v1',
      storageBundleKind: 'SMALL_SHOP_BASELINE',
      updatedByCommandId: COMMAND_ID,
    },
    {
      restaurantId: 'restaurant-1',
      saveId: 'save-1',
      pool: 'PERISHABLE',
      revision: 1,
      capacityPoints: 80,
      storageBundleVersion: 'mvp-storage/v1',
      storageBundleKind: 'SMALL_SHOP_BASELINE',
      updatedByCommandId: COMMAND_ID,
    },
  ]);
  assert.deepEqual(state.audits, ['audit-1']);
  assert.deepEqual(state.writeOrder, [
    'restaurant',
    'membership',
    'save',
    'market-seed',
    'durable-pool',
    'perishable-pool',
    'audit',
    'epoch',
  ]);
  assert.equal(state.epochs[0]?.playerCommandVersion, 1);
  assert.equal(state.receipts[0]?.status, 'COMPLETED');
  assert.deepEqual(database.isolationLevels, ['Serializable']);
});

test('same idempotency key and fingerprint returns the stored terminal execution', async () => {
  const database = new FakeSerializableDatabase();
  const { initializer, planCalls } = subject(database);
  const first = await initializer.initialize(input());
  const replay = await initializer.initialize(input());
  assert.deepEqual(replay, first);
  assert.equal(planCalls(), 1);
  assert.equal(database.snapshot().epochs.length, 1);
});

test('same idempotency key with a different fingerprint returns stable 409', async () => {
  const database = new FakeSerializableDatabase();
  const { initializer } = subject(database);
  await initializer.initialize(input());
  await assert.rejects(
    initializer.initialize(input({ commandId: OTHER_COMMAND_ID, requestFingerprint: OTHER_FINGERPRINT })),
    commandError(409, 'IDEMPOTENCY_KEY_REUSED'),
  );
  assert.equal(database.snapshot().epochs.length, 1);
});

test('stale expected player version returns stable 409 and commits no ownership record', async () => {
  const database = new FakeSerializableDatabase({ playerVersion: 1 });
  const { initializer, planCalls } = subject(database);
  await assert.rejects(
    initializer.initialize(input()),
    commandError(409, 'EXPECTED_VERSION_CONFLICT'),
  );
  assert.equal(planCalls(), 0);
  assert.deepEqual(database.snapshot().receipts, []);
});

test('missing active D05 authority returns the generic forbidden result', async () => {
  const database = new FakeSerializableDatabase({ d05CandidateCount: 0 });
  const { initializer, planCalls } = subject(database);
  await assert.rejects(
    initializer.initialize(input()),
    commandError(403, 'INITIALIZE_COMPETITIVE_SAVE_FORBIDDEN'),
  );
  assert.equal(planCalls(), 0);
  const state = database.snapshot();
  assert.equal(state.playerVersion, undefined);
  assert.deepEqual(state.receipts, []);
});

test('aggregate scope mismatch is rejected before transaction ownership or authority lookup', async () => {
  const database = new FakeSerializableDatabase();
  const { initializer, planCalls } = subject(database);
  await assert.rejects(
    initializer.initialize(input({ aggregateScope: 'bootstrap-player:other-player' })),
    commandError(403, 'INITIALIZE_COMPETITIVE_SAVE_FORBIDDEN'),
  );
  assert.equal(planCalls(), 0);
  assert.deepEqual(database.isolationLevels, []);
  const state = database.snapshot();
  assert.equal(state.authority, undefined);
  assert.equal(state.playerVersion, undefined);
  assert.deepEqual(state.receipts, []);
  assert.deepEqual(state.restaurants, []);
  assert.deepEqual(state.memberships, []);
  assert.deepEqual(state.saves, []);
  assert.deepEqual(state.audits, []);
  assert.deepEqual(state.epochs, []);
});

test('closed-beta EMPTY_PREMISES is rejected before any durable command effect', async () => {
  const database = new FakeSerializableDatabase();
  const { initializer, planCalls } = subject(database, assertMvpBootstrapIntent);
  await assert.rejects(
    initializer.initialize(input({ intent: { ...input().intent, scenario: 'EMPTY_PREMISES' } })),
    commandError(422, 'INITIALIZE_COMPETITIVE_SAVE_INTENT_INVALID'),
  );
  assert.equal(planCalls(), 0);
  assert.deepEqual(database.isolationLevels, []);
  const state = database.snapshot();
  assert.equal(state.authority, undefined);
  assert.equal(state.playerVersion, undefined);
  assert.deepEqual(state.receipts, []);
  assert.deepEqual(state.restaurants, []);
  assert.deepEqual(state.memberships, []);
  assert.deepEqual(state.saves, []);
  assert.deepEqual(state.audits, []);
  assert.deepEqual(state.epochs, []);
  assert.deepEqual(state.writeOrder, []);
});

test('malformed direct durable command IDs reject before the serializable transaction', async () => {
  for (const commandId of [
    'not-a-uuid',
    '11111111-1111-0111-8111-111111111111',
    '11111111-1111-4111-7111-111111111111',
  ]) {
    const database = new FakeSerializableDatabase();
    const { initializer, planCalls } = subject(database);
    await assert.rejects(
      initializer.initialize(input({ commandId })),
      commandError(422, 'COMMAND_ENVELOPE_INVALID'),
    );
    assert.equal(planCalls(), 0);
    assert.deepEqual(database.isolationLevels, []);
    const state = database.snapshot();
    assert.equal(state.authority, undefined);
    assert.equal(state.playerVersion, undefined);
    assert.deepEqual(state.receipts, []);
    assert.deepEqual(state.restaurants, []);
    assert.deepEqual(state.memberships, []);
    assert.deepEqual(state.saves, []);
    assert.deepEqual(state.marketSeedAuthorities, []);
    assert.deepEqual(state.inventoryPoolStates, []);
    assert.deepEqual(state.audits, []);
    assert.deepEqual(state.epochs, []);
    assert.deepEqual(state.writeOrder, []);
  }
});

test('concurrent double send has one provisioning winner and one terminal replay', async () => {
  const database = new FakeSerializableDatabase();
  const { initializer, planCalls } = subject(database);
  const [left, right] = await Promise.all([
    initializer.initialize(input()),
    initializer.initialize(input()),
  ]);
  assert.deepEqual(left, right);
  assert.equal(planCalls(), 1);
  const state = database.snapshot();
  assert.equal(state.playerVersion, 1);
  assert.equal(state.epochs.length, 1);
  assert.equal(state.receipts.length, 1);
});

test('failure after E03 authority staging rolls back authority, receipt, version, and all effects', async () => {
  const database = new FakeSerializableDatabase({ failAt: 'audit' });
  const { initializer } = subject(database);
  await assert.rejects(
    initializer.initialize(input()),
    commandError(503, 'INITIALIZE_COMPETITIVE_SAVE_UNAVAILABLE'),
  );
  const state = database.snapshot();
  assert.equal(state.authority, undefined);
  assert.equal(state.playerVersion, undefined);
  assert.deepEqual(state.receipts, []);
  assert.deepEqual(state.restaurants, []);
  assert.deepEqual(state.memberships, []);
  assert.deepEqual(state.saves, []);
  assert.deepEqual(state.marketSeedAuthorities, []);
  assert.deepEqual(state.inventoryPoolStates, []);
  assert.deepEqual(state.audits, []);
  assert.deepEqual(state.epochs, []);
});

test('malformed server E03 authority rolls back receipt, authority derivation, and every effect', async () => {
  const database = new FakeSerializableDatabase();
  const invalidPlan = plan(1);
  const initializer = new PrismaDurableBootstrapInitializer(database, () => ({
    epochId: 'epoch-1',
    plan: {
      ...invalidPlan,
      marketSeedAuthority: { ...invalidPlan.marketSeedAuthority, seed: '   ' },
    },
  }));
  await assert.rejects(
    initializer.initialize(input()),
    commandError(422, 'INITIALIZE_COMPETITIVE_SAVE_INVALID'),
  );
  const state = database.snapshot();
  assert.equal(state.authority, undefined);
  assert.equal(state.playerVersion, undefined);
  assert.deepEqual(state.receipts, []);
  assert.deepEqual(state.restaurants, []);
  assert.deepEqual(state.memberships, []);
  assert.deepEqual(state.saves, []);
  assert.deepEqual(state.marketSeedAuthorities, []);
  assert.deepEqual(state.inventoryPoolStates, []);
  assert.deepEqual(state.audits, []);
  assert.deepEqual(state.epochs, []);
  assert.deepEqual(state.writeOrder, []);
});

test('cleared re-entry reuses immutable authority and preserves epoch and command-version lineage', async () => {
  const database = new FakeSerializableDatabase();
  const { initializer, authorities } = subject(database);
  await initializer.initialize(input());
  database.clearActiveEpoch();
  const second = await initializer.initialize(
    input({
      commandId: OTHER_COMMAND_ID,
      idempotencyKey: 'idem-2',
      expectedVersion: 1,
      requestFingerprint: OTHER_FINGERPRINT,
    }),
  );
  assert.equal(second.aggregateVersion, 2);
  assert.equal(authorities[1], authorities[0]);
  const state = database.snapshot();
  assert.equal(state.playerVersion, 2);
  assert.equal(state.epochs[1]?.epochNumber, 2);
  assert.equal(state.epochs[1]?.playerCommandVersion, 2);
  assert.equal(state.epochs[1]?.predecessorEpochId, state.epochs[0]?.id);
});
