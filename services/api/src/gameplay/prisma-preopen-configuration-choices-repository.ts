import { CommandError } from '../commands/command-contract.js';
import { createStorageBundleSnapshot } from '../domains/inventory-procurement/inventory.js';
import type { OpeningScenario } from '../domains/opening-scenario/catalog.js';
import type { D03Database, D03Queryable } from '../domains/ledger/postgres-ledger-store.js';
import type { PreopenConfigurationChoicesAuthority } from './preopen-configuration-choices.js';

const STORAGE_BUNDLE_VERSION = 'mvp-storage/v1' as const;

export type PreopenConfigurationChoicesScope = Readonly<{
  playerId: string;
  membershipId: string;
  tenantId: string;
  saveId: string;
  role: 'OWNER' | 'MANAGER';
}>;

export type ScopedPreopenConfigurationChoicesAuthority = Readonly<{
  scope: PreopenConfigurationChoicesScope;
  authority: PreopenConfigurationChoicesAuthority;
}>;

export interface PreopenConfigurationChoicesRepository {
  resolveScope(
    playerId: string,
    saveId: string,
  ): Promise<PreopenConfigurationChoicesScope | undefined>;
  loadAuthority(
    scope: PreopenConfigurationChoicesScope,
  ): Promise<ScopedPreopenConfigurationChoicesAuthority | undefined>;
}

type ScopeRow = Readonly<{
  playerId: unknown;
  membershipId: unknown;
  tenantId: unknown;
  saveId: unknown;
  role: unknown;
}>;

type AuthorityRow = ScopeRow &
  Readonly<{
    expectedVersion: unknown;
    openingScenario: unknown;
    operatingMode: unknown;
    servicePeriodPlan: unknown;
    simulationRuleVersion: unknown;
    settlementCurrency: unknown;
    businessDayId: unknown;
    preopenSnapshotCount: unknown;
    poolSaveId: unknown;
    pool: unknown;
    poolRevision: unknown;
    capacityPoints: unknown;
    storageBundleVersion: unknown;
    storageBundleKind: unknown;
  }>;

/**
 * Read-only durable adapter for the Web configuration form. Scope is resolved
 * separately so D05 eligibility and scope-resolution audit can run before any
 * configuration authority is read. The authority read reasserts the same
 * membership to close the revoke/retire race without taking locks.
 */
export class PrismaPreopenConfigurationChoicesRepository
  implements PreopenConfigurationChoicesRepository
{
  constructor(private readonly database: D03Database) {}

  resolveScope(
    playerId: string,
    saveId: string,
  ): Promise<PreopenConfigurationChoicesScope | undefined> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRawUnsafe<readonly ScopeRow[]>(
        `/* preopen-configuration-choices:scope */
         SELECT membership."playerId", membership."id" AS "membershipId",
                save."restaurantId" AS "tenantId", save."id" AS "saveId",
                membership."role"::text AS "role"
         FROM "CompetitiveSave" save
         JOIN "RestaurantMembership" membership
           ON membership."restaurantId" = save."restaurantId"
          AND membership."playerId" = $1
          AND membership."revokedAt" IS NULL
          AND membership."role" IN ('OWNER', 'MANAGER')
         WHERE save."id" = $2
           AND save."retiredAt" IS NULL
         LIMIT 2`,
        playerId,
        saveId,
      );
      if (rows.length > 1) throw projectionUnavailable();
      return rows[0] ? parseScope(rows[0], playerId, saveId) : undefined;
    });
  }

  loadAuthority(
    scope: PreopenConfigurationChoicesScope,
  ): Promise<ScopedPreopenConfigurationChoicesAuthority | undefined> {
    return this.database.$transaction(async (transaction) => {
      const rows = await loadAuthorityRows(transaction, scope);
      if (rows.length === 0) return undefined;
      return projectAuthority(rows, scope);
    });
  }
}

async function loadAuthorityRows(
  transaction: D03Queryable,
  scope: PreopenConfigurationChoicesScope,
): Promise<readonly AuthorityRow[]> {
  return transaction.$queryRawUnsafe<readonly AuthorityRow[]>(
    `/* preopen-configuration-choices:authority */
     SELECT membership."playerId", membership."id" AS "membershipId",
            save."restaurantId" AS "tenantId", save."id" AS "saveId",
            membership."role"::text AS "role", save."version" AS "expectedVersion",
            save."openingScenario", save."operatingMode", save."servicePeriodPlan",
            save."simulationRuleVersion",
            save."openingSnapshot" #>> '{settlementCurrency,code}' AS "settlementCurrency",
            day."id" AS "businessDayId",
            (
              SELECT COUNT(*)::int
              FROM "PreopenDaySnapshot" snapshot
              WHERE snapshot."restaurantId" = save."restaurantId"
                AND snapshot."saveId" = save."id"
                AND snapshot."businessDay" = 1
            ) AS "preopenSnapshotCount",
            pool."saveId" AS "poolSaveId", pool."pool"::text AS "pool",
            pool."revision" AS "poolRevision", pool."capacityPoints",
            pool."storageBundleVersion", pool."storageBundleKind"
     FROM "CompetitiveSave" save
     JOIN "RestaurantMembership" membership
       ON membership."id" = $3
      AND membership."restaurantId" = save."restaurantId"
      AND membership."playerId" = $4
      AND membership."revokedAt" IS NULL
      AND membership."role" IN ('OWNER', 'MANAGER')
     LEFT JOIN "BusinessDay" day
       ON day."restaurantId" = save."restaurantId"
      AND day."saveId" = save."id"
      AND day."businessDay" = 1
     LEFT JOIN "InventoryPoolState" pool
       ON pool."restaurantId" = save."restaurantId"
      AND pool."saveId" = save."id"
     WHERE save."id" = $1
       AND save."restaurantId" = $2
       AND save."retiredAt" IS NULL
     ORDER BY pool."pool"`,
    scope.saveId,
    scope.tenantId,
    scope.membershipId,
    scope.playerId,
  );
}

function projectAuthority(
  rows: readonly AuthorityRow[],
  expectedScope: PreopenConfigurationChoicesScope,
): ScopedPreopenConfigurationChoicesAuthority {
  try {
    const first = rows[0];
    if (!first) throw new Error('missing authority row');
    for (const row of rows) assertSameScopeAndSave(row, first, expectedScope);
    if (first.businessDayId !== null) {
      nonEmpty(first.businessDayId);
      throw new CommandError(409, 'PREOPEN_CONFIGURATION_PHASE_UNAVAILABLE');
    }
    if (databaseInteger(first.preopenSnapshotCount) !== 0) {
      throw new CommandError(409, 'PREOPEN_CONFIGURATION_PHASE_UNAVAILABLE');
    }

    const scenario = openingScenario(first.openingScenario);
    const storage = createStorageBundleSnapshot(scenario, {
      version: STORAGE_BUNDLE_VERSION,
      kind:
        scenario === 'EMPTY_PREMISES' ? 'NONE' : scenario === 'TROUBLED_SHOP' ? 'AGED' : 'BASIC',
    });
    if (rows.length !== 2) throw new Error('exactly two inventory pools are required');
    const seen = new Set<string>();
    for (const row of rows) {
      const pool = row.pool;
      if ((pool !== 'DURABLE' && pool !== 'PERISHABLE') || seen.has(pool)) {
        throw new Error('inventory pool authority is ambiguous');
      }
      seen.add(pool);
      if (
        row.poolSaveId !== expectedScope.saveId ||
        databaseInteger(row.poolRevision) !== 1 ||
        databaseInteger(row.capacityPoints) !== storage.capacity[pool] ||
        row.storageBundleVersion !== storage.version ||
        row.storageBundleKind !== storage.kind
      ) {
        throw new Error('inventory pool authority does not match bootstrap entitlement');
      }
    }

    const authority: PreopenConfigurationChoicesAuthority = Object.freeze({
      save: Object.freeze({
        id: nonEmpty(first.saveId),
        expectedVersion: databaseInteger(first.expectedVersion),
        phase: 'CONFIGURE_REQUIRED' as const,
        scenario,
        operatingMode: exactOneOf(first.operatingMode, ['STRATEGY', 'LIGHTWEIGHT_REALTIME']),
        servicePeriodPlan: exactOneOf(first.servicePeriodPlan, ['TWO_PERIODS', 'THREE_PERIODS']),
        simulationRuleVersion: nonEmpty(first.simulationRuleVersion),
        settlementCurrency: exactOneOf(first.settlementCurrency, ['TWD', 'USD']),
      }),
    });
    return Object.freeze({ scope: expectedScope, authority });
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw projectionUnavailable();
  }
}

function parseScope(
  row: ScopeRow,
  playerId: string,
  saveId: string,
): PreopenConfigurationChoicesScope {
  try {
    if (
      row.playerId !== playerId ||
      row.saveId !== saveId ||
      (row.role !== 'OWNER' && row.role !== 'MANAGER')
    ) {
      throw new Error('scope row mismatch');
    }
    return Object.freeze({
      playerId,
      membershipId: nonEmpty(row.membershipId),
      tenantId: nonEmpty(row.tenantId),
      saveId,
      role: row.role,
    });
  } catch {
    throw projectionUnavailable();
  }
}

function assertSameScopeAndSave(
  row: AuthorityRow,
  first: AuthorityRow,
  scope: PreopenConfigurationChoicesScope,
): void {
  for (const key of [
    'playerId',
    'membershipId',
    'tenantId',
    'saveId',
    'role',
    'expectedVersion',
    'openingScenario',
    'operatingMode',
    'servicePeriodPlan',
    'simulationRuleVersion',
    'settlementCurrency',
    'businessDayId',
    'preopenSnapshotCount',
  ] as const) {
    if (row[key] !== first[key]) throw new Error('authority rows disagree');
  }
  if (
    row.playerId !== scope.playerId ||
    row.membershipId !== scope.membershipId ||
    row.tenantId !== scope.tenantId ||
    row.saveId !== scope.saveId ||
    row.role !== scope.role
  ) {
    throw new Error('authority scope changed after audit');
  }
}

function openingScenario(value: unknown): OpeningScenario {
  return exactOneOf(value, ['EMPTY_PREMISES', 'DEFAULT_SMALL_SHOP', 'TROUBLED_SHOP']);
}

function exactOneOf<const T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error('unexpected authority scalar');
  }
  return value as T;
}

function nonEmpty(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new Error('invalid persisted identifier');
  }
  return value;
}

function databaseInteger(value: unknown): number {
  const parsed =
    typeof value === 'bigint'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? BigInt(value)
        : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)
          ? BigInt(value)
          : undefined;
  if (parsed === undefined || parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('invalid non-negative database integer');
  }
  return Number(parsed);
}

function projectionUnavailable(): CommandError {
  return new CommandError(503, 'PREOPEN_CONFIGURATION_CHOICES_UNAVAILABLE');
}
