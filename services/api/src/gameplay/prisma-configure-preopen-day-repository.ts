import { CommandError } from '../commands/command-contract.js';
import type { DurableCommandPersistence } from '../commands/command-dispatcher.js';
import type { OpeningSnapshot } from '../domains/opening-scenario/snapshot.js';
import type {
  PersistedCompetitiveSavePreopenAuthority,
  PersistedInventoryPoolAuthority,
  PersistedMarketSeedAuthority,
} from './preopen-day-authority-provider.js';
import type { PreopenDayPrivateEnvelope } from './preopen-day-plan.js';

export type FirstDayPreopenAuthority = Readonly<{
  save: PersistedCompetitiveSavePreopenAuthority;
  marketSeedAuthority: PersistedMarketSeedAuthority;
  inventoryPoolAuthorities: readonly PersistedInventoryPoolAuthority[];
}>;

type SaveAuthorityRow = Readonly<{
  saveId: unknown;
  openingScenario: unknown;
  operatingMode: unknown;
  servicePeriodPlan: unknown;
  demandSeed: unknown;
  simulationRuleVersion: unknown;
  settlementCurrency: unknown;
  openingSnapshot: unknown;
  openingSnapshotHash: unknown;
  existingBusinessDayId: unknown;
  existingBusinessDayStatus: unknown;
  existingPreopenSnapshotCount: unknown;
}>;

type PoolAuthorityRow = Readonly<{
  marketSaveId: unknown;
  marketSeed: unknown;
  marketSeedVersion: unknown;
  poolSaveId: unknown;
  pool: unknown;
  revision: unknown;
  capacityPoints: unknown;
  storageBundleVersion: unknown;
  storageBundleKind: unknown;
}>;

type InsertedBusinessDayRow = Readonly<{
  businessDayId: unknown;
}>;

type InsertedPreopenSnapshotRow = Readonly<{
  preopenSnapshotId: unknown;
  snapshotHash: unknown;
  payloadHash: unknown;
}>;

export type ConfigurePreopenDayScope = Readonly<{
  restaurantId: string;
  saveId: string;
  membershipId: string;
  actorId: string;
}>;

export type PersistFirstDayPreopenInput = Readonly<{
  businessDayId: string;
  restaurantId: string;
  saveId: string;
  commandId: string;
  servicePeriodPlan: string;
  simulationRuleVersion: string;
  privateEnvelope: PreopenDayPrivateEnvelope;
}>;

/**
 * Transaction-bound adapter for CONFIGURE_PREOPEN_DAY. The generic D03 store
 * already owns the save/membership FOR UPDATE lock; this adapter reasserts the
 * exact scope and holds SHARE locks on the immutable first-day authorities.
 */
export class PrismaConfigurePreopenDayRepository {
  constructor(private readonly persistence: DurableCommandPersistence) {}

  async loadFirstDayAuthority(scope: ConfigurePreopenDayScope): Promise<FirstDayPreopenAuthority> {
    const saveRows = await this.persistence.mutate<readonly SaveAuthorityRow[]>(
      `/* configure-preopen-day:scope */
       SELECT save."id" AS "saveId",
              save."openingScenario", save."operatingMode", save."servicePeriodPlan",
              save."demandSeed", save."simulationRuleVersion",
              save."openingSnapshot" #>> '{settlementCurrency,code}' AS "settlementCurrency",
              save."openingSnapshot", save."openingSnapshotHash",
              day."id" AS "existingBusinessDayId",
              day."status"::text AS "existingBusinessDayStatus",
              (
                SELECT COUNT(*)::int
                FROM "PreopenDaySnapshot" snapshot
                WHERE snapshot."restaurantId" = save."restaurantId"
                  AND snapshot."saveId" = save."id"
                  AND snapshot."businessDay" = 1
              ) AS "existingPreopenSnapshotCount"
       FROM "CompetitiveSave" save
       JOIN "RestaurantMembership" membership
         ON membership."id" = $3
        AND membership."playerId" = $4
        AND membership."restaurantId" = save."restaurantId"
        AND membership."revokedAt" IS NULL
        AND membership."role" IN ('OWNER', 'MANAGER')
       LEFT JOIN "BusinessDay" day
         ON day."restaurantId" = save."restaurantId"
        AND day."saveId" = save."id"
        AND day."businessDay" = 1
       WHERE save."id" = $1
         AND save."restaurantId" = $2
         AND save."retiredAt" IS NULL
       FOR SHARE OF save, membership`,
      scope.saveId,
      scope.restaurantId,
      scope.membershipId,
      scope.actorId,
    );

    if (saveRows.length !== 1) throw new CommandError(403, 'PREOPEN_SCOPE_FORBIDDEN');
    const saveRow = saveRows[0]!;
    if (
      (saveRow.existingBusinessDayId !== null &&
        saveRow.existingBusinessDayId !== undefined) ||
      databaseInteger(saveRow.existingPreopenSnapshotCount, 'snapshot count') > 0
    ) {
      throw new CommandError(409, 'PREOPEN_DAY_ALREADY_CONFIGURED');
    }

    const authorityRows = await this.persistence.mutate<readonly PoolAuthorityRow[]>(
      `/* configure-preopen-day:authority */
       SELECT market."saveId" AS "marketSaveId", market."seed" AS "marketSeed",
              market."seedVersion" AS "marketSeedVersion",
              pool."saveId" AS "poolSaveId", pool."pool"::text AS "pool",
              pool."revision", pool."capacityPoints", pool."storageBundleVersion",
              pool."storageBundleKind"
       FROM "CompetitiveSave" save
       JOIN "MarketSeedAuthority" market
         ON market."restaurantId" = save."restaurantId"
        AND market."saveId" = save."id"
       JOIN "InventoryPoolState" pool
         ON pool."restaurantId" = save."restaurantId"
        AND pool."saveId" = save."id"
       WHERE save."id" = $1
         AND save."restaurantId" = $2
         AND save."retiredAt" IS NULL
       ORDER BY pool."pool"
       FOR SHARE OF market, pool`,
      scope.saveId,
      scope.restaurantId,
    );

    try {
      if (authorityRows.length !== 2) throw new Error('first-day authority requires two pools');
      const firstAuthority = authorityRows[0]!;
      assertConsistentAuthorityRows(authorityRows, firstAuthority);
      const openingSnapshot = jsonObject(
        saveRow.openingSnapshot,
        'opening snapshot',
      ) as OpeningSnapshot;
      const saveId = nonEmptyString(saveRow.saveId, 'save id');
      const marketSeedAuthority: PersistedMarketSeedAuthority = Object.freeze({
        saveId: nonEmptyString(firstAuthority.marketSaveId, 'market save id'),
        seed: nonEmptyString(firstAuthority.marketSeed, 'market seed'),
        seedVersion: nonEmptyString(firstAuthority.marketSeedVersion, 'market seed version'),
      });
      const inventoryPoolAuthorities = authorityRows
        .map((row) =>
          Object.freeze({
            saveId: nonEmptyString(row.poolSaveId, 'inventory pool save id'),
            pool: poolName(row.pool),
            revision: databaseInteger(row.revision, 'inventory pool revision'),
            capacityPoints: databaseInteger(row.capacityPoints, 'inventory pool capacity'),
            storageBundleVersion: nonEmptyString(
              row.storageBundleVersion,
              'storage bundle version',
            ),
            storageBundleKind: nonEmptyString(
              row.storageBundleKind,
              'storage bundle kind',
            ) as PersistedInventoryPoolAuthority['storageBundleKind'],
          }),
        );
      return Object.freeze({
        save: Object.freeze({
          id: saveId,
          scenario: nonEmptyString(
            saveRow.openingScenario,
            'opening scenario',
          ) as PersistedCompetitiveSavePreopenAuthority['scenario'],
          operatingMode: nonEmptyString(
            saveRow.operatingMode,
            'operating mode',
          ) as PersistedCompetitiveSavePreopenAuthority['operatingMode'],
          servicePeriodPlan: nonEmptyString(
            saveRow.servicePeriodPlan,
            'service period plan',
          ) as PersistedCompetitiveSavePreopenAuthority['servicePeriodPlan'],
          demandSeed: nonEmptyString(saveRow.demandSeed, 'demand seed'),
          simulationRuleVersion: nonEmptyString(
            saveRow.simulationRuleVersion,
            'simulation rule version',
          ),
          settlementCurrency: nonEmptyString(
            saveRow.settlementCurrency,
            'settlement currency',
          ),
          openingSnapshot,
          openingSnapshotHash: nonEmptyString(
            saveRow.openingSnapshotHash,
            'opening snapshot hash',
          ),
        }),
        marketSeedAuthority,
        inventoryPoolAuthorities: Object.freeze(inventoryPoolAuthorities),
      });
    } catch (error) {
      if (error instanceof CommandError) throw error;
      throw new CommandError(503, 'PREOPEN_AUTHORITY_INVALID');
    }
  }

  async createFirstDayPreopen(input: PersistFirstDayPreopenInput): Promise<void> {
    const payload = JSON.stringify(input.privateEnvelope);
    const expectedHash = input.privateEnvelope.preopenSnapshotHash;
    const dayRows = await this.persistence.mutate<readonly InsertedBusinessDayRow[]>(
      `/* configure-preopen-day:create-business-day */
       INSERT INTO "BusinessDay" (
         "id", "restaurantId", "saveId", "businessDay", "status",
         "servicePeriodPlan", "simulationRuleVersion", "createdByCommandId"
       ) VALUES ($1,$2,$3,1,'PREOPEN',$4,$5,$6)
       ON CONFLICT DO NOTHING
       RETURNING "id" AS "businessDayId"`,
      input.businessDayId,
      input.restaurantId,
      input.saveId,
      input.servicePeriodPlan,
      input.simulationRuleVersion,
      input.commandId,
    );
    if (dayRows.length !== 1 || dayRows[0]?.businessDayId !== input.businessDayId) {
      throw new CommandError(409, 'PREOPEN_DAY_ALREADY_CONFIGURED');
    }

    const snapshotRows = await this.persistence.mutate<readonly InsertedPreopenSnapshotRow[]>(
      `/* configure-preopen-day:create-snapshot */
       INSERT INTO "PreopenDaySnapshot" (
         "id", "restaurantId", "saveId", "businessDay", "revision", "commandId",
         "snapshotSchemaVersion", "simulationRuleVersion", "payload", "snapshotHash"
       ) VALUES ($1,$2,$3,1,1,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT DO NOTHING
       RETURNING "id" AS "preopenSnapshotId", "snapshotHash",
                 "payload" ->> 'preopenSnapshotHash' AS "payloadHash"`,
      input.privateEnvelope.preopenSnapshotId,
      input.restaurantId,
      input.saveId,
      input.commandId,
      input.privateEnvelope.envelopeVersion,
      input.simulationRuleVersion,
      payload,
      expectedHash,
    );
    const inserted = snapshotRows[0];
    if (
      snapshotRows.length !== 1 ||
      !inserted ||
      inserted.preopenSnapshotId !== input.privateEnvelope.preopenSnapshotId ||
      inserted.snapshotHash !== expectedHash ||
      inserted.payloadHash !== expectedHash
    ) {
      throw new CommandError(409, 'PREOPEN_DAY_ALREADY_CONFIGURED');
    }
  }
}

function assertConsistentAuthorityRows(
  rows: readonly PoolAuthorityRow[],
  first: PoolAuthorityRow,
): void {
  const scalarKeys = [
    'marketSaveId',
    'marketSeed',
    'marketSeedVersion',
  ] as const;
  for (const row of rows) {
    if (scalarKeys.some((key) => row[key] !== first[key])) {
      throw new Error('inconsistent duplicated authority rows');
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

function poolName(value: unknown): PersistedInventoryPoolAuthority['pool'] {
  if (value !== 'DURABLE' && value !== 'PERISHABLE') {
    throw new Error('unknown inventory pool database value');
  }
  return value;
}

function jsonObject(value: unknown, name: string): Record<string, unknown> {
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
  return parsed as Record<string, unknown>;
}
