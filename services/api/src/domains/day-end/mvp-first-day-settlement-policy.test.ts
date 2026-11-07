import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { deriveFloorFlowServiceProfile } from '../demand-flow/demand-flow.js';
import {
  MVP_FIRST_DAY_CATALOG_VERSIONS,
  resolveMvpFirstDayCatalog,
} from '../inventory-procurement/mvp-first-day-catalog.js';
import type { InventoryState } from '../inventory-procurement/inventory.js';
import { createOpeningSnapshot } from '../opening-scenario/snapshot.js';
import { MVP_OPENING_VERSIONS } from '../opening-scenario/registry.js';
import type { RecipeServiceSnapshot } from '../service-quality/service-quality.js';
import {
  advanceServicePeriod,
  replayAdvanceServicePeriod,
  type AdvanceServicePeriodInputSnapshot,
} from '../../gameplay/advance-service-period.js';
import {
  MVP_FIRST_DAY_MARKET_SEED_VERSION,
  provideCanonicalFirstDayPreopenArtifacts,
} from '../../gameplay/preopen-day-authority-provider.js';
import { parseConfigurePreopenDayIntent } from '../../gameplay/preopen-day-contract.js';
import { createPreopenDayPlan } from '../../gameplay/preopen-day-plan.js';
import type { FirstDayOpenAuthority } from '../../gameplay/prisma-open-business-day-repository.js';
import type {
  PersistedAdvanceExecution,
  PersistedInventoryAudit,
  PersistedInventoryStock,
} from '../../gameplay/prisma-advance-service-period-repository.js';
import {
  MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION,
  composeMvpFirstDaySettlementEvidence,
  parseMvpFirstDaySettlementEvidenceSelfConsistency,
  resolveMvpFirstDaySettlementPolicy,
  resolveMvpFirstDaySettlementSimulationRule,
  type MvpFirstDaySettlementLockedRecords,
} from './mvp-first-day-settlement-policy.js';

const DEMAND_SEED = 'server-demand-seed-settlement';
const MARKET_SEED = 'independent-market-seed-settlement';

function mutableClone<T>(value: T): any {
  return JSON.parse(JSON.stringify(value));
}

function canonicalizeForAdvanceHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForAdvanceHash);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalizeForAdvanceHash(nested)]),
    );
  }
  return value;
}

function replaceWithCanonicallyRehashedExecution(
  records: any,
  index: number,
  mutate: (input: any) => void,
): void {
  const input = mutableClone(records.executions[index].inputSnapshot);
  mutate(input);
  delete input.inputHash;
  input.inputHash = createHash('sha256')
    .update(JSON.stringify(canonicalizeForAdvanceHash(input)))
    .digest('hex');
  const result = replayAdvanceServicePeriod(input as AdvanceServicePeriodInputSnapshot);
  records.executions[index].inputSnapshot = input;
  records.executions[index].inputHash = input.inputHash;
  records.executions[index].resultSnapshot = result;
  records.executions[index].resultHash = result.resultHash;
}

function configured() {
  const openingSnapshot = createOpeningSnapshot(
    { scenario: 'DEFAULT_SMALL_SHOP', operatingMode: 'STRATEGY', currency: 'TWD' },
    MVP_OPENING_VERSIONS,
  );
  const artifacts = provideCanonicalFirstDayPreopenArtifacts({
    command: {
      commandId: '11111111-1111-4111-8111-111111111111',
      preopenSnapshotId: 'preopen:settlement',
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

function openingInventory(plan: ReturnType<typeof configured>['plan']): InventoryState {
  const opening = plan.privateEnvelope.inventoryProcurement;
  return Object.freeze({
    currency: 'TWD',
    capacity: opening.capacity,
    stocks: opening.openingStocks,
    orderReservations: opening.openingReservations,
    reservedUndelivered: opening.reservedUndelivered,
    transactions: Object.freeze(
      opening.openingStocks.map((stock, index) =>
        Object.freeze({
          sequence: index + 1,
          transactionId: `opening-receipt:${stock.ingredientId}`,
          type: 'RECEIPT' as const,
          ingredientId: stock.ingredientId,
          quantityPoints: stock.onHandPoints,
          amount: stock.costPool,
          referenceId: plan.privateEnvelope.preopenSnapshotId,
        }),
      ),
    ),
  });
}

function lockedRecords(): MvpFirstDaySettlementLockedRecords {
  const { openingSnapshot, plan } = configured();
  const envelope = plan.privateEnvelope;
  const catalog = resolveMvpFirstDayCatalog(MVP_FIRST_DAY_CATALOG_VERSIONS, {
    code: 'TWD',
    metadataVersion: openingSnapshot.currencyMetadataVersion,
  });
  const menuIds = envelope.menu.items.map((item) => item.recipeVersionId);
  const recipeVersions = catalog.recipeCatalog.filter((recipe) => menuIds.includes(recipe.id));
  const enabledIds = new Set(envelope.menu.items.flatMap((item) => item.enabledSubstitutionIds));
  const enabledSubstitutions = catalog.substitutionCatalog.filter((entry) =>
    enabledIds.has(entry.id),
  );
  const recipes: readonly RecipeServiceSnapshot[] = recipeVersions.map((recipe) => {
    const item = envelope.menu.items.find((candidate) => candidate.recipeVersionId === recipe.id)!;
    return Object.freeze({
      id: recipe.id,
      baseQuality: recipe.baseQuality,
      substitutionQualityDelta: 0,
      recommendedPrice: Number(item.basePrice.minorUnits),
      salePrice: Number(item.salePrice.minorUnits),
      portions: 0,
    });
  });
  const initialInventory = openingInventory(plan);
  const periods = ['LUNCH', 'DINNER'] as const;
  const assignments = ['KITCHEN', 'NONE'] as const;
  const executions: PersistedAdvanceExecution[] = [];
  let previousResult: PersistedAdvanceExecution['resultSnapshot'] | undefined;
  for (const [index, period] of periods.entries()) {
    const groups = envelope.demandSchedule.groups.filter((group) => group.period === period);
    const activeGuests = groups.reduce((total, group) => total + group.size, 0);
    const profile = deriveFloorFlowServiceProfile(envelope.layout, {
      seatedGuests: 0,
      waitingGroups: 0,
      activeGuests,
      demandGroups: Math.max(1, groups.length),
    });
    const result = advanceServicePeriod(
      { businessDay: 1, expectedPeriodKey: period, ownerAssignment: assignments[index]! },
      {
        businessDay: 1,
        servicePeriodPlan: 'TWO_PERIODS',
        initiator: { actorId: 'owner-1', role: 'OWNER' },
        npcContracts: openingSnapshot.npcContracts,
        demandSchedule: envelope.demandSchedule,
        recipes,
        inventoryState: previousResult?.inventoryState ?? initialInventory,
        recipeVersions,
        enabledSubstitutions,
        equipment: { kitchen: 'BASIC', front: 'BASIC' },
        kitchenExecutionQualityModifier: 0,
        floorFlowServiceProfile: profile,
        openingReputation: previousResult === undefined ? openingSnapshot.reputation : undefined,
        previousResult,
      },
    );
    executions.push(
      Object.freeze({
        id: `execution:${index + 1}`,
        ordinal: index + 1,
        periodKey: period,
        commandId: `command:${index + 1}`,
        simulationRuleVersion: openingSnapshot.simulationRuleVersion,
        inputSnapshot: result.inputSnapshot,
        inputHash: result.inputSnapshot.inputHash,
        resultSnapshot: result.resultSnapshot,
        resultHash: result.resultSnapshot.resultHash,
      }),
    );
    previousResult = result.resultSnapshot;
  }
  const finalInventory = previousResult!.inventoryState;
  const inventoryStocks: PersistedInventoryStock[] = finalInventory.stocks.map((stock, index) =>
    Object.freeze({
      id: `stock:${index}`,
      inventoryItemId: `item:${index}`,
      ingredientId: stock.ingredientId,
      pool: stock.pool,
      version: 1,
      onHandPoints: stock.onHandPoints,
      reservedUndeliveredPoints: finalInventory.reservedUndelivered
        .filter((entry) => entry.ingredientId === stock.ingredientId)
        .reduce((total, entry) => total + entry.quantityPoints, 0),
      costPoolMinor: stock.costPool.minorUnits,
    }),
  );
  const inventoryAudits: PersistedInventoryAudit[] = executions.flatMap((execution) => {
    const prior = execution.inputSnapshot.inventoryState.transactions.length;
    return execution.resultSnapshot.inventoryState.transactions
      .slice(prior)
      .map((transaction, commandSequence) =>
        Object.freeze({
          commandId: execution.commandId,
          commandSequence,
          ingredientId: transaction.ingredientId,
          metadata: Object.freeze({
            schemaVersion: 'gameplay.service-inventory-audit/v1',
            domainSequence: transaction.sequence,
            domainTransactionId: transaction.transactionId,
            domainType: transaction.type,
            ingredientId: transaction.ingredientId,
            quantityPoints: transaction.quantityPoints,
          }),
        }),
      );
  });
  const openAuthority: FirstDayOpenAuthority = Object.freeze({
    save: Object.freeze({
      id: 'save-1',
      scenario: 'DEFAULT_SMALL_SHOP',
      operatingMode: 'STRATEGY',
      servicePeriodPlan: 'TWO_PERIODS',
      demandSeed: DEMAND_SEED,
      simulationRuleVersion: openingSnapshot.simulationRuleVersion,
      openingSnapshot,
      openingSnapshotHash: openingSnapshot.openingSnapshotHash,
    }),
    businessDay: Object.freeze({
      id: 'business-day:1',
      status: 'SERVICE_COMPLETE',
      servicePeriodPlan: 'TWO_PERIODS',
      simulationRuleVersion: openingSnapshot.simulationRuleVersion,
    }),
    preopenSnapshot: Object.freeze({
      id: envelope.preopenSnapshotId,
      revision: 1,
      commandId: '11111111-1111-4111-8111-111111111111',
      snapshotSchemaVersion: envelope.envelopeVersion,
      simulationRuleVersion: openingSnapshot.simulationRuleVersion,
      payload: envelope,
      snapshotHash: envelope.preopenSnapshotHash,
    }),
    inventoryPoolAuthorities: Object.freeze([
      Object.freeze({
        saveId: 'save-1',
        pool: 'DURABLE',
        revision: 1,
        capacityPoints: 305,
        storageBundleVersion: 'mvp-storage/v1',
        storageBundleKind: 'BASIC',
      }),
      Object.freeze({
        saveId: 'save-1',
        pool: 'PERISHABLE',
        revision: 1,
        capacityPoints: 305,
        storageBundleVersion: 'mvp-storage/v1',
        storageBundleKind: 'BASIC',
      }),
    ]),
  });
  return Object.freeze({
    policyVersion: MVP_FIRST_DAY_SETTLEMENT_POLICY_VERSION,
    businessDay: 1,
    openAuthority,
    executions: Object.freeze(executions),
    e03: Object.freeze({
      openingInventory: initialInventory,
      finalInventoryBeforeWaste: finalInventory,
      periodOutcomes: Object.freeze(
        executions.map((execution) =>
          Object.freeze({
            ordinal: execution.ordinal,
            resultHash: execution.resultHash,
            outcomes: execution.resultSnapshot.inventoryOutcomes,
          }),
        ),
      ),
      inventoryStocks: Object.freeze(inventoryStocks),
      inventoryAudits: Object.freeze(inventoryAudits),
    }),
  });
}

test('derives cash, P&L, payroll, rent, waste, and depreciation only from locked records', () => {
  const records = lockedRecords();
  const evidence = composeMvpFirstDaySettlementEvidence(records);
  const openingCash = BigInt(
    records.openAuthority.save.openingSnapshot.settlementCash.amount.minorUnits,
  );
  const procurement = records.e03.openingInventory.transactions.reduce(
    (total, entry) => total + BigInt(entry.amount.minorUnits),
    0n,
  );
  const revenue = BigInt(evidence.profitAndLoss.grossRevenue.minorUnits);
  const payroll = BigInt(evidence.profitAndLoss.payroll.minorUnits);
  const rent = BigInt(evidence.profitAndLoss.rent.minorUnits);
  const cogs = BigInt(evidence.profitAndLoss.cogs.minorUnits);
  const waste = BigInt(evidence.profitAndLoss.wasteLoss.minorUnits);
  assert.equal(
    evidence.cashFlow.openingCashAfterPreopenProcurement.minorUnits,
    (openingCash - procurement).toString(),
  );
  assert.equal(
    evidence.cashFlow.cashBeforeE05RiskPenalty.minorUnits,
    (openingCash - procurement + revenue - payroll - rent).toString(),
  );
  assert.equal(
    evidence.profitAndLoss.operatingProfit.minorUnits,
    (revenue - cogs - waste - payroll - rent).toString(),
  );
  assert.deepEqual(
    evidence.payrollEntries.map((entry) => entry.contractKey),
    ['npc-contract:cashier:1', 'npc-contract:kitchen:1'],
  );
  assert.equal(evidence.profitAndLoss.equipmentDepreciation.minorUnits, '200');
  assert.equal(evidence.cashFlow.preopenProcurementRecharged, false);
  assert.equal(evidence.cashFlow.cogsCashChargedAtSettlement, false);
  assert.equal(evidence.cashFlow.wasteCashChargedAtSettlement, false);
});

test('derives fairness from replayed assignments and keeps canonical Day1 risk/zero policy', () => {
  const evidence = composeMvpFirstDaySettlementEvidence(lockedRecords());
  assert.equal(evidence.fairness.scheduledPeriodUnits, 5);
  assert.equal(evidence.fairness.fulfilledPeriodUnits, 5);
  assert.equal(evidence.fairness.scheduledTickUnits, 50);
  assert.equal(evidence.fairness.fulfilledTickUnits, 50);
  assert.deepEqual(evidence.riskOpeningState, {
    state: 'NORMAL',
    consecutiveDelinquentDays: 0,
    consecutiveResolutionDays: 0,
    delinquencyBaselineShortfall: null,
  });
  assert.ok(
    Object.values(evidence.explicitFirstDayZeroPolicy).every((amount) => amount.minorUnits === '0'),
  );
});

test('rejects independently supplied financial/risk/evidence authority and forged immutable rows', () => {
  for (const forbidden of ['financials', 'riskState', 'evidence']) {
    const forged = mutableClone(lockedRecords());
    forged[forbidden] = {};
    assert.throws(() => composeMvpFirstDaySettlementEvidence(forged), /must contain exactly/);
  }
  const forgedCogs = mutableClone(lockedRecords());
  forgedCogs.executions[0].resultSnapshot.inventoryOutcomes[0].cogs.minorUnits = '999999';
  assert.throws(() => composeMvpFirstDaySettlementEvidence(forgedCogs), /forged or noncanonical/);
  const forgedStock = mutableClone(lockedRecords());
  forgedStock.e03.inventoryStocks[0].costPoolMinor = '999999';
  assert.throws(
    () => composeMvpFirstDaySettlementEvidence(forgedStock),
    /persisted stock projection is stale/,
  );
});

test('rejects canonically rehashed cross-period continuation forks', () => {
  const mutations: readonly Readonly<{
    name: string;
    mutate: (input: any, records: any) => void;
  }>[] = [
    {
      name: 'inventoryState',
      mutate: (input, records) => {
        input.inventoryState = mutableClone(records.e03.openingInventory);
      },
    },
    {
      name: 'initialReputation',
      mutate: (input) => {
        input.initialReputation.price += 1;
      },
    },
    {
      name: 'eventSequenceStart',
      mutate: (input) => {
        input.eventSequenceStart += 10;
      },
    },
    {
      name: 'previousResultHash',
      mutate: (input) => {
        input.previousResultHash = 'f'.repeat(64);
      },
    },
  ];
  for (const entry of mutations) {
    const records = mutableClone(lockedRecords());
    replaceWithCanonicallyRehashedExecution(records, 1, (input) => entry.mutate(input, records));
    assert.throws(
      () => composeMvpFirstDaySettlementEvidence(records),
      /authority provenance is forged or noncanonical/,
      entry.name,
    );
  }

  const completedPrefix = mutableClone(lockedRecords());
  const input = completedPrefix.executions[1].inputSnapshot;
  input.completedPeriodKeysBefore = ['DINNER'];
  delete input.inputHash;
  input.inputHash = createHash('sha256')
    .update(JSON.stringify(canonicalizeForAdvanceHash(input)))
    .digest('hex');
  completedPrefix.executions[1].inputHash = input.inputHash;
  assert.throws(
    () => composeMvpFirstDaySettlementEvidence(completedPrefix),
    /progression is invalid|authority provenance is forged or noncanonical/,
  );
});

test('rejects canonical alternate inputs that mismatch locked demand/menu/catalog/NPC/floor/opening sources', () => {
  const mutations: readonly Readonly<{ name: string; mutate: (input: any) => void }>[] = [
    {
      name: 'demand seed',
      mutate: (input) => {
        input.demandSeed = 'forged-demand-seed';
      },
    },
    {
      name: 'period arrivals',
      mutate: (input) => {
        input.arrivals[0].cohort =
          input.arrivals[0].cohort === 'PRICE_SENSITIVE' ? 'TIME_SENSITIVE' : 'PRICE_SENSITIVE';
      },
    },
    {
      name: 'menu price',
      mutate: (input) => {
        input.recipes[0].salePrice += 1;
      },
    },
    {
      name: 'recipe version',
      mutate: (input) => {
        input.recipeVersions[0].baseQuality += 1;
        input.recipes[0].baseQuality += 1;
      },
    },
    {
      name: 'substitution terms',
      mutate: (input) => {
        input.enabledSubstitutions[0].qualityDelta -= 1;
      },
    },
    {
      name: 'NPC roster',
      mutate: (input) => {
        input.workers[0].id = 'npc:forged:1';
      },
    },
    {
      name: 'kitchen modifier',
      mutate: (input) => {
        input.kitchenExecutionQualityModifier = -1;
      },
    },
    {
      name: 'floor profile',
      mutate: (input) => {
        input.floorFlowServiceProfile.frontServiceDelayTicks += 1;
      },
    },
    {
      name: 'opening reputation',
      mutate: (input) => {
        input.initialReputation.vibe += 1;
      },
    },
  ];
  for (const entry of mutations) {
    const records = mutableClone(lockedRecords());
    try {
      replaceWithCanonicallyRehashedExecution(records, 0, entry.mutate);
    } catch (error) {
      assert.match(
        error instanceof Error ? error.message : '',
        /capacity or drain authority was forged|inventory authority|canonical/,
        entry.name,
      );
      continue;
    }
    assert.throws(
      () => composeMvpFirstDaySettlementEvidence(records),
      /authority provenance is forged or noncanonical/,
      entry.name,
    );
  }

  const equipment = mutableClone(lockedRecords());
  equipment.executions[0].inputSnapshot.equipment = { kitchen: 'AGED', front: 'AGED' };
  assert.throws(
    () => composeMvpFirstDaySettlementEvidence(equipment),
    /input hash does not match|capacity or drain authority was forged|authority provenance is forged or noncanonical/,
  );
});

test('rejects unknown simulation rules without a latest-version fallback', () => {
  assert.throws(
    () => resolveMvpFirstDaySettlementSimulationRule('mvp-e01-v2'),
    /fallback is prohibited/,
  );
  const forged = mutableClone(lockedRecords());
  forged.openAuthority.save.simulationRuleVersion = 'mvp-e01-v2';
  assert.throws(() => composeMvpFirstDaySettlementEvidence(forged), /fallback is prohibited/);
  assert.throws(
    () => resolveMvpFirstDaySettlementPolicy('mvp-first-day-settlement-policy/v2'),
    /unknown MVP first-day settlement policy version/,
  );
});

test('self-consistency parser checks shape/arithmetic/hash but is not an authority provider', () => {
  const evidence = composeMvpFirstDaySettlementEvidence(lockedRecords());
  assert.equal(parseMvpFirstDaySettlementEvidenceSelfConsistency(evidence), evidence);
  assert.match(evidence.evidenceHash, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(evidence.fairness.workers));
  const tampered = mutableClone(evidence);
  tampered.cashFlow.cashBeforeE05RiskPenalty.minorUnits = '1';
  assert.throws(
    () => parseMvpFirstDaySettlementEvidenceSelfConsistency(tampered),
    /cash-flow arithmetic is invalid|hash does not match payload/,
  );
  const unknown = mutableClone(evidence);
  unknown.authorityValidated = true;
  assert.throws(
    () => parseMvpFirstDaySettlementEvidenceSelfConsistency(unknown),
    /must contain exactly/,
  );
});

test('rejects noncanonical equipment term ordering in evidence self-consistency checks', () => {
  const evidence = mutableClone(composeMvpFirstDaySettlementEvidence(lockedRecords()));
  evidence.authorityReferences.equipmentTermsVersions = ['z-terms', 'a-terms'];
  assert.throws(
    () => parseMvpFirstDaySettlementEvidenceSelfConsistency(evidence),
    /must be canonically sorted/,
  );
});
