import { createHash } from 'node:crypto';

import { CommandError } from '../commands/command-contract.js';
import type { DurableCommandPersistence } from '../commands/command-dispatcher.js';
import type { InventoryState } from '../domains/inventory-procurement/inventory.js';
import type { IngredientCatalogItem } from '../domains/inventory-procurement/catalog-menu.js';
import type {
  AdvanceServicePeriodInputSnapshot,
  AdvanceServicePeriodResultSnapshot,
} from './advance-service-period.js';
import type {
  FirstDayOpenAuthority,
  OpenInventoryPoolAuthority,
} from './prisma-open-business-day-repository.js';

type ScopeRow = Readonly<Record<string, unknown>>;
type PoolRow = Readonly<Record<string, unknown>>;
type ExecutionRow = Readonly<Record<string, unknown>>;
type StockRow = Readonly<Record<string, unknown>>;
type TransactionRow = Readonly<Record<string, unknown>>;

export type PersistedAdvanceExecution = Readonly<{
  id: string;
  ordinal: number;
  periodKey: 'LUNCH' | 'OFF_PEAK' | 'DINNER';
  commandId: string;
  simulationRuleVersion: string;
  inputSnapshot: AdvanceServicePeriodInputSnapshot;
  inputHash: string;
  resultSnapshot: AdvanceServicePeriodResultSnapshot;
  resultHash: string;
}>;

export type PersistedInventoryStock = Readonly<{
  id: string;
  inventoryItemId: string;
  ingredientId: string;
  pool: 'DURABLE' | 'PERISHABLE';
  version: number;
  onHandPoints: number;
  reservedUndeliveredPoints: number;
  costPoolMinor: string;
}>;

export type PersistedInventoryAudit = Readonly<{
  commandId: string;
  commandSequence: number;
  ingredientId: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type FirstDayAdvanceAuthority = Readonly<{
  openAuthority: FirstDayOpenAuthority;
  initiatorRole: 'OWNER' | 'MANAGER';
  marketSeed: string;
  executions: readonly PersistedAdvanceExecution[];
  inventoryStocks: readonly PersistedInventoryStock[];
  inventoryAudits: readonly PersistedInventoryAudit[];
}>;

export type AdvanceServicePeriodScope = Readonly<{
  restaurantId: string;
  saveId: string;
  membershipId: string;
  actorId: string;
}>;

export type PersistAdvanceServicePeriodInput = Readonly<{
  restaurantId: string;
  saveId: string;
  businessDayId: string;
  commandId: string;
  executionId: string;
  simulationRuleVersion: string;
  finalPeriod: boolean;
  openingInventory: InventoryState;
  previousInventory: InventoryState | undefined;
  ingredientCatalog: readonly IngredientCatalogItem[];
  inputSnapshot: AdvanceServicePeriodInputSnapshot;
  resultSnapshot: AdvanceServicePeriodResultSnapshot;
}>;

/** Transaction-bound ADVANCE adapter; D03 owns the serializable transaction and save lock. */
export class PrismaAdvanceServicePeriodRepository {
  constructor(private readonly persistence: DurableCommandPersistence) {}

  async loadFirstDayAdvanceAuthority(
    scope: AdvanceServicePeriodScope,
  ): Promise<FirstDayAdvanceAuthority> {
    const rows = await this.persistence.mutate<readonly ScopeRow[]>(
      `/* advance-service-period:scope */
       SELECT save."id" AS "saveId", save."openingScenario", save."operatingMode",
              save."servicePeriodPlan" AS "saveServicePeriodPlan", save."demandSeed",
              save."simulationRuleVersion" AS "saveSimulationRuleVersion",
              save."openingSnapshot", save."openingSnapshotHash",
              membership."role"::text AS "membershipRole",
              day."id" AS "businessDayId", day."status"::text AS "businessDayStatus",
              day."servicePeriodPlan" AS "businessDayServicePeriodPlan",
              day."simulationRuleVersion" AS "businessDaySimulationRuleVersion",
              day."consumedPreopenSnapshotId", day."openSnapshotHash",
              (day."openSnapshot" = snapshot."payload") AS "openSnapshotMatches",
              snapshot."id" AS "preopenSnapshotId", snapshot."revision" AS "preopenRevision",
              snapshot."commandId" AS "preopenCommandId",
              snapshot."snapshotSchemaVersion" AS "preopenSnapshotSchemaVersion",
              snapshot."simulationRuleVersion" AS "preopenSimulationRuleVersion",
              snapshot."payload" AS "preopenPayload", snapshot."snapshotHash" AS "preopenSnapshotHash",
              market."seed" AS "marketSeed"
       FROM "CompetitiveSave" save
       JOIN "RestaurantMembership" membership
         ON membership."id" = $3 AND membership."playerId" = $4
        AND membership."restaurantId" = save."restaurantId"
        AND membership."revokedAt" IS NULL AND membership."role" IN ('OWNER','MANAGER')
       JOIN "BusinessDay" day
         ON day."restaurantId" = save."restaurantId" AND day."saveId" = save."id"
        AND day."businessDay" = 1
       JOIN "PreopenDaySnapshot" snapshot
         ON snapshot."restaurantId" = day."restaurantId" AND snapshot."saveId" = day."saveId"
        AND snapshot."businessDay" = day."businessDay" AND snapshot."revision" = 1
       JOIN "MarketSeedAuthority" market
         ON market."restaurantId" = save."restaurantId" AND market."saveId" = save."id"
       WHERE save."id" = $1 AND save."restaurantId" = $2 AND save."retiredAt" IS NULL
       FOR UPDATE OF day
       FOR SHARE OF save, membership, snapshot, market`,
      scope.saveId,
      scope.restaurantId,
      scope.membershipId,
      scope.actorId,
    );
    if (rows.length !== 1) throw new CommandError(403, 'ADVANCE_SCOPE_FORBIDDEN');
    const row = rows[0]!;
    if (row.businessDayStatus !== 'OPEN') {
      throw new CommandError(409, 'BUSINESS_DAY_NOT_OPEN');
    }

    const poolRows = await this.persistence.mutate<readonly PoolRow[]>(
      `/* advance-service-period:inventory-pools */
       SELECT pool."saveId", pool."pool"::text AS "pool", pool."revision",
              pool."capacityPoints", pool."storageBundleVersion", pool."storageBundleKind"
       FROM "InventoryPoolState" pool
       WHERE pool."restaurantId" = $1 AND pool."saveId" = $2
       ORDER BY pool."pool" FOR UPDATE OF pool`,
      scope.restaurantId,
      scope.saveId,
    );
    const executionRows = await this.persistence.mutate<readonly ExecutionRow[]>(
      `/* advance-service-period:executions */
       SELECT execution."id", execution."ordinal", execution."periodKey", execution."commandId",
              execution."simulationRuleVersion", execution."inputSnapshot", execution."inputHash",
              execution."resultSnapshot", execution."resultHash"
       FROM "ServicePeriodExecution" execution
       WHERE execution."restaurantId" = $1 AND execution."saveId" = $2
         AND execution."businessDay" = 1
       ORDER BY execution."ordinal" FOR SHARE OF execution`,
      scope.restaurantId,
      scope.saveId,
    );
    const stockRows = await this.persistence.mutate<readonly StockRow[]>(
      `/* advance-service-period:inventory-stocks */
       SELECT stock."id", stock."inventoryItemId", item."stableKey" AS "ingredientId",
              CASE WHEN item."perishable" THEN 'PERISHABLE' ELSE 'DURABLE' END AS "pool",
              stock."version", stock."onHand", stock."reservedUndelivered", stock."costPoolMinor"
       FROM "InventoryStock" stock
       JOIN "InventoryItem" item
         ON item."restaurantId" = stock."restaurantId" AND item."id" = stock."inventoryItemId"
       WHERE stock."restaurantId" = $1 AND stock."saveId" = $2
       ORDER BY item."stableKey" FOR UPDATE OF stock FOR SHARE OF item`,
      scope.restaurantId,
      scope.saveId,
    );
    const auditRows = await this.persistence.mutate<readonly TransactionRow[]>(
      `/* advance-service-period:inventory-audits */
       SELECT transaction."commandId", transaction."commandSequence",
              item."stableKey" AS "ingredientId", transaction."metadata"
       FROM "InventoryTransaction" transaction
       JOIN "InventoryStock" stock
         ON stock."restaurantId" = transaction."restaurantId"
        AND stock."saveId" = transaction."saveId" AND stock."id" = transaction."stockId"
       JOIN "InventoryItem" item
         ON item."restaurantId" = stock."restaurantId" AND item."id" = stock."inventoryItemId"
       WHERE transaction."restaurantId" = $1 AND transaction."saveId" = $2
       ORDER BY transaction."occurredAt", transaction."commandId", transaction."commandSequence"
       FOR SHARE OF transaction`,
      scope.restaurantId,
      scope.saveId,
    );

    try {
      if (
        row.openSnapshotMatches !== true ||
        row.consumedPreopenSnapshotId !== row.preopenSnapshotId ||
        row.openSnapshotHash !== row.preopenSnapshotHash
      ) {
        throw new Error('OPEN evidence no longer matches its immutable pre-open snapshot');
      }
      const saveId = stringValue(row.saveId, 'save id');
      const rule = stringValue(row.saveSimulationRuleVersion, 'save rule');
      const plan = periodPlan(row.saveServicePeriodPlan);
      if (
        row.businessDayServicePeriodPlan !== plan ||
        row.businessDaySimulationRuleVersion !== rule ||
        row.preopenSimulationRuleVersion !== rule
      ) {
        throw new Error('save, BusinessDay, and pre-open rule authority differ');
      }
      if (poolRows.length !== 2) throw new Error('ADVANCE requires exactly two inventory pools');
      const pools = Object.freeze(poolRows.map(parsePool));
      if (
        new Set(pools.map((pool) => pool.pool)).size !== 2 ||
        pools.some((pool) => pool.saveId !== saveId)
      ) {
        throw new Error('inventory pools are duplicated or cross-save');
      }
      return Object.freeze({
        openAuthority: Object.freeze({
          save: Object.freeze({
            id: saveId,
            scenario: scenario(row.openingScenario),
            operatingMode: operatingMode(row.operatingMode),
            servicePeriodPlan: plan,
            demandSeed: stringValue(row.demandSeed, 'demand seed'),
            simulationRuleVersion: rule,
            openingSnapshot: jsonObject(
              row.openingSnapshot,
              'opening snapshot',
            ) as FirstDayOpenAuthority['save']['openingSnapshot'],
            openingSnapshotHash: hash(row.openingSnapshotHash, 'opening snapshot hash'),
          }),
          businessDay: Object.freeze({
            id: stringValue(row.businessDayId, 'business day id'),
            status: 'OPEN',
            servicePeriodPlan: plan,
            simulationRuleVersion: rule,
          }),
          preopenSnapshot: Object.freeze({
            id: stringValue(row.preopenSnapshotId, 'pre-open snapshot id'),
            revision: one(row.preopenRevision),
            commandId: stringValue(row.preopenCommandId, 'pre-open command id'),
            snapshotSchemaVersion: stringValue(row.preopenSnapshotSchemaVersion, 'pre-open schema'),
            simulationRuleVersion: rule,
            payload: jsonObject(row.preopenPayload, 'pre-open payload'),
            snapshotHash: hash(row.preopenSnapshotHash, 'pre-open snapshot hash'),
          }),
          inventoryPoolAuthorities: pools,
        }),
        initiatorRole: membershipRole(row.membershipRole),
        marketSeed: stringValue(row.marketSeed, 'market seed'),
        executions: Object.freeze(executionRows.map(parseExecution)),
        inventoryStocks: Object.freeze(stockRows.map(parseStock)),
        inventoryAudits: Object.freeze(auditRows.map(parseAudit)),
      });
    } catch (error) {
      if (error instanceof CommandError) throw error;
      throw new CommandError(503, 'ADVANCE_AUTHORITY_INVALID');
    }
  }

  async persistExecution(input: PersistAdvanceServicePeriodInput): Promise<void> {
    await this.assertOrCreateInventoryBaseline(input);
    await this.applyInventoryTransactions(input);
    const inserted = await this.persistence.mutate<readonly Readonly<Record<string, unknown>>[]>(
      `/* advance-service-period:insert-execution */
       INSERT INTO "ServicePeriodExecution" (
         "id","restaurantId","saveId","businessDay","ordinal","periodKey","commandId",
         "simulationRuleVersion","inputSnapshot","inputHash","resultSnapshot","resultHash","completedAt"
       ) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,CURRENT_TIMESTAMP)
       ON CONFLICT DO NOTHING
       RETURNING "id","ordinal","periodKey","inputHash","resultHash"`,
      input.executionId,
      input.restaurantId,
      input.saveId,
      input.inputSnapshot.ordinal,
      input.inputSnapshot.periodKey,
      input.commandId,
      input.simulationRuleVersion,
      JSON.stringify(input.inputSnapshot),
      input.inputSnapshot.inputHash,
      JSON.stringify(input.resultSnapshot),
      input.resultSnapshot.resultHash,
    );
    const row = inserted[0];
    if (
      inserted.length !== 1 ||
      row?.id !== input.executionId ||
      databaseInteger(row.ordinal, 'inserted ordinal') !== input.inputSnapshot.ordinal ||
      row.periodKey !== input.inputSnapshot.periodKey ||
      row.inputHash !== input.inputSnapshot.inputHash ||
      row.resultHash !== input.resultSnapshot.resultHash
    ) {
      throw new CommandError(409, 'SERVICE_PERIOD_ALREADY_COMPLETED');
    }
    if (input.finalPeriod) {
      const transitioned = await this.persistence.mutate<
        readonly Readonly<Record<string, unknown>>[]
      >(
        `/* advance-service-period:complete-day */
         UPDATE "BusinessDay" SET "status" = 'SERVICE_COMPLETE'
         WHERE "restaurantId" = $1 AND "saveId" = $2 AND "id" = $3
           AND "businessDay" = 1 AND "status" = 'OPEN' AND "simulationRuleVersion" = $4
         RETURNING "id","status"::text AS "status"`,
        input.restaurantId,
        input.saveId,
        input.businessDayId,
        input.simulationRuleVersion,
      );
      if (
        transitioned.length !== 1 ||
        transitioned[0]?.id !== input.businessDayId ||
        transitioned[0]?.status !== 'SERVICE_COMPLETE'
      ) {
        throw new CommandError(409, 'BUSINESS_DAY_NOT_OPEN');
      }
    }
  }

  private async assertOrCreateInventoryBaseline(
    input: PersistAdvanceServicePeriodInput,
  ): Promise<void> {
    const baseline = input.previousInventory ?? input.openingInventory;
    const catalogById = new Map(input.ingredientCatalog.map((item) => [item.id, item]));
    for (const stock of baseline.stocks) {
      const item = catalogById.get(stock.ingredientId);
      if (!item || item.pool !== stock.pool)
        throw new CommandError(503, 'ADVANCE_INVENTORY_AUTHORITY_INVALID');
      const itemId = privateId('inventory-item', input.restaurantId, item.id);
      await this.persistence.mutate(
        `/* advance-service-period:ensure-item */
         INSERT INTO "InventoryItem" ("id","restaurantId","stableKey","category","unit","perishable")
         VALUES ($1,$2,$3,$4,'POINT',$5) ON CONFLICT DO NOTHING`,
        itemId,
        input.restaurantId,
        item.id,
        item.kind,
        item.pool === 'PERISHABLE',
      );
      const itemRows = await this.persistence.mutate<readonly Readonly<Record<string, unknown>>[]>(
        `/* advance-service-period:validate-item */
         SELECT "id","stableKey","category","unit","perishable" FROM "InventoryItem"
         WHERE "restaurantId" = $1 AND "stableKey" = $2 FOR KEY SHARE`,
        input.restaurantId,
        item.id,
      );
      if (
        itemRows.length !== 1 ||
        itemRows[0]?.id !== itemId ||
        itemRows[0]?.stableKey !== item.id ||
        itemRows[0]?.category !== item.kind ||
        itemRows[0]?.unit !== 'POINT' ||
        itemRows[0]?.perishable !== (item.pool === 'PERISHABLE')
      ) {
        throw new CommandError(503, 'ADVANCE_INVENTORY_ITEM_CONFLICT');
      }
      const stockId = privateId('inventory-stock', input.saveId, item.id);
      const reserved = baseline.reservedUndelivered
        .filter((entry) => entry.ingredientId === item.id)
        .reduce((sum, entry) => sum + entry.quantityPoints, 0);
      await this.persistence.mutate(
        `/* advance-service-period:ensure-stock */
         INSERT INTO "InventoryStock" (
           "id","restaurantId","saveId","inventoryItemId","version","onHand","reservedUndelivered","costPoolMinor"
         ) VALUES ($1,$2,$3,$4,1,$5,$6,$7) ON CONFLICT DO NOTHING`,
        stockId,
        input.restaurantId,
        input.saveId,
        itemId,
        stock.onHandPoints,
        reserved,
        stock.costPool.minorUnits,
      );
      const stockRows = await this.persistence.mutate<readonly Readonly<Record<string, unknown>>[]>(
        `/* advance-service-period:validate-stock */
         SELECT "id","inventoryItemId","onHand","reservedUndelivered","costPoolMinor"
         FROM "InventoryStock" WHERE "restaurantId" = $1 AND "saveId" = $2 AND "id" = $3
         FOR UPDATE`,
        input.restaurantId,
        input.saveId,
        stockId,
      );
      const actual = stockRows[0];
      if (
        stockRows.length !== 1 ||
        actual?.inventoryItemId !== itemId ||
        databaseInteger(actual.onHand, 'stock on hand') !== stock.onHandPoints ||
        databaseInteger(actual.reservedUndelivered, 'stock reserved undelivered') !== reserved ||
        databaseBigintString(actual.costPoolMinor, 'stock cost pool') !== stock.costPool.minorUnits
      ) {
        throw new CommandError(409, 'ADVANCE_INVENTORY_STALE');
      }
    }
  }

  private async applyInventoryTransactions(input: PersistAdvanceServicePeriodInput): Promise<void> {
    const priorCount =
      input.previousInventory?.transactions.length ?? input.openingInventory.transactions.length;
    const delta = input.resultSnapshot.inventoryState.transactions.slice(priorCount);
    for (const [commandSequence, transaction] of delta.entries()) {
      if (transaction.type !== 'ORDER_RESERVED' && transaction.type !== 'ORDER_COMPLETED') {
        throw new CommandError(503, 'ADVANCE_INVENTORY_TRANSACTION_INVALID');
      }
      const finalStock = input.resultSnapshot.inventoryState.stocks.find(
        (stock) => stock.ingredientId === transaction.ingredientId,
      );
      if (!finalStock) throw new CommandError(503, 'ADVANCE_INVENTORY_TRANSACTION_INVALID');
      const stockId = privateId('inventory-stock', input.saveId, transaction.ingredientId);
      const completed = transaction.type === 'ORDER_COMPLETED';
      const rows = await this.persistence.mutate<readonly Readonly<Record<string, unknown>>[]>(
        `/* advance-service-period:mutate-stock */
         UPDATE "InventoryStock"
         SET "version" = "version" + 1,
             "onHand" = "onHand" + $4,
             "costPoolMinor" = "costPoolMinor" - $5
         WHERE "restaurantId" = $1 AND "saveId" = $2 AND "id" = $3
           AND "onHand" + $4 >= 0 AND "costPoolMinor" - $5 >= 0
         RETURNING "version","onHand","reservedUndelivered","costPoolMinor"`,
        input.restaurantId,
        input.saveId,
        stockId,
        completed ? -transaction.quantityPoints : 0,
        completed ? transaction.amount.minorUnits : '0',
      );
      if (rows.length !== 1) throw new CommandError(409, 'ADVANCE_INVENTORY_STALE');
      const row = rows[0]!;
      const transactionId = privateId(
        'inventory-transaction',
        input.commandId,
        String(commandSequence),
        transaction.transactionId,
        transaction.ingredientId,
      );
      const auditId = privateId('inventory-audit', input.commandId, String(commandSequence));
      const inserted = await this.persistence.mutate<readonly Readonly<Record<string, unknown>>[]>(
        `/* advance-service-period:insert-inventory-audit */
         INSERT INTO "InventoryTransaction" (
           "id","restaurantId","saveId","stockId","transactionId","commandId","commandSequence",
           "ledgerTransactionId","stockVersion","kind","quantityDelta","onHandAfter","reservedAfter",
           "amountMinor","costPoolMinorAfter","referenceId","reason","metadata"
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
         ON CONFLICT DO NOTHING RETURNING "id","transactionId"`,
        auditId,
        input.restaurantId,
        input.saveId,
        stockId,
        transactionId,
        input.commandId,
        commandSequence,
        row.version,
        completed ? 'CONSUMPTION' : 'RESERVATION',
        completed ? -transaction.quantityPoints : 0,
        row.onHand,
        row.reservedUndelivered,
        completed ? transaction.amount.minorUnits : '0',
        row.costPoolMinor,
        transaction.referenceId,
        transaction.type,
        JSON.stringify({
          schemaVersion: 'gameplay.service-inventory-audit/v1',
          domainSequence: transaction.sequence,
          domainTransactionId: transaction.transactionId,
          domainType: transaction.type,
          ingredientId: transaction.ingredientId,
          quantityPoints: transaction.quantityPoints,
        }),
      );
      if (
        inserted.length !== 1 ||
        inserted[0]?.id !== auditId ||
        inserted[0]?.transactionId !== transactionId
      ) {
        throw new CommandError(409, 'ADVANCE_INVENTORY_TRANSACTION_CONFLICT');
      }
    }
    for (const expected of input.resultSnapshot.inventoryState.stocks) {
      const stockId = privateId('inventory-stock', input.saveId, expected.ingredientId);
      const rows = await this.persistence.mutate<readonly Readonly<Record<string, unknown>>[]>(
        `/* advance-service-period:verify-final-stock */
         SELECT "onHand","reservedUndelivered","costPoolMinor" FROM "InventoryStock"
         WHERE "restaurantId" = $1 AND "saveId" = $2 AND "id" = $3 FOR UPDATE`,
        input.restaurantId,
        input.saveId,
        stockId,
      );
      const row = rows[0];
      const reserved = input.resultSnapshot.inventoryState.reservedUndelivered
        .filter((entry) => entry.ingredientId === expected.ingredientId)
        .reduce((sum, entry) => sum + entry.quantityPoints, 0);
      if (
        rows.length !== 1 ||
        databaseInteger(row?.onHand, 'final stock') !== expected.onHandPoints ||
        databaseInteger(row?.reservedUndelivered, 'final reserved') !== reserved ||
        databaseBigintString(row?.costPoolMinor, 'final cost') !== expected.costPool.minorUnits ||
        expected.reservedPoints !== 0
      ) {
        throw new CommandError(503, 'ADVANCE_FINAL_INVENTORY_MISMATCH');
      }
    }
  }
}

function parsePool(row: PoolRow): OpenInventoryPoolAuthority {
  const pool = row.pool;
  const kind = row.storageBundleKind;
  if (pool !== 'DURABLE' && pool !== 'PERISHABLE') throw new Error('unknown inventory pool');
  if (kind !== 'NONE' && kind !== 'BASIC' && kind !== 'AGED' && kind !== 'VERSIONED_UPGRADE') {
    throw new Error('unknown storage bundle kind');
  }
  return Object.freeze({
    saveId: stringValue(row.saveId, 'pool save id'),
    pool,
    revision: positive(row.revision, 'pool revision'),
    capacityPoints: databaseInteger(row.capacityPoints, 'pool capacity'),
    storageBundleVersion: stringValue(row.storageBundleVersion, 'bundle version'),
    storageBundleKind: kind,
  });
}

function parseExecution(row: ExecutionRow): PersistedAdvanceExecution {
  return Object.freeze({
    id: stringValue(row.id, 'execution id'),
    ordinal: positive(row.ordinal, 'execution ordinal'),
    periodKey: periodKey(row.periodKey),
    commandId: stringValue(row.commandId, 'execution command id'),
    simulationRuleVersion: stringValue(row.simulationRuleVersion, 'execution rule'),
    inputSnapshot: jsonObject(
      row.inputSnapshot,
      'execution input',
    ) as AdvanceServicePeriodInputSnapshot,
    inputHash: hash(row.inputHash, 'execution input hash'),
    resultSnapshot: jsonObject(
      row.resultSnapshot,
      'execution result',
    ) as AdvanceServicePeriodResultSnapshot,
    resultHash: hash(row.resultHash, 'execution result hash'),
  });
}

function parseStock(row: StockRow): PersistedInventoryStock {
  const pool = row.pool;
  if (pool !== 'DURABLE' && pool !== 'PERISHABLE') throw new Error('unknown stock pool');
  return Object.freeze({
    id: stringValue(row.id, 'stock id'),
    inventoryItemId: stringValue(row.inventoryItemId, 'item id'),
    ingredientId: stringValue(row.ingredientId, 'ingredient id'),
    pool,
    version: positive(row.version, 'stock version'),
    onHandPoints: databaseInteger(row.onHand, 'on hand'),
    reservedUndeliveredPoints: databaseInteger(row.reservedUndelivered, 'reserved undelivered'),
    costPoolMinor: databaseBigintString(row.costPoolMinor, 'cost pool'),
  });
}

function parseAudit(row: TransactionRow): PersistedInventoryAudit {
  return Object.freeze({
    commandId: stringValue(row.commandId, 'audit command id'),
    commandSequence: databaseInteger(row.commandSequence, 'audit command sequence'),
    ingredientId: stringValue(row.ingredientId, 'audit ingredient id'),
    metadata: jsonObject(row.metadata, 'audit metadata'),
  });
}

function privateId(kind: string, ...parts: readonly string[]): string {
  return `${kind}:${createHash('sha256').update(parts.join('\u0000')).digest('hex')}`;
}
function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${name} is required`);
  return value;
}
function databaseBigintString(value: unknown, name: string): string {
  const text =
    typeof value === 'bigint'
      ? value.toString()
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text))
    throw new Error(`${name} must be a non-negative integer`);
  return text;
}
function databaseInteger(value: unknown, name: string): number {
  const text = databaseBigintString(value, name);
  const parsed = BigInt(text);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} exceeds safe integer`);
  return Number(parsed);
}
function positive(value: unknown, name: string): number {
  const parsed = databaseInteger(value, name);
  if (parsed < 1) throw new Error(`${name} must be positive`);
  return parsed;
}
function one(value: unknown): 1 {
  if (databaseInteger(value, 'pre-open revision') !== 1)
    throw new Error('pre-open revision must be one');
  return 1;
}
function hash(value: unknown, name: string): string {
  const text = stringValue(value, name);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${name} is invalid`);
  return text;
}
function jsonObject(value: unknown, name: string): Readonly<Record<string, unknown>> {
  let parsed = value;
  if (typeof parsed === 'string') parsed = JSON.parse(parsed) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${name} must be an object`);
  return parsed as Readonly<Record<string, unknown>>;
}
function membershipRole(value: unknown): 'OWNER' | 'MANAGER' {
  if (value !== 'OWNER' && value !== 'MANAGER')
    throw new Error('membership role is not authorized');
  return value;
}
function periodPlan(value: unknown): 'TWO_PERIODS' | 'THREE_PERIODS' {
  if (value !== 'TWO_PERIODS' && value !== 'THREE_PERIODS') throw new Error('unknown period plan');
  return value;
}
function periodKey(value: unknown): 'LUNCH' | 'OFF_PEAK' | 'DINNER' {
  if (value !== 'LUNCH' && value !== 'OFF_PEAK' && value !== 'DINNER')
    throw new Error('unknown period key');
  return value;
}
function scenario(value: unknown): FirstDayOpenAuthority['save']['scenario'] {
  if (value !== 'EMPTY_PREMISES' && value !== 'DEFAULT_SMALL_SHOP' && value !== 'TROUBLED_SHOP')
    throw new Error('unknown scenario');
  return value;
}
function operatingMode(value: unknown): FirstDayOpenAuthority['save']['operatingMode'] {
  if (value !== 'STRATEGY' && value !== 'LIGHTWEIGHT_REALTIME')
    throw new Error('unknown operating mode');
  return value;
}
