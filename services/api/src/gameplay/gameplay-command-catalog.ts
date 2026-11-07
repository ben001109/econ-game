import type { MembershipRole } from '../auth/authorization.js';

/**
 * The intentionally small P0 command surface for one invitee's isolated restaurant.
 * This is a data-only catalog: D02 registration and runtime dispatch remain separate.
 */
export const GAMEPLAY_COMMAND_CATALOG_VERSION = 'p0-gameplay-command-catalog/v1' as const;

export const gameplayCommandTypes = [
  'INITIALIZE_COMPETITIVE_SAVE',
  'CONFIGURE_PREOPEN_DAY',
  'OPEN_BUSINESS_DAY',
  'ADVANCE_SERVICE_PERIOD',
  'SETTLE_BUSINESS_DAY',
  'REQUEST_DAY_REPLAY',
] as const;

export type GameplayCommandType = (typeof gameplayCommandTypes)[number];

export type GameplayCommandProjection = Readonly<{
  source: 'SERVER_DERIVED';
  includes: readonly string[];
  job: Readonly<{
    required: boolean;
    acceptedStatus: 200 | 202;
    projection: 'NONE' | 'DAY_REPLAY';
  }>;
}>;

export type GameplayCommandCatalogEntry = Readonly<{
  commandType: GameplayCommandType;
  allowedRoles: readonly MembershipRole[];
  projection: GameplayCommandProjection;
  clientForbiddenAuthorityFields: readonly string[];
  clientNonAuthoritativeInputs: readonly string[];
}>;

/**
 * This is a catalog classification, not runtime validation. These values may appear in
 * an audited server result, but a client payload cannot establish their authority.
 */
const clientForbiddenAuthorityFields = Object.freeze([
  'actor',
  'actorId',
  'playerId',
  'tenant',
  'tenantId',
  'restaurant',
  'restaurantId',
  'save',
  'membershipId',
  'role',
  'roles',
  'permissions',
  'seed',
  'demandSeed',
  'scheduleSeed',
  'simulationSeed',
  'ruleVersion',
  'version',
  'aggregateVersion',
  'money',
  'cashBalance',
  'revenue',
  'expense',
  'profit',
  'risk',
  'riskState',
  'forecast',
  'scheduledParties',
  'customerArrivals',
  'demandConvertedParties',
  'capacity',
  'flowMetrics',
  'queueDelay',
  'frontServiceDelayTicks',
  'congestion',
  'queueVisibility',
  'flowRiskHigh',
  'foodQuality',
  'serviceSpeed',
  'reputation',
  'preopenSnapshot',
  'menuSnapshot',
  'menu',
  'menuId',
  'prices',
  'price',
  'prepSnapshot',
  'prep',
  'layoutSnapshot',
  'layout',
] as const);

/** D02 accepts these as request inputs, but the server validates them against trusted scope/state. */
const clientNonAuthoritativeInputs = Object.freeze(['saveId', 'expectedVersion'] as const);

function serverProjection(
  includes: readonly string[],
  job: GameplayCommandProjection['job'],
): GameplayCommandProjection {
  return Object.freeze({
    source: 'SERVER_DERIVED' as const,
    includes: Object.freeze([...includes]),
    job: Object.freeze({ ...job }),
  });
}

function entry(
  commandType: GameplayCommandType,
  allowedRoles: readonly MembershipRole[],
  includes: readonly string[],
  job: GameplayCommandProjection['job'],
): GameplayCommandCatalogEntry {
  return Object.freeze({
    commandType,
    allowedRoles: Object.freeze([...allowedRoles]),
    projection: serverProjection(includes, job),
    clientForbiddenAuthorityFields,
    clientNonAuthoritativeInputs,
  });
}

/**
 * Fixed canonical order is part of the P0 contract. A qualifying invitee has exactly
 * one isolated restaurant, a server-audited active OWNER membership, and one save.
 * Operational MANAGER roles, when present, are server-provisioned additional active
 * operators: clients cannot create them, they never replace or alter OWNER ownership,
 * and the server validates them against the same scoped save.
 */
export const gameplayCommandCatalog: readonly GameplayCommandCatalogEntry[] = Object.freeze([
  entry(
    'INITIALIZE_COMPETITIVE_SAVE',
    ['OWNER'],
    ['competitiveSave', 'openingSnapshot', 'activeMembershipAudit'],
    { required: false, acceptedStatus: 200, projection: 'NONE' },
  ),
  entry('CONFIGURE_PREOPEN_DAY', ['OWNER', 'MANAGER'], ['competitiveSave', 'preopenDaySnapshot'], {
    required: false,
    acceptedStatus: 200,
    projection: 'NONE',
  }),
  entry(
    'OPEN_BUSINESS_DAY',
    ['OWNER', 'MANAGER'],
    ['competitiveSave', 'businessDay', 'preopenDaySnapshot', 'demandForecast'],
    { required: false, acceptedStatus: 200, projection: 'NONE' },
  ),
  entry(
    'ADVANCE_SERVICE_PERIOD',
    ['OWNER', 'MANAGER'],
    ['competitiveSave', 'businessDay', 'servicePeriod', 'serviceState', 'reputation'],
    { required: false, acceptedStatus: 200, projection: 'NONE' },
  ),
  entry(
    'SETTLE_BUSINESS_DAY',
    ['OWNER', 'MANAGER'],
    ['competitiveSave', 'dayEndSnapshot', 'ledgerSummary', 'riskState', 'reputation'],
    { required: false, acceptedStatus: 200, projection: 'NONE' },
  ),
  entry(
    'REQUEST_DAY_REPLAY',
    ['OWNER', 'MANAGER'],
    ['competitiveSave', 'replayAvailability', 'eventHash', 'snapshotHash'],
    { required: true, acceptedStatus: 202, projection: 'DAY_REPLAY' },
  ),
]);
