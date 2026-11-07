import { createHash } from 'node:crypto';

import { CommandError, type CanonicalCommandValue } from '../commands/command-contract.js';
import type { CommandHandler } from '../commands/command-dispatcher.js';
import { deriveFloorFlowServiceProfile } from '../domains/demand-flow/demand-flow.js';
import { MVP_FIRST_DAY_CATALOG_VERSIONS, resolveMvpFirstDayCatalog } from '../domains/inventory-procurement/mvp-first-day-catalog.js';
import type { InventoryState } from '../domains/inventory-procurement/inventory.js';
import type { RecipeServiceSnapshot } from '../domains/service-quality/service-quality.js';
import {
  advanceServicePeriod,
  parseAdvanceServicePeriodIntent,
  replayAdvanceServicePeriod,
  type AdvanceServicePeriodResultSnapshot,
} from './advance-service-period.js';
import { validateCanonicalOpenAuthority } from './open-business-day-command.js';
import { PrismaAdvanceServicePeriodRepository, type FirstDayAdvanceAuthority } from './prisma-advance-service-period-repository.js';

export const ADVANCE_SERVICE_PERIOD = 'ADVANCE_SERVICE_PERIOD' as const;
export const SERVICE_PERIOD_COMPLETED_EVENT_TYPE = 'gameplay.service-period.completed' as const;
export const SERVICE_PERIOD_COMPLETED_EVENT_VERSION = 1 as const;

const periodsByPlan = Object.freeze({
  TWO_PERIODS: Object.freeze(['LUNCH', 'DINNER'] as const),
  THREE_PERIODS: Object.freeze(['LUNCH', 'OFF_PEAK', 'DINNER'] as const),
});

export function createAdvanceServicePeriodCommandHandler(): CommandHandler {
  return Object.freeze({
    commandType: ADVANCE_SERVICE_PERIOD,
    async execute({ context, command, currentVersion, persistence }) {
      if (command.commandType !== ADVANCE_SERVICE_PERIOD || command.aggregateId !== context.saveId) {
        throw new CommandError(422, 'ADVANCE_COMMAND_SCOPE_INVALID');
      }
      let intent;
      try {
        intent = parseAdvanceServicePeriodIntent(command.payload);
      } catch {
        throw new CommandError(422, 'ADVANCE_SERVICE_PERIOD_INTENT_INVALID');
      }

      const repository = new PrismaAdvanceServicePeriodRepository(persistence);
      const authority = await repository.loadFirstDayAdvanceAuthority({
        restaurantId: context.tenantId,
        saveId: context.saveId,
        membershipId: context.membershipId,
        actorId: context.actorId,
      });

      let built;
      try {
        built = buildEngineAuthority(authority, intent.expectedPeriodKey, context.actorId);
      } catch (error) {
        if (error instanceof CommandError) throw error;
        throw new CommandError(503, 'ADVANCE_AUTHORITY_INVALID');
      }
      let execution;
      try {
        execution = advanceServicePeriod(intent, built.engineAuthority);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/stale|canonical order|already complete/.test(message)) {
          throw new CommandError(409, 'SERVICE_PERIOD_ORDER_CONFLICT');
        }
        throw new CommandError(503, 'SERVICE_PERIOD_EXECUTION_FAILED');
      }
      const finalPeriod = execution.resultSnapshot.ordinal === built.periods.length;
      const executionId = privateId(
        'service-period-execution',
        context.saveId,
        String(execution.inputSnapshot.ordinal),
        command.commandId,
      );

      await repository.persistExecution({
        restaurantId: context.tenantId,
        saveId: context.saveId,
        businessDayId: authority.openAuthority.businessDay.id,
        commandId: command.commandId,
        executionId,
        simulationRuleVersion: authority.openAuthority.save.simulationRuleVersion,
        finalPeriod,
        openingInventory: built.openingInventory,
        previousInventory: built.previousResult?.inventoryState,
        ingredientCatalog: built.catalog.ingredientCatalog,
        inputSnapshot: execution.inputSnapshot,
        resultSnapshot: execution.resultSnapshot,
      });

      const aggregateVersion = currentVersion + 1;
      const status = finalPeriod ? 'SERVICE_COMPLETE' : 'OPEN';
      const safeSummary = Object.freeze({
        ordersServed: execution.resultSnapshot.orders.filter((order) => order.state === 'SERVED').length,
        groupsDeparted: execution.resultSnapshot.departedGroupIds.length,
        reputation: Object.freeze({ ...execution.resultSnapshot.reputation }),
        flowRiskHigh: execution.resultSnapshot.flowRiskHigh,
      });
      return Object.freeze({
        aggregateVersion,
        result: canonicalValue({
          competitiveSave: { id: context.saveId, version: aggregateVersion },
          businessDay: {
            id: authority.openAuthority.businessDay.id,
            businessDay: 1,
            status,
            simulationRuleVersion: authority.openAuthority.save.simulationRuleVersion,
          },
          servicePeriodExecution: {
            id: executionId,
            ordinal: execution.inputSnapshot.ordinal,
            periodKey: execution.inputSnapshot.periodKey,
            inputHash: execution.inputSnapshot.inputHash,
            resultHash: execution.resultSnapshot.resultHash,
            finalPeriod,
            summary: safeSummary,
          },
        }),
        effects: Object.freeze({
          outbox: Object.freeze([
            Object.freeze({
              kind: 'outbox.event/v1' as const,
              eventId: command.commandId,
              eventSequence: 0,
              eventType: SERVICE_PERIOD_COMPLETED_EVENT_TYPE,
              eventVersion: SERVICE_PERIOD_COMPLETED_EVENT_VERSION,
              payload: Object.freeze({
                schemaVersion: 'gameplay.service-period.completed/v1',
                businessDay: 1,
                businessDayId: authority.openAuthority.businessDay.id,
                servicePeriodExecutionId: executionId,
                ordinal: execution.inputSnapshot.ordinal,
                periodKey: execution.inputSnapshot.periodKey,
                inputHash: execution.inputSnapshot.inputHash,
                resultHash: execution.resultSnapshot.resultHash,
                simulationRuleVersion: authority.openAuthority.save.simulationRuleVersion,
                finalPeriod,
                status,
                summary: safeSummary,
              }),
            }),
          ]),
        }),
      });
    },
  });
}

function buildEngineAuthority(
  authority: FirstDayAdvanceAuthority,
  expectedPeriodKey: 'LUNCH' | 'OFF_PEAK' | 'DINNER',
  actorId: string,
) {
  const validated = validateCanonicalOpenAuthority(authority.openAuthority);
  const envelope = validated.privateEnvelope;
  if (envelope.inventoryProcurement.market.marketSeed !== authority.marketSeed) {
    throw new Error('pre-open market seed does not match locked E03 authority');
  }
  const catalog = resolveMvpFirstDayCatalog(MVP_FIRST_DAY_CATALOG_VERSIONS, {
    code: authority.openAuthority.save.openingSnapshot.settlementCurrency.code,
    metadataVersion: authority.openAuthority.save.openingSnapshot.currencyMetadataVersion,
  });
  const menuIds = envelope.menu.items.map((item) => item.recipeVersionId);
  const recipeVersions = catalog.recipeCatalog.filter((recipe) => menuIds.includes(recipe.id));
  if (recipeVersions.length !== menuIds.length) throw new Error('menu recipes are not canonical');
  const enabledSubstitutionIds = new Set(
    envelope.menu.items.flatMap((item) => item.enabledSubstitutionIds),
  );
  const enabledSubstitutions = catalog.substitutionCatalog.filter((substitution) =>
    enabledSubstitutionIds.has(substitution.id),
  );
  if (enabledSubstitutions.length !== enabledSubstitutionIds.size) {
    throw new Error('enabled substitutions are not canonical');
  }
  const recipes = recipeVersions.map((recipe) => {
    const menuItem = envelope.menu.items.find((item) => item.recipeVersionId === recipe.id)!;
    return Object.freeze({
      id: recipe.id,
      baseQuality: recipe.baseQuality,
      substitutionQualityDelta: 0,
      recommendedPrice: safeMoney(menuItem.basePrice.minorUnits, 'recommended price'),
      salePrice: safeMoney(menuItem.salePrice.minorUnits, 'sale price'),
      portions: 0,
    } satisfies RecipeServiceSnapshot);
  });
  const openingStocks = Object.freeze(envelope.inventoryProcurement.openingStocks.map((stock) => Object.freeze({ ...stock, costPool: Object.freeze({ ...stock.costPool }) })));
  const openingInventory: InventoryState = Object.freeze({
    currency: authority.openAuthority.save.openingSnapshot.settlementCurrency.code,
    capacity: Object.freeze({ ...envelope.inventoryProcurement.capacity }),
    stocks: openingStocks,
    orderReservations: Object.freeze([]),
    reservedUndelivered: Object.freeze(envelope.inventoryProcurement.reservedUndelivered.map((entry) => Object.freeze({ ...entry }))),
    transactions: Object.freeze(openingStocks.map((stock, index) => Object.freeze({
      sequence: index + 1,
      transactionId: privateId('opening-stock-receipt', envelope.preopenSnapshotHash, stock.ingredientId),
      type: 'RECEIPT' as const,
      ingredientId: stock.ingredientId,
      quantityPoints: stock.onHandPoints,
      amount: stock.costPool,
      referenceId: envelope.preopenSnapshotId,
    }))),
  });
  const previousResult = validateExecutionChain(authority);
  assertPersistedInventory(authority, previousResult);
  const periods = periodsByPlan[authority.openAuthority.save.servicePeriodPlan];
  const nextPeriod = periods[authority.executions.length];
  if (nextPeriod === undefined) throw new CommandError(409, 'ALL_SERVICE_PERIODS_COMPLETE');
  if (expectedPeriodKey !== nextPeriod) throw new CommandError(409, 'SERVICE_PERIOD_ORDER_CONFLICT');

  const groups = envelope.demandSchedule.groups.filter((group) => group.period === nextPeriod);
  const activeGuests = groups.reduce((sum, group) => sum + group.size, 0);
  const floorFlowServiceProfile = deriveFloorFlowServiceProfile(envelope.layout, {
    seatedGuests: 0,
    waitingGroups: 0,
    activeGuests,
    demandGroups: Math.max(1, groups.length),
  });
  const equipmentBundle = authority.openAuthority.save.openingSnapshot.equipmentBundles[0];
  if (!equipmentBundle || authority.openAuthority.save.openingSnapshot.equipmentBundles.length !== 1) {
    throw new Error('OPEN day requires exactly one canonical equipment bundle');
  }
  return Object.freeze({
    catalog,
    periods,
    openingInventory,
    previousResult,
    engineAuthority: Object.freeze({
      businessDay: 1 as const,
      servicePeriodPlan: authority.openAuthority.save.servicePeriodPlan,
      initiator: Object.freeze({ actorId, role: authority.initiatorRole }),
      npcContracts: authority.openAuthority.save.openingSnapshot.npcContracts,
      demandSchedule: envelope.demandSchedule,
      recipes: Object.freeze(recipes),
      inventoryState: previousResult?.inventoryState ?? openingInventory,
      recipeVersions: Object.freeze(recipeVersions),
      enabledSubstitutions: Object.freeze(enabledSubstitutions),
      equipment: Object.freeze({ kitchen: equipmentBundle.condition, front: equipmentBundle.condition }),
      kitchenExecutionQualityModifier: 0,
      floorFlowServiceProfile,
      openingReputation: previousResult ? undefined : authority.openAuthority.save.openingSnapshot.reputation,
      previousResult,
    }),
  });
}

function validateExecutionChain(authority: FirstDayAdvanceAuthority): AdvanceServicePeriodResultSnapshot | undefined {
  const periods = periodsByPlan[authority.openAuthority.save.servicePeriodPlan];
  let previous: AdvanceServicePeriodResultSnapshot | undefined;
  for (const [index, execution] of authority.executions.entries()) {
    const replayed = replayAdvanceServicePeriod(execution.inputSnapshot);
    if (execution.ordinal !== index + 1 || execution.periodKey !== periods[index] ||
        execution.simulationRuleVersion !== authority.openAuthority.save.simulationRuleVersion ||
        execution.inputHash !== execution.inputSnapshot.inputHash || execution.resultHash !== execution.resultSnapshot.resultHash ||
        !canonicalEqual(replayed, execution.resultSnapshot) ||
        execution.inputSnapshot.previousResultHash !== (previous?.resultHash ?? null)) {
      throw new Error('persisted service-period execution chain is not canonical');
    }
    previous = execution.resultSnapshot;
  }
  return previous;
}

function assertPersistedInventory(
  authority: FirstDayAdvanceAuthority,
  previous: AdvanceServicePeriodResultSnapshot | undefined,
): void {
  if (!previous) {
    if (authority.inventoryStocks.length !== 0 || authority.inventoryAudits.length !== 0) {
      throw new Error('first service period requires an unmaterialized opening inventory baseline');
    }
    return;
  }
  const serviceTransactions = previous.inventoryState.transactions.filter(
    (transaction) => transaction.type !== 'RECEIPT',
  );
  if (authority.inventoryStocks.length !== previous.inventoryState.stocks.length ||
      authority.inventoryAudits.length !== serviceTransactions.length) {
    throw new Error('persisted E03 inventory projection is incomplete');
  }
  for (const stock of previous.inventoryState.stocks) {
    const actual = authority.inventoryStocks.find((row) => row.ingredientId === stock.ingredientId);
    const reserved = previous.inventoryState.reservedUndelivered
      .filter((entry) => entry.ingredientId === stock.ingredientId)
      .reduce((sum, entry) => sum + entry.quantityPoints, 0);
    if (!actual || actual.pool !== stock.pool || actual.onHandPoints !== stock.onHandPoints ||
        actual.reservedUndeliveredPoints !== reserved || actual.costPoolMinor !== stock.costPool.minorUnits ||
        stock.reservedPoints !== 0) {
      throw new Error('persisted E03 inventory stock is stale');
    }
  }
  for (const transaction of serviceTransactions) {
    const audit = authority.inventoryAudits.find(
      (row) => row.metadata.domainSequence === transaction.sequence,
    );
    if (!audit || audit.ingredientId !== transaction.ingredientId ||
        audit.metadata.schemaVersion !== 'gameplay.service-inventory-audit/v1' ||
        audit.metadata.domainTransactionId !== transaction.transactionId ||
        audit.metadata.domainType !== transaction.type ||
        audit.metadata.quantityPoints !== transaction.quantityPoints) {
      throw new Error('persisted E03 inventory audit is stale');
    }
  }
}

function safeMoney(value: string, name: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${name} must be non-negative minor units`);
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new Error(`${name} exceeds safe simulation range`);
  return amount;
}
function privateId(kind: string, ...parts: readonly string[]): string {
  return `${kind}:${createHash('sha256').update(parts.join('\u0000')).digest('hex')}`;
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}
function canonicalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}
function canonicalValue(value: unknown): CanonicalCommandValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(canonicalValue));
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([, nested]) => nested === undefined)) throw new CommandError(503, 'ADVANCE_PUBLIC_PROJECTION_INVALID');
    return Object.freeze(Object.fromEntries(entries.map(([key, nested]) => [key, canonicalValue(nested)])));
  }
  throw new CommandError(503, 'ADVANCE_PUBLIC_PROJECTION_INVALID');
}
