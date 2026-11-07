import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateOpeningSnapshotHash,
  createOpeningSnapshot,
  type OpeningSnapshot,
} from '../domains/opening-scenario/snapshot.js';
import { MVP_OPENING_VERSIONS } from '../domains/opening-scenario/registry.js';
import {
  executeInitializeCompetitiveSaveTransaction,
  InitializeCompetitiveSaveError,
  InitializeCompetitiveSaveService,
  type BootstrapEpochRecord,
  type InitializeCompetitiveSaveRepository,
  type InitializeCompetitiveSaveResult,
  type InitializeCompetitiveSaveTransactionInput,
  type InitializeCompetitiveSaveUnitOfWork,
  type InventoryPool,
  type QualifyingBootstrapAuthority,
  type ServerDerivedBootstrapPlan,
  type TrustedBootstrapContext,
} from './initialize-competitive-save.js';

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_COMMAND_ID = '22222222-2222-4222-8222-222222222222';

const context: TrustedBootstrapContext = Object.freeze({
  actorPlayerId: 'player-1',
  authorityId: 'authority-1',
  commandId: COMMAND_ID,
  requestFingerprint: DIGEST,
  playerCommandVersion: 1,
});

function plan(suffix = '1'): ServerDerivedBootstrapPlan {
  const openingSnapshot = createOpeningSnapshot(
    { scenario: 'DEFAULT_SMALL_SHOP', operatingMode: 'STRATEGY', currency: 'TWD' },
    MVP_OPENING_VERSIONS,
  );
  return Object.freeze({
    provisionedRestaurantId: `provisioned-${suffix}`,
    restaurantName: `Isolated ${suffix}`,
    restaurantTimezone: 'UTC',
    ownerMembershipId: `owner-membership-${suffix}`,
    saveId: `save-${suffix}`,
    ownerAuditLogId: `owner-audit-${suffix}`,
    mode: 'COMPETITIVE',
    openingScenario: 'DEFAULT_SMALL_SHOP',
    operatingMode: 'STRATEGY',
    servicePeriodPlan: 'TWO_PERIOD',
    difficultyGroup: 'server-owned-difficulty',
    demandSeed: `server-seed-${suffix}`,
    simulationRuleVersion: openingSnapshot.simulationRuleVersion,
    openingSnapshot,
    openingSnapshotHash: openingSnapshot.openingSnapshotHash,
    marketSeedAuthority: Object.freeze({
      seed: `market-seed-${suffix}`,
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
  pool: InventoryPool;
  revision: number;
  capacityPoints: number;
  storageBundleVersion: string;
  storageBundleKind: string;
  updatedByCommandId: string;
}>;

type FakeState = {
  authority: QualifyingBootstrapAuthority;
  eligible: boolean;
  epochs: BootstrapEpochRecord[];
  restaurants: string[];
  memberships: string[];
  saves: string[];
  marketSeedAuthorities: MarketSeedAuthorityRecord[];
  inventoryPoolStates: InventoryPoolStateRecord[];
  audits: string[];
  writeOrder: string[];
};

class FakeRepository implements InitializeCompetitiveSaveRepository {
  private current: FakeState;
  failAt:
    | 'restaurant'
    | 'membership'
    | 'save'
    | 'market-seed'
    | 'durable-pool'
    | 'perishable-pool'
    | 'audit'
    | 'epoch'
    | undefined;

  constructor(
    state: Partial<FakeState> = {},
  ) {
    this.current = {
      authority: state.authority ?? {
        id: 'authority-1',
        playerId: 'player-1',
        sourceEligibilityRestaurantId: 'eligibility-source',
      },
      eligible: state.eligible ?? true,
      epochs: [...(state.epochs ?? [])],
      restaurants: [...(state.restaurants ?? [])],
      memberships: [...(state.memberships ?? [])],
      saves: [...(state.saves ?? [])],
      marketSeedAuthorities: [...(state.marketSeedAuthorities ?? [])],
      inventoryPoolStates: [...(state.inventoryPoolStates ?? [])],
      audits: [...(state.audits ?? [])],
      writeOrder: [...(state.writeOrder ?? [])],
    };
  }

  snapshot(): Readonly<FakeState> {
    return copyState(this.current);
  }

  async provision(
    input: InitializeCompetitiveSaveTransactionInput,
  ): Promise<InitializeCompetitiveSaveResult> {
    const working = copyState(this.current);
    const result = await executeInitializeCompetitiveSaveTransaction(
      new FakeUnitOfWork(working, this.failAt),
      input,
    );
    this.current = working;
    return result;
  }
}

class FakeUnitOfWork implements InitializeCompetitiveSaveUnitOfWork {
  constructor(
    private readonly state: FakeState,
    private readonly failAt: FakeRepository['failAt'],
  ) {}

  async findCommandReplay(input: TrustedBootstrapContext) {
    return this.state.epochs.find(
      (epoch) =>
        epoch.commandId === input.commandId &&
        epoch.authorityId === input.authorityId &&
        epoch.playerId === input.actorPlayerId,
    );
  }

  async lockQualifyingAuthority(actorPlayerId: string, authorityId: string) {
    const authority = this.state.authority;
    return this.state.eligible && authority.id === authorityId && authority.playerId === actorPlayerId
      ? authority
      : undefined;
  }

  async lockLatestEpoch(authorityId: string) {
    return [...this.state.epochs]
      .filter((epoch) => epoch.authorityId === authorityId)
      .sort((left, right) => right.epochNumber - left.epochNumber)[0];
  }

  async createRestaurant(input: Readonly<{ id: string }>) {
    this.state.restaurants.push(input.id);
    this.state.writeOrder.push('restaurant');
    this.fail('restaurant');
  }

  async createOwnerMembership(input: Readonly<{ id: string }>) {
    this.state.memberships.push(input.id);
    this.state.writeOrder.push('membership');
    this.fail('membership');
  }

  async createCompetitiveSave(input: Readonly<{ id: string }>) {
    this.state.saves.push(input.id);
    this.state.writeOrder.push('save');
    this.fail('save');
  }

  async createMarketSeedAuthority(input: MarketSeedAuthorityRecord) {
    this.state.marketSeedAuthorities.push(input);
    this.state.writeOrder.push('market-seed');
    this.fail('market-seed');
  }

  async createInventoryPoolState(input: InventoryPoolStateRecord) {
    this.state.inventoryPoolStates.push(input);
    const step = input.pool === 'DURABLE' ? 'durable-pool' : 'perishable-pool';
    this.state.writeOrder.push(step);
    this.fail(step);
  }

  async createOwnerAudit(input: Readonly<{ id: string }>) {
    this.state.audits.push(input.id);
    this.state.writeOrder.push('audit');
    this.fail('audit');
  }

  async createEpoch(input: BootstrapEpochRecord) {
    this.state.epochs.push(input);
    this.state.writeOrder.push('epoch');
    this.fail('epoch');
  }

  private fail(step: NonNullable<FakeRepository['failAt']>) {
    if (this.failAt === step) throw new Error(`fake failure at ${step}`);
  }
}

function copyState(state: FakeState): FakeState {
  return {
    authority: { ...state.authority },
    eligible: state.eligible,
    epochs: state.epochs.map((epoch) => ({ ...epoch })),
    restaurants: [...state.restaurants],
    memberships: [...state.memberships],
    saves: [...state.saves],
    marketSeedAuthorities: state.marketSeedAuthorities.map((authority) => ({ ...authority })),
    inventoryPoolStates: state.inventoryPoolStates.map((pool) => ({ ...pool })),
    audits: [...state.audits],
    writeOrder: [...state.writeOrder],
  };
}

function epoch(
  status: BootstrapEpochRecord['status'],
  epochNumber = 1,
): BootstrapEpochRecord {
  return Object.freeze({
    id: `epoch-${epochNumber}`,
    authorityId: 'authority-1',
    playerId: 'player-1',
    epochNumber,
    playerCommandVersion: epochNumber,
    predecessorEpochId: epochNumber === 1 ? null : `epoch-${epochNumber - 1}`,
    status,
    provisionedRestaurantId: `old-restaurant-${epochNumber}`,
    ownerMembershipId: `old-membership-${epochNumber}`,
    saveId: `old-save-${epochNumber}`,
    ownerAuditLogId: `old-audit-${epochNumber}`,
    commandId: `old-command-${epochNumber}`,
    requestFingerprint: DIGEST,
  });
}

function request(
  overrides: Partial<InitializeCompetitiveSaveTransactionInput> = {},
): InitializeCompetitiveSaveTransactionInput {
  return {
    context,
    epochId: 'new-epoch-1',
    plan: plan(),
    ...overrides,
  };
}

function isError(status: number, code: string) {
  return (error: unknown): boolean =>
    error instanceof InitializeCompetitiveSaveError &&
    error.status === status &&
    error.code === code;
}

test('first provisioning commits one isolated restaurant OWNER save audit and epoch', async () => {
  const repository = new FakeRepository();
  const result = await repository.provision(request());
  assert.deepEqual(result, {
    authorityId: 'authority-1',
    epochId: 'new-epoch-1',
    epochNumber: 1,
    provisionedRestaurantId: 'provisioned-1',
    ownerMembershipId: 'owner-membership-1',
    saveId: 'save-1',
    ownerAuditLogId: 'owner-audit-1',
    replayed: false,
  });
  const state = repository.snapshot();
  assert.deepEqual(state.restaurants, ['provisioned-1']);
  assert.deepEqual(state.memberships, ['owner-membership-1']);
  assert.deepEqual(state.saves, ['save-1']);
  assert.deepEqual(state.marketSeedAuthorities, [
    {
      restaurantId: 'provisioned-1',
      saveId: 'save-1',
      seed: 'market-seed-1',
      seedVersion: 'market-seed/v1',
      createdByCommandId: COMMAND_ID,
    },
  ]);
  assert.deepEqual(state.inventoryPoolStates, [
    {
      restaurantId: 'provisioned-1',
      saveId: 'save-1',
      pool: 'DURABLE',
      revision: 1,
      capacityPoints: 120,
      storageBundleVersion: 'mvp-storage/v1',
      storageBundleKind: 'SMALL_SHOP_BASELINE',
      updatedByCommandId: COMMAND_ID,
    },
    {
      restaurantId: 'provisioned-1',
      saveId: 'save-1',
      pool: 'PERISHABLE',
      revision: 1,
      capacityPoints: 80,
      storageBundleVersion: 'mvp-storage/v1',
      storageBundleKind: 'SMALL_SHOP_BASELINE',
      updatedByCommandId: COMMAND_ID,
    },
  ]);
  assert.deepEqual(state.audits, ['owner-audit-1']);
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
  assert.equal(state.epochs.length, 1);
});

test('source restaurant reuse and authority mismatches share a non-leaking forbidden outcome', async () => {
  const sourceReuse = new FakeRepository();
  await assert.rejects(
    sourceReuse.provision(request({ plan: { ...plan(), provisionedRestaurantId: 'eligibility-source' } })),
    isError(403, 'INITIALIZE_COMPETITIVE_SAVE_FORBIDDEN'),
  );
  const wrongActor = new FakeRepository();
  await assert.rejects(
    wrongActor.provision(request({ context: { ...context, actorPlayerId: 'other-player' } })),
    isError(403, 'INITIALIZE_COMPETITIVE_SAVE_FORBIDDEN'),
  );
  const missingAuthority = new FakeRepository();
  await assert.rejects(
    missingAuthority.provision(request({ context: { ...context, authorityId: 'missing' } })),
    isError(403, 'INITIALIZE_COMPETITIVE_SAVE_FORBIDDEN'),
  );
  assert.deepEqual(sourceReuse.snapshot().restaurants, []);
  assert.deepEqual(wrongActor.snapshot().restaurants, []);
  assert.deepEqual(missingAuthority.snapshot().restaurants, []);
});

test('active and merely retired epochs reject with one stable conflict', async () => {
  for (const status of ['ACTIVE', 'RETIRED'] as const) {
    const repository = new FakeRepository({ epochs: [epoch(status)] });
    await assert.rejects(
      repository.provision(request()),
      isError(409, 'INITIALIZE_COMPETITIVE_SAVE_CONFLICT'),
    );
    assert.deepEqual(repository.snapshot().restaurants, []);
  }
});

test('CLEARED re-entry preserves authority and creates the next linked epoch', async () => {
  const repository = new FakeRepository({ epochs: [epoch('CLEARED')] });
  const result = await repository.provision(
    request({
      epochId: 'epoch-2',
      context: { ...context, commandId: OTHER_COMMAND_ID, playerCommandVersion: 2 },
      plan: plan('2'),
    }),
  );
  assert.equal(result.authorityId, 'authority-1');
  assert.equal(result.epochNumber, 2);
  const created = repository.snapshot().epochs[1];
  assert.equal(created?.authorityId, 'authority-1');
  assert.equal(created?.predecessorEpochId, 'epoch-1');
  assert.equal(created?.playerCommandVersion, 2);
  assert.equal(created?.status, 'ACTIVE');
});

test('same scoped command and fingerprint replays without new mutations', async () => {
  const repository = new FakeRepository();
  const first = await repository.provision(request());
  const second = await repository.provision(request());
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(repository.snapshot().restaurants.length, 1);
  assert.equal(repository.snapshot().epochs.length, 1);
});

test('transaction failure after E03 authority staging commits no record', async () => {
  const repository = new FakeRepository();
  repository.failAt = 'perishable-pool';
  await assert.rejects(repository.provision(request()), /fake failure at perishable-pool/);
  assert.deepEqual(repository.snapshot().restaurants, []);
  assert.deepEqual(repository.snapshot().memberships, []);
  assert.deepEqual(repository.snapshot().saves, []);
  assert.deepEqual(repository.snapshot().marketSeedAuthorities, []);
  assert.deepEqual(repository.snapshot().inventoryPoolStates, []);
  assert.deepEqual(repository.snapshot().audits, []);
  assert.deepEqual(repository.snapshot().epochs, []);
});

test('malformed market and inventory-pool authority rejects before every effect', async () => {
  const validPlan = plan();
  const postgresNul = String.fromCharCode(0);
  const invalidPlans: readonly ServerDerivedBootstrapPlan[] = [
    { ...validPlan, marketSeedAuthority: undefined as unknown as ServerDerivedBootstrapPlan['marketSeedAuthority'] },
    { ...validPlan, marketSeedAuthority: { ...validPlan.marketSeedAuthority, seed: '' } },
    { ...validPlan, marketSeedAuthority: { ...validPlan.marketSeedAuthority, seed: 'x'.repeat(301) } },
    { ...validPlan, marketSeedAuthority: { ...validPlan.marketSeedAuthority, seedVersion: postgresNul } },
    { ...validPlan, inventoryPoolAuthority: { ...validPlan.inventoryPoolAuthority, revision: 0 } },
    { ...validPlan, inventoryPoolAuthority: { ...validPlan.inventoryPoolAuthority, revision: 2_147_483_648 } },
    { ...validPlan, inventoryPoolAuthority: { ...validPlan.inventoryPoolAuthority, storageBundleVersion: '' } },
    { ...validPlan, inventoryPoolAuthority: { ...validPlan.inventoryPoolAuthority, storageBundleKind: 'x'.repeat(129) } },
    {
      ...validPlan,
      inventoryPoolAuthority: {
        ...validPlan.inventoryPoolAuthority,
        capacityPoints: { ...validPlan.inventoryPoolAuthority.capacityPoints, DURABLE: -1 },
      },
    },
    {
      ...validPlan,
      inventoryPoolAuthority: {
        ...validPlan.inventoryPoolAuthority,
        capacityPoints: { ...validPlan.inventoryPoolAuthority.capacityPoints, PERISHABLE: 1.5 },
      },
    },
    {
      ...validPlan,
      inventoryPoolAuthority: {
        ...validPlan.inventoryPoolAuthority,
        capacityPoints: {
          ...validPlan.inventoryPoolAuthority.capacityPoints,
          DURABLE: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    },
  ];

  for (const invalidPlan of invalidPlans) {
    const repository = new FakeRepository();
    await assert.rejects(
      repository.provision(request({ plan: invalidPlan })),
      isError(422, 'INITIALIZE_COMPETITIVE_SAVE_INVALID'),
    );
    const state = repository.snapshot();
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

test('malformed direct transaction command IDs reject before every unit-of-work effect', async () => {
  for (const commandId of [
    'not-a-uuid',
    '11111111-1111-0111-8111-111111111111',
    '11111111-1111-4111-7111-111111111111',
  ]) {
    const repository = new FakeRepository();
    await assert.rejects(
      repository.provision(request({ context: { ...context, commandId } })),
      isError(422, 'INITIALIZE_COMPETITIVE_SAVE_INVALID'),
    );
    const state = repository.snapshot();
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

test('unsupported, tampered, or plan-hash-mismatched opening snapshots reject before persistence', async () => {
  const validPlan = plan();
  const tampered = Object.freeze({
    ...validPlan.openingSnapshot,
    scenario: 'EMPTY_PREMISES',
  }) as OpeningSnapshot;
  const unsupportedPayload = Object.freeze({
    ...validPlan.openingSnapshot,
    snapshotSchemaVersion: 'opening-snapshot/unsupported',
  });
  const unsupported = Object.freeze({
    ...unsupportedPayload,
    openingSnapshotHash: calculateOpeningSnapshotHash(unsupportedPayload),
  }) as OpeningSnapshot;
  const invalidPlans: readonly ServerDerivedBootstrapPlan[] = [
    { ...validPlan, openingSnapshot: null as unknown as OpeningSnapshot },
    { ...validPlan, openingSnapshot: tampered, openingSnapshotHash: tampered.openingSnapshotHash },
    { ...validPlan, openingSnapshot: unsupported, openingSnapshotHash: unsupported.openingSnapshotHash },
    { ...validPlan, openingSnapshotHash: OTHER_DIGEST },
    { ...validPlan, openingScenario: 'EMPTY_PREMISES' },
    { ...validPlan, operatingMode: 'LIGHTWEIGHT_REALTIME' },
    { ...validPlan, simulationRuleVersion: 'mvp-e01-v2' },
  ];

  for (const invalidPlan of invalidPlans) {
    const repository = new FakeRepository();
    await assert.rejects(
      repository.provision(request({ plan: invalidPlan })),
      isError(422, 'INITIALIZE_COMPETITIVE_SAVE_INVALID'),
    );
    const state = repository.snapshot();
    assert.deepEqual(state.restaurants, []);
    assert.deepEqual(state.memberships, []);
    assert.deepEqual(state.saves, []);
    assert.deepEqual(state.audits, []);
    assert.deepEqual(state.epochs, []);
  }
});

test('client intent rejects every authority-bearing or server-owned field before plan creation', async () => {
  const repository = new FakeRepository();
  let planCalls = 0;
  const service = new InitializeCompetitiveSaveService(repository, () => {
    planCalls += 1;
    return { epochId: 'epoch-from-server', plan: plan() };
  });
  for (const forbiddenField of [
    'actorPlayerId',
    'authorityId',
    'tenantId',
    'restaurantId',
    'role',
    'saveId',
    'demandSeed',
    'marketSeedAuthority',
    'inventoryPoolAuthority',
    'simulationRuleVersion',
    'money',
    'risk',
  ]) {
    await assert.rejects(
      async () =>
        service.initialize(context, {
          scenario: 'DEFAULT_SMALL_SHOP',
          operatingMode: 'STRATEGY',
          settlementCurrency: 'TWD',
          servicePeriodPlan: 'TWO_PERIOD',
          [forbiddenField]: 'attacker-value',
        }),
      isError(422, 'INITIALIZE_COMPETITIVE_SAVE_INVALID'),
    );
  }
  assert.equal(planCalls, 0);
});
