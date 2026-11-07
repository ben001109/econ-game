import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMAND_ENVELOPE_VERSION, CommandError, type CommandEnvelope, type TrustedCommandContext } from '../commands/command-contract.js';
import { CommandDispatcher } from '../commands/command-dispatcher.js';
import { deriveFloorFlowServiceProfile } from '../domains/demand-flow/demand-flow.js';
import { MVP_FIRST_DAY_CATALOG_VERSIONS, resolveMvpFirstDayCatalog } from '../domains/inventory-procurement/mvp-first-day-catalog.js';
import type { InventoryState } from '../domains/inventory-procurement/inventory.js';
import { PostgresDurableCommandExecutionStore, type D03Database, type D03Queryable } from '../domains/ledger/postgres-ledger-store.js';
import { createOpeningSnapshot } from '../domains/opening-scenario/snapshot.js';
import { MVP_OPENING_VERSIONS } from '../domains/opening-scenario/registry.js';
import type { RecipeServiceSnapshot } from '../domains/service-quality/service-quality.js';
import { advanceServicePeriod } from './advance-service-period.js';
import { MVP_FIRST_DAY_MARKET_SEED_VERSION, provideCanonicalFirstDayPreopenArtifacts } from './preopen-day-authority-provider.js';
import { parseConfigurePreopenDayIntent } from './preopen-day-contract.js';
import { createPreopenDayPlan } from './preopen-day-plan.js';
import type { PersistedAdvanceExecution, PersistedInventoryAudit, PersistedInventoryStock } from './prisma-advance-service-period-repository.js';
import {
  BUSINESS_DAY_SETTLED_EVENT_TYPE,
  SETTLE_BUSINESS_DAY,
  createSettleBusinessDayCommandHandler,
} from './settle-business-day-command.js';

const SETTLE_ID = '88888888-8888-4888-8888-888888888888';
const DEMAND_SEED = 'server-demand-seed-settle-command';
const MARKET_SEED = 'server-market-seed-settle-command';
const context: TrustedCommandContext = Object.freeze({
  actorId: 'owner-1', tenantId: 'restaurant-1', saveId: 'save-1', roles: ['OWNER'],
  membershipId: 'membership-1', branchScope: { kind: 'all' as const }, principal: { type: 'web' as const },
});

type Plan = 'TWO_PERIODS' | 'THREE_PERIODS';
type Fixture = ReturnType<typeof createFixture>;
type Receipt = { commandId: string; fingerprint: string; snapshot: unknown };
type Stock = PersistedInventoryStock;
type Ledger = { id: string; currency: string; lines: { direction: string; amountMinor: string; accountCode: string }[] };
type State = {
  version: number;
  receipts: Map<string, Receipt>;
  dayStatus: 'SERVICE_COMPLETE' | 'SETTLED';
  settledByCommandId: string | null;
  stocks: Map<string, Stock>;
  serviceAudits: PersistedInventoryAudit[];
  wasteAudits: Record<string, unknown>[];
  replay: Record<string, unknown>[];
  dayEnd: Record<string, unknown> | null;
  risk: Record<string, unknown>[];
  reputation: Record<string, unknown>[];
  ledger: Ledger | null;
  outbox: Record<string, unknown>[];
};

function createFixture(plan: Plan) {
  const openingSnapshot = createOpeningSnapshot(
    { scenario: 'DEFAULT_SMALL_SHOP', operatingMode: 'STRATEGY', currency: 'TWD' },
    MVP_OPENING_VERSIONS,
  );
  const artifacts = provideCanonicalFirstDayPreopenArtifacts({
    command: { commandId: '11111111-1111-4111-8111-111111111111', preopenSnapshotId: `preopen:settle:${plan}`, businessDay: 1, currentLayoutRevision: 0 },
    save: { id: 'save-1', scenario: 'DEFAULT_SMALL_SHOP', operatingMode: 'STRATEGY', servicePeriodPlan: plan,
      demandSeed: DEMAND_SEED, simulationRuleVersion: openingSnapshot.simulationRuleVersion,
      settlementCurrency: 'TWD', openingSnapshot, openingSnapshotHash: openingSnapshot.openingSnapshotHash },
    marketSeedAuthority: { saveId: 'save-1', seed: MARKET_SEED, seedVersion: MVP_FIRST_DAY_MARKET_SEED_VERSION },
    inventoryPoolAuthorities: [
      { saveId: 'save-1', pool: 'DURABLE', revision: 1, capacityPoints: 305, storageBundleVersion: 'mvp-storage/v1', storageBundleKind: 'BASIC' },
      { saveId: 'save-1', pool: 'PERISHABLE', revision: 1, capacityPoints: 305, storageBundleVersion: 'mvp-storage/v1', storageBundleKind: 'BASIC' },
    ],
    spotPurchaseIdFactory: { create: ({ ingredientId }) => ({ transactionId: `spot-tx:${ingredientId}`, purchaseId: `spot-buy:${ingredientId}` }) },
  });
  const planResult = createPreopenDayPlan(parseConfigurePreopenDayIntent({
    menuChoice: { themeId: 'bistro', recipeVersionIds: ['bistro-chicken-rice-v1','bistro-greens-rice-v1','bistro-herb-chicken-v1'],
      priceModifierPercentByRecipe: { 'bistro-chicken-rice-v1': 0, 'bistro-greens-rice-v1': 0, 'bistro-herb-chicken-v1': 0 },
      enabledSubstitutionIds: ['bistro-chicken-rice-greens-v1'] },
    floorPlan: { width: 10, height: 9, servicePoint: { x: 1, y: 0 }, fixtures: [
      ...Array.from({ length: 8 }, (_, index) => ({ fixtureId: `walkway-${index + 1}`, kind: 'WALKWAY', x: 1, y: index + 1 })),
      ...Array.from({ length: 9 }, (_, index) => ({ fixtureId: `seat-${index + 1}`, kind: 'SEAT', x: 2, y: index })),
      ...Array.from({ length: 4 }, (_, index) => ({ fixtureId: `waiting-${index + 1}`, kind: 'WAITING_ZONE', x: 0, y: index + 1 })),
    ] },
    spotPurchaseDeltas: ['bistro-rice','bistro-sauce','bistro-chicken','bistro-greens','bistro-herbs']
      .map((ingredientId) => ({ ingredientId, quantityPoints: 20 })),
  }), artifacts);
  const envelope = planResult.privateEnvelope;
  const catalog = resolveMvpFirstDayCatalog(MVP_FIRST_DAY_CATALOG_VERSIONS, {
    code: 'TWD', metadataVersion: openingSnapshot.currencyMetadataVersion,
  });
  const menuIds = envelope.menu.items.map((item) => item.recipeVersionId);
  const recipeVersions = catalog.recipeCatalog.filter((recipe) => menuIds.includes(recipe.id));
  const enabledIds = new Set(envelope.menu.items.flatMap((item) => item.enabledSubstitutionIds));
  const enabledSubstitutions = catalog.substitutionCatalog.filter((entry) => enabledIds.has(entry.id));
  const recipes: readonly RecipeServiceSnapshot[] = recipeVersions.map((recipe) => {
    const item = envelope.menu.items.find((candidate) => candidate.recipeVersionId === recipe.id)!;
    return Object.freeze({ id: recipe.id, baseQuality: recipe.baseQuality, substitutionQualityDelta: 0,
      recommendedPrice: Number(item.basePrice.minorUnits), salePrice: Number(item.salePrice.minorUnits), portions: 0 });
  });
  const openingStocks = envelope.inventoryProcurement.openingStocks;
  const initialInventory: InventoryState = Object.freeze({
    currency: 'TWD', capacity: envelope.inventoryProcurement.capacity, stocks: openingStocks,
    orderReservations: envelope.inventoryProcurement.openingReservations,
    reservedUndelivered: envelope.inventoryProcurement.reservedUndelivered,
    transactions: Object.freeze(openingStocks.map((stock, index) => Object.freeze({
      sequence: index + 1, transactionId: `opening-receipt:${stock.ingredientId}`, type: 'RECEIPT' as const,
      ingredientId: stock.ingredientId, quantityPoints: stock.onHandPoints, amount: stock.costPool,
      referenceId: envelope.preopenSnapshotId,
    }))),
  });
  const periods = plan === 'TWO_PERIODS' ? (['LUNCH','DINNER'] as const) : (['LUNCH','OFF_PEAK','DINNER'] as const);
  const assignments = ['KITCHEN','NONE','FRONT'] as const;
  const executions: PersistedAdvanceExecution[] = [];
  let previous: PersistedAdvanceExecution['resultSnapshot'] | undefined;
  for (const [index, period] of periods.entries()) {
    const groups = envelope.demandSchedule.groups.filter((group) => group.period === period);
    const profile = deriveFloorFlowServiceProfile(envelope.layout, {
      seatedGuests: 0, waitingGroups: 0,
      activeGuests: groups.reduce((total, group) => total + group.size, 0),
      demandGroups: Math.max(1, groups.length),
    });
    const result = advanceServicePeriod(
      { businessDay: 1, expectedPeriodKey: period, ownerAssignment: assignments[index]! },
      { businessDay: 1, servicePeriodPlan: plan, initiator: { actorId: 'owner-1', role: 'OWNER' },
        npcContracts: openingSnapshot.npcContracts, demandSchedule: envelope.demandSchedule, recipes,
        inventoryState: previous?.inventoryState ?? initialInventory, recipeVersions, enabledSubstitutions,
        equipment: { kitchen: 'BASIC', front: 'BASIC' }, kitchenExecutionQualityModifier: 0,
        floorFlowServiceProfile: profile, openingReputation: previous ? undefined : openingSnapshot.reputation,
        previousResult: previous },
    );
    executions.push(Object.freeze({ id: `execution:${index + 1}`, ordinal: index + 1, periodKey: period,
      commandId: `advance-command:${index + 1}`, simulationRuleVersion: openingSnapshot.simulationRuleVersion,
      inputSnapshot: result.inputSnapshot, inputHash: result.inputSnapshot.inputHash,
      resultSnapshot: result.resultSnapshot, resultHash: result.resultSnapshot.resultHash }));
    previous = result.resultSnapshot;
  }
  const finalInventory = previous!.inventoryState;
  const stocks: PersistedInventoryStock[] = finalInventory.stocks.map((stock, index) => Object.freeze({
    id: `stock:${index}`, inventoryItemId: `item:${index}`, ingredientId: stock.ingredientId, pool: stock.pool,
    version: 1, onHandPoints: stock.onHandPoints,
    reservedUndeliveredPoints: finalInventory.reservedUndelivered.filter((entry) => entry.ingredientId === stock.ingredientId)
      .reduce((total, entry) => total + entry.quantityPoints, 0), costPoolMinor: stock.costPool.minorUnits,
  }));
  const audits: PersistedInventoryAudit[] = executions.flatMap((execution) => {
    const prior = execution.inputSnapshot.inventoryState.transactions.length;
    return execution.resultSnapshot.inventoryState.transactions.slice(prior).map((transaction, commandSequence) => Object.freeze({
      commandId: execution.commandId, commandSequence, ingredientId: transaction.ingredientId,
      metadata: Object.freeze({ schemaVersion: 'gameplay.service-inventory-audit/v1', domainSequence: transaction.sequence,
        domainTransactionId: transaction.transactionId, domainType: transaction.type,
        ingredientId: transaction.ingredientId, quantityPoints: transaction.quantityPoints }),
    }));
  });
  return { plan, openingSnapshot, envelope, executions: Object.freeze(executions), stocks: Object.freeze(stocks), audits: Object.freeze(audits) };
}

class SettlementDatabase implements D03Database {
  readonly fixture: Fixture;
  readonly calls: string[] = [];
  failAt: string | undefined;
  private forgedResultHash: string | undefined;
  private state: State;

  constructor(plan: Plan) {
    this.fixture = createFixture(plan);
    this.state = {
      version: plan === 'TWO_PERIODS' ? 5 : 6,
      receipts: new Map(), dayStatus: 'SERVICE_COMPLETE', settledByCommandId: null,
      stocks: new Map(this.fixture.stocks.map((stock) => [stock.id, structuredClone(stock)])),
      serviceAudits: structuredClone(this.fixture.audits), wasteAudits: [], replay: [], dayEnd: null,
      risk: [], reputation: [], ledger: null, outbox: [],
    };
  }

  get snapshot(): State { return cloneState(this.state); }
  tamperExecutionResultHash(): void {
    this.forgedResultHash = 'f'.repeat(64);
  }

  async $transaction<T>(operation: (transaction: D03Queryable) => Promise<T>): Promise<T> {
    const next = cloneState(this.state);
    const transaction: D03Queryable = { $queryRawUnsafe: async <R>(query: string, ...values: readonly unknown[]): Promise<R> => {
      this.calls.push(query);
      if (this.failAt && query.includes(this.failAt)) throw new Error(`injected ${this.failAt}`);
      if (query.includes('INSERT INTO "IdempotencyRecord"')) {
        const key = JSON.stringify([values[3], values[4]]);
        if (next.receipts.has(key)) return [] as R;
        next.receipts.set(key, { commandId: String(values[0]), fingerprint: String(values[5]), snapshot: undefined });
        return [{ id: values[0] }] as R;
      }
      if (query.includes('SELECT "id" AS "commandId"')) {
        const receipt = next.receipts.get(JSON.stringify([values[0], values[1]]))!;
        return [{ commandId: receipt.commandId, requestFingerprint: receipt.fingerprint, status: 'COMPLETED', responseSnapshot: receipt.snapshot }] as R;
      }
      if (query.includes('SELECT save."version"')) return [{ version: next.version }] as R;
      if (query.includes('/* settle-business-day:scope */')) return [this.scopeRow(next)] as R;
      if (query.includes('/* settle-business-day:inventory-pools */')) return [
        { saveId: 'save-1', pool: 'DURABLE', revision: 1, capacityPoints: 305n, storageBundleVersion: 'mvp-storage/v1', storageBundleKind: 'BASIC' },
        { saveId: 'save-1', pool: 'PERISHABLE', revision: 1, capacityPoints: 305n, storageBundleVersion: 'mvp-storage/v1', storageBundleKind: 'BASIC' },
      ] as R;
      if (query.includes('/* settle-business-day:executions */')) return this.fixture.executions.map((entry) => ({
        id: entry.id, ordinal: entry.ordinal, periodKey: entry.periodKey, commandId: entry.commandId,
        simulationRuleVersion: entry.simulationRuleVersion, inputSnapshot: entry.inputSnapshot, inputHash: entry.inputHash,
        resultSnapshot: entry.resultSnapshot,
        resultHash: entry.ordinal === 1 ? (this.forgedResultHash ?? entry.resultHash) : entry.resultHash,
      })) as R;
      if (query.includes('/* settle-business-day:inventory-stocks */')) return [...next.stocks.values()]
        .sort((a,b) => a.ingredientId.localeCompare(b.ingredientId)).map((stock) => ({
          id: stock.id, inventoryItemId: stock.inventoryItemId, ingredientId: stock.ingredientId, pool: stock.pool,
          version: stock.version, onHand: stock.onHandPoints, reservedUndelivered: stock.reservedUndeliveredPoints,
          costPoolMinor: stock.costPoolMinor,
        })) as R;
      if (query.includes('/* settle-business-day:inventory-audits */')) return next.serviceAudits as R;
      if (query.includes('/* settle-business-day:latest-risk */')) return next.risk.slice(-1) as R;
      if (query.includes('/* settle-business-day:reputation-history */')) return next.reputation as R;
      if (query.includes('/* settle-business-day:existing-evidence */')) return [{ replayCount: BigInt(next.replay.length), dayEndCount: BigInt(next.dayEnd ? 1 : 0) }] as R;
      if (query.includes('/* settle-business-day:waste-stock */')) {
        const stock = next.stocks.get(String(values[2]));
        if (!stock || stock.version !== Number(values[3]) || stock.onHandPoints !== Number(values[4]) ||
            stock.reservedUndeliveredPoints !== Number(values[5]) || stock.costPoolMinor !== String(values[6])) return [] as R;
        const updated = { ...stock, version: stock.version + 1, onHandPoints: 0, costPoolMinor: '0' };
        next.stocks.set(stock.id, updated);
        return [{ version: updated.version, onHand: 0, reservedUndelivered: updated.reservedUndeliveredPoints, costPoolMinor: '0' }] as R;
      }
      if (query.includes('/* settle-business-day:insert-waste-audit */')) {
        next.wasteAudits.push({ id: values[0], transactionId: values[4], commandId: values[5], commandSequence: values[6],
          stockVersion: values[7], quantityDelta: values[8], amountMinor: values[10], metadata: JSON.parse(String(values[12])) });
        return [{ id: values[0], transactionId: values[4] }] as R;
      }
      if (query.includes('/* settle-business-day:verify-final-stock */')) {
        const stock = next.stocks.get(String(values[2]));
        return stock ? [{ version: stock.version, onHand: stock.onHandPoints,
          reservedUndelivered: stock.reservedUndeliveredPoints, costPoolMinor: stock.costPoolMinor }] as R : [] as R;
      }
      if (query.includes('/* settle-business-day:insert-replay-event */')) {
        const row = { id: values[0], eventId: values[3], servicePeriodExecutionId: values[4], sequence: values[5],
          eventType: values[6], simulationRuleVersion: values[7], payload: JSON.parse(String(values[8])), eventHash: values[9] };
        next.replay.push(row); return [{ id: row.id, eventId: row.eventId, sequence: row.sequence, eventHash: row.eventHash }] as R;
      }
      if (query.includes('/* settle-business-day:insert-day-end */')) {
        next.dayEnd = { id: values[0], eventHash: values[32], snapshotHash: values[33], fixed: JSON.parse(String(values[35])) };
        return [{ id: values[0], eventHash: values[32], snapshotHash: values[33] }] as R;
      }
      if (query.includes('/* settle-business-day:insert-risk-state */')) {
        const row = { id: values[0], version: 1, businessDay: 1, status: values[3], reason: values[4],
          precondition: JSON.parse(String(values[5])), postcondition: JSON.parse(String(values[6])) };
        next.risk.push(row); return [{ id: row.id, version: 1, status: row.status }] as R;
      }
      if (query.includes('/* settle-business-day:insert-reputation-history */')) {
        const row = { id: values[0], businessDay: 1, dimension: values[3], version: 1, score: values[4], reason: 'DAY_END_SERVICE_RESULT' };
        next.reputation.push(row); return [{ id: row.id, dimension: row.dimension, version: 1, score: row.score }] as R;
      }
      if (query.includes('/* settle-business-day:transition-day */')) {
        if (next.dayStatus !== 'SERVICE_COMPLETE') return [] as R;
        next.dayStatus = 'SETTLED'; next.settledByCommandId = String(values[3]);
        return [{ id: 'business-day:1', status: 'SETTLED', settledByCommandId: values[3] }] as R;
      }
      if (query.includes('INSERT INTO "LedgerTransaction"')) {
        next.ledger = { id: String(values[0]), currency: String(values[5]), lines: [] }; return [] as R;
      }
      if (query.includes('INSERT INTO "LedgerLine"')) {
        next.ledger!.lines.push({ accountCode: String(values[4]), direction: String(values[5]), amountMinor: String(values[6]) }); return [] as R;
      }
      if (query.includes('INSERT INTO "OutboxEvent"')) {
        next.outbox.push({ id: values[0], transactionId: values[3], commandId: values[4], eventType: values[7], payload: JSON.parse(String(values[9])) }); return [] as R;
      }
      if (query.includes('UPDATE "CompetitiveSave"')) {
        if (next.version !== Number(values[2])) return [] as R;
        next.version = Number(values[3]); return [{ version: next.version }] as R;
      }
      if (query.includes('UPDATE "IdempotencyRecord"')) {
        const found = [...next.receipts.entries()].find(([, receipt]) => receipt.commandId === values[0])!;
        next.receipts.set(found[0], { ...found[1], snapshot: JSON.parse(String(values[1])) }); return [] as R;
      }
      throw new Error(`unexpected query: ${query}`);
    }};
    const result = await operation(transaction);
    this.assertLedgerBalanced(next);
    this.state = next;
    return result;
  }

  private scopeRow(next: State) {
    const { openingSnapshot, envelope, plan } = this.fixture;
    return { saveId: 'save-1', openingScenario: 'DEFAULT_SMALL_SHOP', operatingMode: 'STRATEGY',
      saveServicePeriodPlan: plan, demandSeed: DEMAND_SEED, saveSimulationRuleVersion: openingSnapshot.simulationRuleVersion,
      openingSnapshot, openingSnapshotHash: openingSnapshot.openingSnapshotHash, membershipRole: 'OWNER',
      businessDayId: 'business-day:1', businessDayStatus: next.dayStatus,
      businessDayServicePeriodPlan: plan, businessDaySimulationRuleVersion: openingSnapshot.simulationRuleVersion,
      openedByCommandId: 'open-command', settledByCommandId: next.settledByCommandId,
      settledAt: next.dayStatus === 'SETTLED' ? 'settled' : null, consumedPreopenSnapshotId: envelope.preopenSnapshotId,
      openSnapshotHash: envelope.preopenSnapshotHash, openSnapshotMatches: true,
      preopenSnapshotId: envelope.preopenSnapshotId, preopenRevision: 1,
      preopenCommandId: '11111111-1111-4111-8111-111111111111', preopenSnapshotSchemaVersion: envelope.envelopeVersion,
      preopenSimulationRuleVersion: openingSnapshot.simulationRuleVersion,
      preopenPayload: envelope, preopenSnapshotHash: envelope.preopenSnapshotHash };
  }

  private assertLedgerBalanced(state: State): void {
    if (!state.ledger) return;
    const debit = state.ledger.lines.filter((line) => line.direction === 'DEBIT').reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
    const credit = state.ledger.lines.filter((line) => line.direction === 'CREDIT').reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
    if (state.ledger.lines.length < 2 || debit !== credit || debit <= 0n) throw new Error('fake PostgreSQL deferred ledger balance failure');
  }
}

function cloneState(state: State): State {
  return { version: state.version, receipts: new Map([...state.receipts].map(([key,value]) => [key, structuredClone(value)])),
    dayStatus: state.dayStatus, settledByCommandId: state.settledByCommandId,
    stocks: new Map([...state.stocks].map(([key,value]) => [key, structuredClone(value)])),
    serviceAudits: structuredClone(state.serviceAudits), wasteAudits: structuredClone(state.wasteAudits),
    replay: structuredClone(state.replay), dayEnd: structuredClone(state.dayEnd), risk: structuredClone(state.risk),
    reputation: structuredClone(state.reputation), ledger: structuredClone(state.ledger), outbox: structuredClone(state.outbox) };
}

function command(id = SETTLE_ID, key = 'settle-day-1', expectedVersion = 5): CommandEnvelope {
  return { schemaVersion: COMMAND_ENVELOPE_VERSION, commandId: id, idempotencyKey: key,
    commandType: SETTLE_BUSINESS_DAY, aggregateId: 'save-1', expectedVersion, payload: { businessDay: 1 } };
}
function dispatch(db: SettlementDatabase, envelope: CommandEnvelope) {
  return new CommandDispatcher([createSettleBusinessDayCommandHandler()], new PostgresDurableCommandExecutionStore(db))
    .dispatch({ context, target: { saveId: 'save-1', commandType: SETTLE_BUSINESS_DAY }, envelope });
}

for (const plan of ['TWO_PERIODS','THREE_PERIODS'] as const) {
  test(`durably settles ${plan} with exact replay, waste, balanced ledger, and redacted projection`, async () => {
    const db = new SettlementDatabase(plan);
    const expectedVersion = plan === 'TWO_PERIODS' ? 5 : 6;
    const result = await dispatch(db, command(SETTLE_ID, `settle-${plan}`, expectedVersion));
    const state = db.snapshot;
    assert.equal(result.status, 200);
    assert.equal(state.version, expectedVersion + 1);
    assert.equal(state.dayStatus, 'SETTLED');
    assert.equal(state.replay.length, plan === 'TWO_PERIODS' ? 6 : 7);
    assert.deepEqual(state.replay.map((entry) => entry.sequence), state.replay.map((_, index) => index));
    assert.equal(new Set(state.replay.map((entry) => entry.eventHash)).size, 1);
    assert.equal(state.dayEnd?.eventHash, state.replay[0]?.eventHash);
    assert.equal(state.risk.length, 1);
    assert.equal(state.reputation.length, 5);
    assert.ok(state.wasteAudits.length > 0);
    assert.ok(state.ledger && state.ledger.lines.length >= 2);
    const debit = state.ledger!.lines.filter((line) => line.direction === 'DEBIT').reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
    const credit = state.ledger!.lines.filter((line) => line.direction === 'CREDIT').reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
    assert.equal(debit, credit);
    const fixed = state.dayEnd!.fixed as Record<string, { minorUnits: string }>;
    const openingInventory = db.fixture.executions[0]!.inputSnapshot.inventoryState;
    const procurement = openingInventory.transactions
      .filter((entry) => entry.type === 'RECEIPT')
      .reduce((sum, entry) => sum + BigInt(entry.amount.minorUnits), 0n);
    const expectedCashBeforePenalty =
      BigInt(db.fixture.openingSnapshot.settlementCash.amount.minorUnits) - procurement +
      BigInt(fixed.grossRevenue!.minorUnits) - BigInt(fixed.payroll!.minorUnits) - BigInt(fixed.opex!.minorUnits);
    assert.equal(
      BigInt(fixed.cashAfter!.minorUnits) + BigInt(fixed.riskPenalty!.minorUnits),
      expectedCashBeforePenalty,
      'COGS and waste must not be charged to cash a second time',
    );
    assert.equal(
      BigInt(fixed.dailyNet!.minorUnits),
      BigInt(fixed.grossRevenue!.minorUnits) - BigInt(fixed.cogs!.minorUnits) -
        BigInt(fixed.wasteLoss!.minorUnits) - BigInt(fixed.payroll!.minorUnits) -
        BigInt(fixed.opex!.minorUnits) - BigInt(fixed.riskPenalty!.minorUnits),
      'P&L must still recognize COGS and waste exactly once',
    );
    assert.equal(state.outbox.length, 1);
    assert.equal(state.outbox[0]?.eventType, BUSINESS_DAY_SETTLED_EVENT_TYPE);
    const publicBytes = JSON.stringify([result.body.result, state.outbox]);
    for (const hidden of [DEMAND_SEED, MARKET_SEED, 'arrivals', 'inventoryState', 'inventoryOutcomes', 'grossRevenue', 'cogs', 'costPoolMinor', 'settlementPolicyEvidence']) {
      assert.equal(publicBytes.includes(hidden), false, `${hidden} leaked`);
    }
    assert.equal(publicBytes.includes('simulation.versioned-replay.requested'), false);
  });
}

test('idempotency replays exactly without duplicate settlement writes', async () => {
  const db = new SettlementDatabase('TWO_PERIODS');
  const first = await dispatch(db, command());
  const replay = await dispatch(db, command('99999999-9999-4999-8999-999999999999'));
  assert.deepEqual(replay, first);
  const state = db.snapshot;
  assert.equal(state.replay.length, 6);
  assert.equal(state.risk.length, 1);
  assert.equal(state.reputation.length, 5);
  assert.equal(state.outbox.length, 1);
  assert.equal(state.version, 6);
});

test('stale, malformed, and forged provenance reject before settlement writes', async () => {
  const stale = new SettlementDatabase('TWO_PERIODS');
  await assert.rejects(dispatch(stale, command(SETTLE_ID, 'stale', 4)),
    (error) => error instanceof CommandError && error.code === 'EXPECTED_VERSION_CONFLICT');
  assert.equal(stale.calls.some((query) => query.includes('settle-business-day:scope')), false);

  const malformed = new SettlementDatabase('TWO_PERIODS');
  await assert.rejects(dispatch(malformed, { ...command(), payload: { businessDay: 1, riskState: 'NORMAL' } }),
    (error) => error instanceof CommandError && error.code === 'SETTLE_BUSINESS_DAY_INTENT_INVALID');
  assert.equal(malformed.calls.some((query) => query.includes('settle-business-day:scope')), false);

  const forged = new SettlementDatabase('TWO_PERIODS');
  forged.tamperExecutionResultHash();
  const before = forged.snapshot;
  await assert.rejects(dispatch(forged, command()),
    (error) => error instanceof CommandError && error.code === 'SETTLEMENT_AUTHORITY_INVALID');
  assert.deepEqual(forged.snapshot, before);
  assert.equal(forged.calls.some((query) => query.includes('settle-business-day:waste-stock')), false);
});

for (const marker of [
  'settle-business-day:waste-stock',
  'settle-business-day:insert-waste-audit',
  'settle-business-day:insert-replay-event',
  'settle-business-day:insert-day-end',
  'settle-business-day:insert-risk-state',
  'settle-business-day:insert-reputation-history',
  'settle-business-day:transition-day',
  'INSERT INTO "LedgerTransaction"',
  'INSERT INTO "LedgerLine"',
  'INSERT INTO "OutboxEvent"',
  'UPDATE "CompetitiveSave"',
  'UPDATE "IdempotencyRecord"',
] as const) {
  test(`injected ${marker} failure rolls back every settlement projection`, async () => {
    const db = new SettlementDatabase('TWO_PERIODS');
    const before = db.snapshot;
    db.failAt = marker;
    await assert.rejects(dispatch(db, command()), new RegExp(`injected ${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.deepEqual(db.snapshot, before);
  });
}
