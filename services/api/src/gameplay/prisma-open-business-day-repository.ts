import { CommandError } from '../commands/command-contract.js';
import type { DurableCommandPersistence } from '../commands/command-dispatcher.js';
import type { OpeningSnapshot } from '../domains/opening-scenario/snapshot.js';

type OpenAuthorityRow = Readonly<{
  saveId: unknown;
  openingScenario: unknown;
  operatingMode: unknown;
  saveServicePeriodPlan: unknown;
  demandSeed: unknown;
  saveSimulationRuleVersion: unknown;
  openingSnapshot: unknown;
  openingSnapshotHash: unknown;
  businessDayId: unknown;
  businessDayStatus: unknown;
  businessDayServicePeriodPlan: unknown;
  businessDaySimulationRuleVersion: unknown;
  openedByCommandId: unknown;
  consumedPreopenSnapshotId: unknown;
  openSnapshot: unknown;
  openSnapshotHash: unknown;
  openedAt: unknown;
  preopenSnapshotId: unknown;
  preopenRevision: unknown;
  preopenCommandId: unknown;
  preopenSnapshotSchemaVersion: unknown;
  preopenSimulationRuleVersion: unknown;
  preopenPayload: unknown;
  preopenSnapshotHash: unknown;
}>;

type PoolAuthorityRow = Readonly<{
  saveId: unknown;
  pool: unknown;
  revision: unknown;
  capacityPoints: unknown;
  storageBundleVersion: unknown;
  storageBundleKind: unknown;
}>;

type OpenedBusinessDayRow = Readonly<{
  businessDayId: unknown;
  status: unknown;
  consumedPreopenSnapshotId: unknown;
  openSnapshotHash: unknown;
}>;

export type OpenBusinessDayScope = Readonly<{
  restaurantId: string;
  saveId: string;
  membershipId: string;
  actorId: string;
}>;

export type OpenInventoryPoolAuthority = Readonly<{
  saveId: string;
  pool: 'DURABLE' | 'PERISHABLE';
  revision: number;
  capacityPoints: number;
  storageBundleVersion: string;
  storageBundleKind: 'NONE' | 'BASIC' | 'AGED' | 'VERSIONED_UPGRADE';
}>;

export type FirstDayOpenAuthority = Readonly<{
  save: Readonly<{
    id: string;
    scenario: 'EMPTY_PREMISES' | 'DEFAULT_SMALL_SHOP' | 'TROUBLED_SHOP';
    operatingMode: 'STRATEGY' | 'LIGHTWEIGHT_REALTIME';
    servicePeriodPlan: 'TWO_PERIODS' | 'THREE_PERIODS';
    demandSeed: string;
    simulationRuleVersion: string;
    openingSnapshot: OpeningSnapshot;
    openingSnapshotHash: string;
  }>;
  businessDay: Readonly<{
    id: string;
    status: string;
    servicePeriodPlan: 'TWO_PERIODS' | 'THREE_PERIODS';
    simulationRuleVersion: string;
  }>;
  preopenSnapshot: Readonly<{
    id: string;
    revision: 1;
    commandId: string;
    snapshotSchemaVersion: string;
    simulationRuleVersion: string;
    payload: Readonly<Record<string, unknown>>;
    snapshotHash: string;
  }>;
  inventoryPoolAuthorities: readonly OpenInventoryPoolAuthority[];
}>;

export type PersistOpenBusinessDayInput = Readonly<{
  restaurantId: string;
  saveId: string;
  businessDayId: string;
  commandId: string;
  preopenSnapshotId: string;
  preopenSnapshotHash: string;
  privatePayload: Readonly<Record<string, unknown>>;
}>;

/** Transaction-bound OPEN adapter. D03 already owns the save/membership lock. */
export class PrismaOpenBusinessDayRepository {
  constructor(private readonly persistence: DurableCommandPersistence) {}

  async loadFirstDayOpenAuthority(scope: OpenBusinessDayScope): Promise<FirstDayOpenAuthority> {
    const rows = await this.persistence.mutate<readonly OpenAuthorityRow[]>(
      `/* open-business-day:scope */
       SELECT save."id" AS "saveId", save."openingScenario", save."operatingMode",
              save."servicePeriodPlan" AS "saveServicePeriodPlan",
              save."demandSeed",
              save."simulationRuleVersion" AS "saveSimulationRuleVersion",
              save."openingSnapshot", save."openingSnapshotHash",
              day."id" AS "businessDayId", day."status"::text AS "businessDayStatus",
              day."servicePeriodPlan" AS "businessDayServicePeriodPlan",
              day."simulationRuleVersion" AS "businessDaySimulationRuleVersion",
              day."openedByCommandId", day."consumedPreopenSnapshotId",
              day."openSnapshot", day."openSnapshotHash", day."openedAt",
              snapshot."id" AS "preopenSnapshotId", snapshot."revision" AS "preopenRevision",
              snapshot."commandId" AS "preopenCommandId",
              snapshot."snapshotSchemaVersion" AS "preopenSnapshotSchemaVersion",
              snapshot."simulationRuleVersion" AS "preopenSimulationRuleVersion",
              snapshot."payload" AS "preopenPayload",
              snapshot."snapshotHash" AS "preopenSnapshotHash"
       FROM "CompetitiveSave" save
       JOIN "RestaurantMembership" membership
         ON membership."id" = $3
        AND membership."playerId" = $4
        AND membership."restaurantId" = save."restaurantId"
        AND membership."revokedAt" IS NULL
        AND membership."role" IN ('OWNER', 'MANAGER')
       JOIN "BusinessDay" day
         ON day."restaurantId" = save."restaurantId"
        AND day."saveId" = save."id"
        AND day."businessDay" = 1
       JOIN "PreopenDaySnapshot" snapshot
         ON snapshot."restaurantId" = day."restaurantId"
        AND snapshot."saveId" = day."saveId"
        AND snapshot."businessDay" = day."businessDay"
        AND snapshot."revision" = 1
       WHERE save."id" = $1
         AND save."restaurantId" = $2
         AND save."retiredAt" IS NULL
       FOR UPDATE OF day
       FOR SHARE OF save, membership, snapshot`,
      scope.saveId,
      scope.restaurantId,
      scope.membershipId,
      scope.actorId,
    );
    if (rows.length !== 1) throw new CommandError(409, 'OPEN_DAY_NOT_CONFIGURED');
    const row = rows[0]!;
    if (
      row.businessDayStatus !== 'PREOPEN' ||
      row.openedByCommandId !== null ||
      row.consumedPreopenSnapshotId !== null ||
      row.openSnapshot !== null ||
      row.openSnapshotHash !== null ||
      row.openedAt !== null
    ) {
      throw new CommandError(409, 'BUSINESS_DAY_NOT_PREOPEN');
    }

    const poolRows = await this.persistence.mutate<readonly PoolAuthorityRow[]>(
      `/* open-business-day:inventory-pools */
       SELECT pool."saveId", pool."pool"::text AS "pool", pool."revision",
              pool."capacityPoints", pool."storageBundleVersion", pool."storageBundleKind"
       FROM "InventoryPoolState" pool
       WHERE pool."restaurantId" = $1
         AND pool."saveId" = $2
       ORDER BY pool."pool"
       FOR SHARE OF pool`,
      scope.restaurantId,
      scope.saveId,
    );

    try {
      const saveId = nonEmptyString(row.saveId, 'save id');
      const servicePeriodPlan = periodPlan(row.saveServicePeriodPlan);
      const simulationRuleVersion = nonEmptyString(
        row.saveSimulationRuleVersion,
        'simulation rule version',
      );
      const businessDayServicePeriodPlan = periodPlan(row.businessDayServicePeriodPlan);
      const businessDaySimulationRuleVersion = nonEmptyString(
        row.businessDaySimulationRuleVersion,
        'business day simulation rule version',
      );
      const snapshotRule = nonEmptyString(
        row.preopenSimulationRuleVersion,
        'pre-open simulation rule version',
      );
      if (
        snapshotRule !== simulationRuleVersion ||
        businessDaySimulationRuleVersion !== simulationRuleVersion ||
        businessDayServicePeriodPlan !== servicePeriodPlan
      ) {
        throw new Error('business day, pre-open, and save configuration authority differ');
      }
      if (poolRows.length !== 2) throw new Error('OPEN requires exactly two inventory pools');
      const inventoryPoolAuthorities = Object.freeze(
        poolRows.map((poolRow) =>
          Object.freeze({
            saveId: nonEmptyString(poolRow.saveId, 'inventory pool save id'),
            pool: poolName(poolRow.pool),
            revision: positiveInteger(poolRow.revision, 'inventory pool revision'),
            capacityPoints: nonNegativeInteger(poolRow.capacityPoints, 'inventory pool capacity'),
            storageBundleVersion: nonEmptyString(
              poolRow.storageBundleVersion,
              'storage bundle version',
            ),
            storageBundleKind: storageBundleKind(poolRow.storageBundleKind),
          }),
        ),
      );
      if (
        inventoryPoolAuthorities.some((pool) => pool.saveId !== saveId) ||
        new Set(inventoryPoolAuthorities.map((pool) => pool.pool)).size !== 2
      ) {
        throw new Error('inventory pools do not belong to this save or are duplicated');
      }
      return Object.freeze({
        save: Object.freeze({
          id: saveId,
          scenario: scenario(row.openingScenario),
          operatingMode: operatingMode(row.operatingMode),
          servicePeriodPlan,
          demandSeed: nonEmptyString(row.demandSeed, 'demand seed'),
          simulationRuleVersion,
          openingSnapshot: jsonObject(row.openingSnapshot, 'opening snapshot') as OpeningSnapshot,
          openingSnapshotHash: sha256(row.openingSnapshotHash, 'opening snapshot hash'),
        }),
        businessDay: Object.freeze({
          id: nonEmptyString(row.businessDayId, 'business day id'),
          status: 'PREOPEN',
          servicePeriodPlan: businessDayServicePeriodPlan,
          simulationRuleVersion: businessDaySimulationRuleVersion,
        }),
        preopenSnapshot: Object.freeze({
          id: nonEmptyString(row.preopenSnapshotId, 'pre-open snapshot id'),
          revision: revisionOne(row.preopenRevision),
          commandId: nonEmptyString(row.preopenCommandId, 'pre-open command id'),
          snapshotSchemaVersion: nonEmptyString(
            row.preopenSnapshotSchemaVersion,
            'pre-open snapshot schema version',
          ),
          simulationRuleVersion: snapshotRule,
          payload: jsonObject(row.preopenPayload, 'pre-open payload'),
          snapshotHash: sha256(row.preopenSnapshotHash, 'pre-open snapshot hash'),
        }),
        inventoryPoolAuthorities,
      });
    } catch (error) {
      if (error instanceof CommandError) throw error;
      throw new CommandError(503, 'OPEN_AUTHORITY_INVALID');
    }
  }

  async openFirstDay(input: PersistOpenBusinessDayInput): Promise<void> {
    const rows = await this.persistence.mutate<readonly OpenedBusinessDayRow[]>(
      `/* open-business-day:transition */
       UPDATE "BusinessDay"
       SET "status" = 'OPEN',
           "openedByCommandId" = $4,
           "consumedPreopenSnapshotId" = $5,
           "openSnapshot" = $6::jsonb,
           "openSnapshotHash" = $7,
           "openedAt" = CURRENT_TIMESTAMP
       WHERE "restaurantId" = $1
         AND "saveId" = $2
         AND "id" = $3
         AND "businessDay" = 1
         AND "status" = 'PREOPEN'
         AND "openedByCommandId" IS NULL
         AND "consumedPreopenSnapshotId" IS NULL
         AND "openSnapshot" IS NULL
         AND "openSnapshotHash" IS NULL
         AND "openedAt" IS NULL
       RETURNING "id" AS "businessDayId", "status"::text AS "status",
                 "consumedPreopenSnapshotId", "openSnapshotHash"`,
      input.restaurantId,
      input.saveId,
      input.businessDayId,
      input.commandId,
      input.preopenSnapshotId,
      JSON.stringify(input.privatePayload),
      input.preopenSnapshotHash,
    );
    const opened = rows[0];
    if (
      rows.length !== 1 ||
      !opened ||
      opened.businessDayId !== input.businessDayId ||
      opened.status !== 'OPEN' ||
      opened.consumedPreopenSnapshotId !== input.preopenSnapshotId ||
      opened.openSnapshotHash !== input.preopenSnapshotHash
    ) {
      throw new CommandError(409, 'BUSINESS_DAY_NOT_PREOPEN');
    }
  }
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty database value`);
  }
  return value;
}

function databaseInteger(value: unknown, name: string): number {
  const parsed =
    typeof value === 'bigint'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? BigInt(value)
        : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)
          ? BigInt(value)
          : undefined;
  if (parsed === undefined || parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${name} must be a non-negative safe database integer`);
  }
  return Number(parsed);
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = databaseInteger(value, name);
  if (parsed < 1) throw new Error(`${name} must be positive`);
  return parsed;
}

function nonNegativeInteger(value: unknown, name: string): number {
  return databaseInteger(value, name);
}

function revisionOne(value: unknown): 1 {
  if (databaseInteger(value, 'pre-open revision') !== 1) {
    throw new Error('OPEN accepts only immutable pre-open revision 1');
  }
  return 1;
}

function sha256(value: unknown, name: string): string {
  const digest = nonEmptyString(value, name);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${name} must be SHA-256 hex`);
  return digest;
}

function scenario(value: unknown): FirstDayOpenAuthority['save']['scenario'] {
  if (value !== 'EMPTY_PREMISES' && value !== 'DEFAULT_SMALL_SHOP' && value !== 'TROUBLED_SHOP') {
    throw new Error('unknown opening scenario');
  }
  return value;
}

function operatingMode(value: unknown): FirstDayOpenAuthority['save']['operatingMode'] {
  if (value !== 'STRATEGY' && value !== 'LIGHTWEIGHT_REALTIME') {
    throw new Error('unknown operating mode');
  }
  return value;
}

function periodPlan(value: unknown): FirstDayOpenAuthority['save']['servicePeriodPlan'] {
  if (value !== 'TWO_PERIODS' && value !== 'THREE_PERIODS') {
    throw new Error('unknown service period plan');
  }
  return value;
}

function poolName(value: unknown): OpenInventoryPoolAuthority['pool'] {
  if (value !== 'DURABLE' && value !== 'PERISHABLE') {
    throw new Error('unknown inventory pool');
  }
  return value;
}

function storageBundleKind(value: unknown): OpenInventoryPoolAuthority['storageBundleKind'] {
  if (value !== 'NONE' && value !== 'BASIC' && value !== 'AGED' && value !== 'VERSIONED_UPGRADE') {
    throw new Error('unknown storage bundle kind');
  }
  return value;
}

function jsonObject(value: unknown, name: string): Readonly<Record<string, unknown>> {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new Error(`${name} is not valid JSON`);
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}
