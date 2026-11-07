import { createHash } from 'node:crypto';

import type {
  DemandGroup,
  DemandSchedule,
  ServicePeriod,
  ServicePeriodPlan,
} from '../domains/demand-flow/demand-flow.js';
import {
  FLOOR_FLOW_SERVICE_PROFILE_VERSION,
  FIRST_DAY_SPACE_CATALOG_VERSION,
  type FloorFlowServiceProfile,
} from '../domains/demand-flow/demand-flow.js';
import type {
  NpcContractSnapshot,
  OpeningSnapshot,
} from '../domains/opening-scenario/snapshot.js';
import type {
  CatalogSubstitution,
  RecipeVersion,
} from '../domains/inventory-procurement/catalog-menu.js';
import {
  assertInventoryCostPoolInvariant,
  completeReservedOrder,
  reserveRecipeIngredients,
  type InventoryState,
  type OrderIngredientReservation,
} from '../domains/inventory-procurement/inventory.js';
import {
  F_WORK,
  K_WORK,
  applyFloorFlowServiceProfile,
  calculateWorkCapacity,
  simulateServiceDay,
  type CompletedOrder,
  type EquipmentSnapshot,
  type RecipeServiceSnapshot,
  type ReplayEvent,
  type Reputation,
  type ServiceDayInput,
  type ServiceInventoryAuthority,
  type ServiceInventoryOrderOutcome,
  type WorkerSnapshot,
} from '../domains/service-quality/service-quality.js';

export const ADVANCE_SERVICE_PERIOD_INPUT_VERSION =
  'gameplay.advance-service-period.input/v1' as const;
export const ADVANCE_SERVICE_PERIOD_RESULT_VERSION =
  'gameplay.advance-service-period.result/v1' as const;

export type OwnerAssignment = 'KITCHEN' | 'FRONT' | 'NONE';
export type AdvanceInitiatorRole = 'OWNER' | 'MANAGER';

export type AdvanceServicePeriodIntent = Readonly<{
  businessDay: 1;
  expectedPeriodKey: ServicePeriod;
  ownerAssignment: OwnerAssignment;
}>;

export type AdvanceServicePeriodAuthority = Readonly<{
  businessDay: 1;
  servicePeriodPlan: ServicePeriodPlan;
  initiator: Readonly<{ actorId: string; role: AdvanceInitiatorRole }>;
  npcContracts: readonly NpcContractSnapshot[];
  demandSchedule: DemandSchedule;
  recipes: readonly RecipeServiceSnapshot[];
  inventoryState: InventoryState;
  recipeVersions: readonly RecipeVersion[];
  enabledSubstitutions: readonly CatalogSubstitution[];
  equipment: EquipmentSnapshot;
  kitchenExecutionQualityModifier: number;
  floorFlowServiceProfile: FloorFlowServiceProfile;
  /** Immutable E01 opening baseline; required only for ordinal 1. */
  openingReputation?: OpeningSnapshot['reputation'];
  previousResult?: AdvanceServicePeriodResultSnapshot;
}>;

type PeriodWindow = Readonly<{ start: number; end: number }>;

export type AdvanceServicePeriodInputPayload = Readonly<{
  version: typeof ADVANCE_SERVICE_PERIOD_INPUT_VERSION;
  businessDay: 1;
  servicePeriodPlan: ServicePeriodPlan;
  periodKey: ServicePeriod;
  ordinal: number;
  completedPeriodKeysBefore: readonly ServicePeriod[];
  previousResultHash: string | null;
  ownerAssignment: OwnerAssignment;
  initiator: Readonly<{ actorId: string; role: AdvanceInitiatorRole }>;
  demandSeed: string;
  periodWindow: PeriodWindow;
  arrivals: readonly DemandGroup[];
  recipes: readonly RecipeServiceSnapshot[];
  inventoryState: InventoryState;
  recipeVersions: readonly RecipeVersion[];
  enabledSubstitutions: readonly CatalogSubstitution[];
  workers: readonly WorkerSnapshot[];
  equipment: EquipmentSnapshot;
  kitchenExecutionQualityModifier: number;
  floorFlowServiceProfile: FloorFlowServiceProfile;
  initialReputation: Reputation;
  eventSequenceStart: number;
  kitchenCapacity: number;
  frontCapacity: number;
  admissionEnabled: boolean;
  closingTickCeiling: number;
}>;

export type AdvanceServicePeriodInputSnapshot = Readonly<
  AdvanceServicePeriodInputPayload & { inputHash: string }
>;

export type AdvanceServicePeriodResultPayload = Readonly<{
  version: typeof ADVANCE_SERVICE_PERIOD_RESULT_VERSION;
  inputHash: string;
  businessDay: 1;
  servicePeriodPlan: ServicePeriodPlan;
  periodKey: ServicePeriod;
  ordinal: number;
  completedPeriodKeys: readonly ServicePeriod[];
  ownerAssignment: OwnerAssignment;
  workerRoster: readonly WorkerSnapshot[];
  kitchenCapacity: number;
  frontCapacity: number;
  admissionEnabled: boolean;
  orders: readonly CompletedOrder[];
  departedGroupIds: readonly string[];
  waitingGroupIds: readonly string[];
  inventoryState: InventoryState;
  inventoryOutcomes: readonly ServiceInventoryOrderOutcome[];
  reputation: Reputation;
  flowRiskHigh: boolean;
  events: readonly ReplayEvent[];
  eventSequenceStart: number;
  nextEventSequence: number;
  closingTicks: number;
  lastTick: number;
  status: 'PERIOD_COMPLETE';
}>;

export type AdvanceServicePeriodResultSnapshot = Readonly<
  AdvanceServicePeriodResultPayload & { resultHash: string }
>;

export type AdvanceServicePeriodExecution = Readonly<{
  inputSnapshot: AdvanceServicePeriodInputSnapshot;
  resultSnapshot: AdvanceServicePeriodResultSnapshot;
}>;

const periodsByPlan = Object.freeze({
  TWO_PERIODS: Object.freeze(['LUNCH', 'DINNER'] as const),
  THREE_PERIODS: Object.freeze(['LUNCH', 'OFF_PEAK', 'DINNER'] as const),
} satisfies Readonly<Record<ServicePeriodPlan, readonly ServicePeriod[]>>);

const windowsByPlan = Object.freeze({
  TWO_PERIODS: Object.freeze({
    LUNCH: Object.freeze({ start: 0, end: 9 }),
    DINNER: Object.freeze({ start: 10, end: 19 }),
  }),
  THREE_PERIODS: Object.freeze({
    LUNCH: Object.freeze({ start: 0, end: 7 }),
    OFF_PEAK: Object.freeze({ start: 8, end: 11 }),
    DINNER: Object.freeze({ start: 12, end: 19 }),
  }),
} satisfies Readonly<
  Record<ServicePeriodPlan, Readonly<Partial<Record<ServicePeriod, PeriodWindow>>>>
>);

const ownerAssignments = new Set<OwnerAssignment>(['KITCHEN', 'FRONT', 'NONE']);
const servicePeriods = new Set<ServicePeriod>(['LUNCH', 'OFF_PEAK', 'DINNER']);
const initiatorRoles = new Set<AdvanceInitiatorRole>(['OWNER', 'MANAGER']);
const sha256Pattern = /^[a-f0-9]{64}$/;
const MAX_DERIVED_CLOSING_TICKS = 10_000;

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function plainRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${name} must be a plain data record`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new Error(`${name}.${key} must be a data property`);
  }
}

function compareCodeUnitStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  plainRecord(value, name);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} contains unknown or missing fields`);
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodeUnitStrings(left, right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function canonicalHash(value: object): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

function canonicalString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} must be a non-empty canonical string`);
  }
  return value;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function cloneReputation(value: Reputation): Reputation {
  return deepFreeze({ ...value });
}

function periodWindow(plan: ServicePeriodPlan, period: ServicePeriod): PeriodWindow {
  const windows = windowsByPlan[plan] as Readonly<Partial<Record<ServicePeriod, PeriodWindow>>>;
  const window = windows[period];
  if (window === undefined) throw new Error(`${period} is not part of ${plan}`);
  return window;
}

export function parseAdvanceServicePeriodIntent(value: unknown): AdvanceServicePeriodIntent {
  const input = exactRecord(
    value,
    ['businessDay', 'expectedPeriodKey', 'ownerAssignment'],
    'ADVANCE_SERVICE_PERIOD intent',
  );
  if (input.businessDay !== 1) throw new Error('ADVANCE_SERVICE_PERIOD accepts only business day 1');
  if (!servicePeriods.has(input.expectedPeriodKey as ServicePeriod)) {
    throw new Error('expectedPeriodKey is not a supported service period');
  }
  if (!ownerAssignments.has(input.ownerAssignment as OwnerAssignment)) {
    throw new Error('ownerAssignment must be KITCHEN, FRONT, or NONE');
  }
  return deepFreeze({
    businessDay: 1,
    expectedPeriodKey: input.expectedPeriodKey as ServicePeriod,
    ownerAssignment: input.ownerAssignment as OwnerAssignment,
  });
}

function assertCanonicalResult(result: AdvanceServicePeriodResultSnapshot): void {
  exactRecord(
    result,
    [
      'admissionEnabled',
      'businessDay',
      'closingTicks',
      'completedPeriodKeys',
      'departedGroupIds',
      'eventSequenceStart',
      'events',
      'flowRiskHigh',
      'frontCapacity',
      'inputHash',
      'inventoryOutcomes',
      'inventoryState',
      'kitchenCapacity',
      'lastTick',
      'nextEventSequence',
      'ordinal',
      'orders',
      'ownerAssignment',
      'periodKey',
      'reputation',
      'resultHash',
      'servicePeriodPlan',
      'status',
      'version',
      'waitingGroupIds',
      'workerRoster',
    ],
    'previous ADVANCE_SERVICE_PERIOD result',
  );
  if (result.version !== ADVANCE_SERVICE_PERIOD_RESULT_VERSION || result.status !== 'PERIOD_COMPLETE') {
    throw new Error('previous service-period result version or status is unsupported');
  }
  if (!sha256Pattern.test(result.resultHash)) {
    throw new Error('previous service-period result hash is invalid');
  }
  const { resultHash, ...payload } = result;
  if (canonicalHash(payload) !== resultHash) {
    throw new Error('previous service-period result hash does not match its private payload');
  }
  assertCanonicalInventoryBoundary(result.inventoryState, 'previous E03 inventory result');
  const outcomeOrderIds = new Set<string>();
  for (const outcome of result.inventoryOutcomes) {
    if (
      outcomeOrderIds.has(outcome.orderId) ||
      !result.orders.some(
        (order) =>
          order.id === outcome.orderId &&
          order.recipeId === outcome.recipeId &&
          order.state === 'SERVED',
      )
    ) {
      throw new Error('previous E03 order outcomes do not map one-to-one to served orders');
    }
    outcomeOrderIds.add(outcome.orderId);
  }
  if (result.orders.filter((order) => order.state === 'SERVED').length !== outcomeOrderIds.size) {
    throw new Error('previous E03 order outcomes are incomplete');
  }
  if (result.completedPeriodKeys.length !== result.ordinal) {
    throw new Error('previous completed service-period prefix is invalid');
  }
  const canonical = periodsByPlan[result.servicePeriodPlan];
  if (
    canonical === undefined ||
    result.completedPeriodKeys.some((period, index) => period !== canonical[index]) ||
    result.periodKey !== result.completedPeriodKeys.at(-1)
  ) {
    throw new Error('previous result is not a canonical period-plan prefix');
  }
  if (
    !Number.isSafeInteger(result.eventSequenceStart) ||
    !Number.isSafeInteger(result.nextEventSequence) ||
    result.nextEventSequence !== result.eventSequenceStart + result.events.length ||
    result.events.some(
      (event, index) =>
        event.sequence !== result.eventSequenceStart + index,
    )
  ) {
    throw new Error('previous service-period event sequence is discontinuous');
  }
}

function validateEquipment(equipment: EquipmentSnapshot): void {
  if (
    (equipment.kitchen !== 'BASIC' && equipment.kitchen !== 'AGED') ||
    (equipment.front !== 'BASIC' && equipment.front !== 'AGED')
  ) {
    throw new Error('service-period equipment must use BASIC or AGED conditions');
  }
}

function validateFloorFlowProfile(profile: FloorFlowServiceProfile): void {
  if (
    profile.version !== FLOOR_FLOW_SERVICE_PROFILE_VERSION ||
    profile.spaceCatalogVersion !== FIRST_DAY_SPACE_CATALOG_VERSION ||
    !Number.isSafeInteger(profile.layoutRevision) ||
    profile.layoutRevision <= 0 ||
    !sha256Pattern.test(profile.layoutHash) ||
    !Number.isSafeInteger(profile.seatCapacity) ||
    profile.seatCapacity < 0 ||
    !Number.isSafeInteger(profile.waitingCapacity) ||
    profile.waitingCapacity < 0 ||
    !Number.isFinite(profile.queueVisibility) ||
    profile.queueVisibility < 0 ||
    profile.queueVisibility > 1 ||
    !Number.isSafeInteger(profile.frontServiceDelayTicks) ||
    profile.frontServiceDelayTicks < 0
  ) {
    throw new Error('service-period floor-flow profile is invalid or unsupported');
  }
}

function openingServiceReputation(value: unknown): Reputation {
  const reputation = exactRecord(
    value,
    ['dimensions', 'overall', 'overallRounding'],
    'E01 opening reputation',
  );
  const dimensions = exactRecord(
    reputation.dimensions,
    ['FAIRNESS', 'PRICE', 'QUALITY', 'SPEED', 'VIBE'],
    'E01 opening reputation dimensions',
  );
  const scores = ['PRICE', 'SPEED', 'QUALITY', 'FAIRNESS', 'VIBE'].map((dimension) =>
    finite(dimensions[dimension], `E01 ${dimension} reputation`),
  );
  if (
    scores.some((score) => score < 0 || score > 100) ||
    reputation.overallRounding !== 'ROUND_HALF_UP' ||
    !Number.isInteger(reputation.overall) ||
    reputation.overall !== Math.floor(scores.reduce((sum, score) => sum + score, 0) / 5 + 0.5)
  ) {
    throw new Error('E01 opening reputation is not a canonical five-dimension baseline');
  }
  return deepFreeze({
    price: scores[0]!,
    speed: scores[1]!,
    quality: scores[2]!,
    fairness: scores[3]!,
    vibe: scores[4]!,
  });
}

function npcWorkers(contracts: readonly NpcContractSnapshot[]): readonly WorkerSnapshot[] {
  const ids = new Set<string>();
  const contractKeys = new Set<string>();
  return contracts
    .map((contract) => {
      const contractKey = canonicalString(contract.contractKey, 'NPC contract key');
      if (contractKeys.has(contractKey)) throw new Error('NPC contract keys must be unique');
      contractKeys.add(contractKey);
      const npcKey = canonicalString(contract.npcKey, 'NPC key');
      if (ids.has(npcKey)) throw new Error('NPC keys must be unique');
      ids.add(npcKey);
      if (
        (contract.role !== 'KITCHEN' && contract.role !== 'CASHIER') ||
        contract.capability !== 'MEDIUM' ||
        (contract.morale !== 'NORMAL' && contract.morale !== 'LOW') ||
        contract.shiftCoverage !== 'ALL_LOCKED_SERVICE_PERIODS' ||
        contract.effectiveCompletedBusinessDay !== 1 ||
        contract.endCompletedBusinessDay !== 30
      ) {
        throw new Error('NPC contract is not an active canonical first-day shift');
      }
      return deepFreeze({
        id: npcKey,
        role: contract.role === 'KITCHEN' ? ('KITCHEN_STAFF' as const) : ('CASHIER' as const),
        ability: contract.capability,
        morale: contract.morale,
        kind: 'NPC' as const,
        present: true,
      });
    })
    .sort((left, right) => compareCodeUnitStrings(left.id, right.id));
}

function playerWorker(
  initiator: AdvanceServicePeriodAuthority['initiator'],
  assignment: OwnerAssignment,
): WorkerSnapshot | undefined {
  const actorId = canonicalString(initiator.actorId, 'initiator actor ID');
  if (!initiatorRoles.has(initiator.role)) throw new Error('initiator must be OWNER or MANAGER');
  if (assignment === 'NONE') return undefined;
  const role = playerRole(initiator.role, assignment);
  if (role === undefined) return undefined;
  return deepFreeze({
    id: `player:${actorId}`,
    role,
    ability: 'MEDIUM',
    morale: 'NORMAL',
    kind: 'PLAYER',
    present: true,
  });
}

function playerRole(
  initiatorRole: AdvanceInitiatorRole,
  assignment: OwnerAssignment,
): WorkerSnapshot['role'] | undefined {
  if (assignment === 'NONE') return undefined;
  return (
    assignment === 'KITCHEN'
      ? initiatorRole === 'OWNER'
        ? 'OWNER_KITCHEN'
        : 'MANAGER_KITCHEN'
      : initiatorRole === 'OWNER'
        ? 'OWNER_FRONT'
        : 'MANAGER_FRONT'
  );
}

function clonePlainData(value: unknown, name: string): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`${name} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => clonePlainData(entry, `${name}[${index}]`));
  }
  plainRecord(value, name);
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, clonePlainData(nested, `${name}.${key}`)]),
  );
}

function cloneInventoryState(value: InventoryState): InventoryState {
  return deepFreeze(clonePlainData(value, 'E03 inventory state')) as InventoryState;
}

function cloneRecipeVersion(value: RecipeVersion): RecipeVersion {
  return deepFreeze(clonePlainData(value, `E03 recipe ${value.id}`)) as RecipeVersion;
}

function cloneSubstitution(value: CatalogSubstitution): CatalogSubstitution {
  return deepFreeze(clonePlainData(value, `E03 substitution ${value.id}`)) as CatalogSubstitution;
}

function assertCanonicalInventoryBoundary(state: InventoryState, name: string): void {
  exactRecord(
    state,
    ['capacity', 'currency', 'orderReservations', 'reservedUndelivered', 'stocks', 'transactions'],
    name,
  );
  if (!/^[A-Z]{3}$/.test(state.currency)) throw new Error(`${name} currency is invalid`);
  if (
    !Number.isSafeInteger(state.capacity.DURABLE) ||
    state.capacity.DURABLE < 0 ||
    !Number.isSafeInteger(state.capacity.PERISHABLE) ||
    state.capacity.PERISHABLE < 0
  ) {
    throw new Error(`${name} capacity is invalid`);
  }
  if (
    state.orderReservations.length !== 0 ||
    state.stocks.some((stock) => stock.reservedPoints !== 0)
  ) {
    throw new Error(`${name} must not contain an open order reservation`);
  }
  const stockIds = state.stocks.map((stock) => canonicalString(stock.ingredientId, 'stock ingredient ID'));
  if (
    new Set(stockIds).size !== stockIds.length ||
    stockIds.some((id, index) => index > 0 && compareCodeUnitStrings(stockIds[index - 1]!, id) > 0)
  ) {
    throw new Error(`${name} stocks must have unique canonical ordering`);
  }
  const transactionGroups = new Map<string, { type: string; referenceId: string }>();
  for (const [index, transaction] of state.transactions.entries()) {
    if (transaction.sequence !== index + 1) {
      throw new Error(`${name} transaction sequence is discontinuous`);
    }
    const transactionId = canonicalString(transaction.transactionId, 'inventory transaction ID');
    const referenceId = canonicalString(transaction.referenceId, 'inventory reference ID');
    const prior = transactionGroups.get(transactionId);
    if (prior !== undefined && (prior.type !== transaction.type || prior.referenceId !== referenceId)) {
      throw new Error(`${name} reuses an inventory transaction ID across mutations`);
    }
    transactionGroups.set(transactionId, { type: transaction.type, referenceId });
  }
  assertInventoryCostPoolInvariant(state);
}

function canonicalE03Authority(
  serviceRecipes: readonly RecipeServiceSnapshot[],
  recipeVersionsValue: readonly RecipeVersion[],
  substitutionsValue: readonly CatalogSubstitution[],
): Readonly<{
  serviceRecipes: readonly RecipeServiceSnapshot[];
  recipeVersions: readonly RecipeVersion[];
  substitutions: readonly CatalogSubstitution[];
}> {
  const serviceRecipesSorted = serviceRecipes
    .map((recipe) => deepFreeze({ ...recipe }))
    .sort((left, right) => compareCodeUnitStrings(left.id, right.id));
  const recipeVersions = recipeVersionsValue
    .map(cloneRecipeVersion)
    .sort((left, right) => compareCodeUnitStrings(left.id, right.id));
  const substitutions = substitutionsValue
    .map(cloneSubstitution)
    .sort((left, right) => left.priority - right.priority || compareCodeUnitStrings(left.id, right.id));
  const serviceIds = serviceRecipesSorted.map((recipe) => recipe.id);
  const recipeIds = recipeVersions.map((recipe) => recipe.id);
  if (
    new Set(serviceIds).size !== serviceIds.length ||
    new Set(recipeIds).size !== recipeIds.length ||
    serviceIds.length === 0 ||
    serviceIds.length !== recipeIds.length ||
    serviceIds.some((id, index) => id !== recipeIds[index])
  ) {
    throw new Error('E03 recipe versions must map exactly the canonical service recipes');
  }
  const recipeById = new Map(recipeVersions.map((recipe) => [recipe.id, recipe]));
  for (const serviceRecipe of serviceRecipesSorted) {
    const recipeVersion = recipeById.get(serviceRecipe.id)!;
    if (
      serviceRecipe.baseQuality !== recipeVersion.baseQuality ||
      serviceRecipe.substitutionQualityDelta !== 0 ||
      recipeVersion.ingredients.length === 0 ||
      new Set(recipeVersion.ingredients.map((item) => item.ingredientId)).size !==
        recipeVersion.ingredients.length ||
      recipeVersion.ingredients.some(
        (item) =>
          canonicalString(item.ingredientId, 'recipe ingredient ID').length === 0 ||
          !Number.isSafeInteger(item.quantityPoints) ||
          item.quantityPoints <= 0,
      )
    ) {
      throw new Error('service recipe does not match its canonical E03 recipe version');
    }
  }
  const substitutionIds = new Set<string>();
  for (const substitution of substitutions) {
    if (
      substitutionIds.has(substitution.id) ||
      !recipeById.has(substitution.recipeVersionId) ||
      !Number.isSafeInteger(substitution.priority) ||
      substitution.priority < 0 ||
      !Number.isInteger(substitution.qualityDelta) ||
      substitution.qualityDelta < -10 ||
      substitution.qualityDelta > 0 ||
      substitution.ingredients.length === 0 ||
      new Set(substitution.ingredients.map((item) => item.ingredientId)).size !==
        substitution.ingredients.length ||
      substitution.ingredients.some(
        (item) =>
          canonicalString(item.ingredientId, 'substitution ingredient ID').length === 0 ||
          !Number.isSafeInteger(item.quantityPoints) ||
          item.quantityPoints <= 0,
      )
    ) {
      throw new Error('enabled substitution is not scope-compatible with the active E03 recipes');
    }
    substitutionIds.add(canonicalString(substitution.id, 'substitution ID'));
  }
  return deepFreeze({
    serviceRecipes: serviceRecipesSorted,
    recipeVersions,
    substitutions,
  });
}

function validateDemandAuthority(authority: AdvanceServicePeriodAuthority): void {
  const schedule = authority.demandSchedule;
  if (
    schedule.day !== 1 ||
    schedule.periodPlan !== authority.servicePeriodPlan ||
    schedule.actualDemandGroups !== schedule.groups.length ||
    schedule.demandSeed.length === 0 ||
    schedule.demandSeed.trim() !== schedule.demandSeed
  ) {
    throw new Error('demand schedule does not match first-day service-period authority');
  }
  const groupIds = new Set<string>();
  for (const group of schedule.groups) {
    if (groupIds.has(group.groupId)) throw new Error('demand schedule group IDs must be unique');
    groupIds.add(group.groupId);
    const window = periodWindow(authority.servicePeriodPlan, group.period);
    if (group.arrivalTick < window.start || group.arrivalTick > window.end) {
      throw new Error('demand group arrival falls outside its canonical period window');
    }
    if (!Number.isInteger(group.hiddenPatienceTicks) || group.hiddenPatienceTicks <= 0) {
      throw new Error('demand group requires positive integer hidden patience');
    }
  }
}

function deriveClosingTickCeiling(
  arrivals: readonly DemandGroup[],
  kitchenCapacity: number,
  frontCapacity: number,
  admissionEnabled: boolean,
  frontDelay: number,
): number {
  const maxPatience = arrivals.reduce((maximum, group) => Math.max(maximum, group.hiddenPatienceTicks), 0);
  if (!admissionEnabled) return maxPatience + 1;
  const orderUpperBound = arrivals.length;
  const kitchenTicks = Math.ceil((orderUpperBound * K_WORK) / kitchenCapacity);
  const frontTicks = Math.ceil((orderUpperBound * F_WORK) / frontCapacity);
  const ceiling = maxPatience + kitchenTicks + frontTicks + frontDelay + 3;
  if (!Number.isSafeInteger(ceiling) || ceiling < 0 || ceiling > MAX_DERIVED_CLOSING_TICKS) {
    throw new Error('input-derived service-period drain ceiling exceeds the supported safe bound');
  }
  return ceiling;
}

export function createAdvanceServicePeriodInput(
  intentValue: unknown,
  authority: AdvanceServicePeriodAuthority,
): AdvanceServicePeriodInputSnapshot {
  const intent = parseAdvanceServicePeriodIntent(intentValue);
  if (authority.businessDay !== 1 || intent.businessDay !== authority.businessDay) {
    throw new Error('ADVANCE_SERVICE_PERIOD business day is stale');
  }
  if (!(authority.servicePeriodPlan in periodsByPlan)) throw new Error('unknown service period plan');
  validateDemandAuthority(authority);
  validateEquipment(authority.equipment);
  validateFloorFlowProfile(authority.floorFlowServiceProfile);
  const e03 = canonicalE03Authority(
    authority.recipes,
    authority.recipeVersions,
    authority.enabledSubstitutions,
  );
  const authorityInventory = cloneInventoryState(authority.inventoryState);
  assertCanonicalInventoryBoundary(authorityInventory, 'E03 service-period inventory authority');

  const canonicalPeriods = periodsByPlan[authority.servicePeriodPlan];
  let completedPeriodKeysBefore: readonly ServicePeriod[] = [];
  let previousResultHash: string | null = null;
  let initialReputation: Reputation;
  let eventSequenceStart = 0;
  let inventoryState = authorityInventory;
  if (authority.previousResult !== undefined) {
    assertCanonicalResult(authority.previousResult);
    if (
      authority.previousResult.businessDay !== authority.businessDay ||
      authority.previousResult.servicePeriodPlan !== authority.servicePeriodPlan
    ) {
      throw new Error('previous result belongs to a different business day or period plan');
    }
    completedPeriodKeysBefore = [...authority.previousResult.completedPeriodKeys];
    previousResultHash = authority.previousResult.resultHash;
    initialReputation = authority.previousResult.reputation;
    eventSequenceStart = authority.previousResult.nextEventSequence;
    if (canonicalHash(authorityInventory) !== canonicalHash(authority.previousResult.inventoryState)) {
      throw new Error('later service periods must resume only from the prior E03 inventory result');
    }
    inventoryState = cloneInventoryState(authority.previousResult.inventoryState);
  } else {
    if (authority.openingReputation === undefined) {
      throw new Error('ordinal 1 requires immutable E01 opening reputation authority');
    }
    initialReputation = openingServiceReputation(authority.openingReputation);
  }
  const periodKey = canonicalPeriods[completedPeriodKeysBefore.length];
  if (periodKey === undefined) throw new Error('all service periods are already complete');
  if (intent.expectedPeriodKey !== periodKey) {
    throw new Error('expectedPeriodKey is stale or out of canonical order');
  }

  const npcs = npcWorkers(authority.npcContracts);
  const player = playerWorker(authority.initiator, intent.ownerAssignment);
  if (player !== undefined && npcs.some((npc) => npc.id === player.id)) {
    throw new Error('initiator identity collides with a canonical NPC identity');
  }
  const workers = deepFreeze(player === undefined ? [...npcs] : [...npcs, player]);
  const authorizedPlayerIds = player === undefined ? [] : [player.id];
  const equipment = deepFreeze({ ...authority.equipment });
  const kitchenCapacity = calculateWorkCapacity(
    workers,
    'KITCHEN',
    equipment,
    authorizedPlayerIds,
  );
  const frontCapacity = calculateWorkCapacity(workers, 'FRONT', equipment, authorizedPlayerIds);
  const admissionEnabled = kitchenCapacity > 0 && frontCapacity > 0;
  const arrivals = deepFreeze(
    authority.demandSchedule.groups
      .filter((group) => group.period === periodKey)
      .map((group) => deepFreeze({ ...group, recipePreferenceOrder: deepFreeze([...group.recipePreferenceOrder]) })),
  );
  const recipes = e03.serviceRecipes;
  const window = periodWindow(authority.servicePeriodPlan, periodKey);
  const closingTickCeiling = deriveClosingTickCeiling(
    arrivals,
    kitchenCapacity,
    frontCapacity,
    admissionEnabled,
    authority.floorFlowServiceProfile.frontServiceDelayTicks,
  );
  finite(authority.kitchenExecutionQualityModifier, 'kitchen execution quality modifier');

  const payload: AdvanceServicePeriodInputPayload = deepFreeze({
    version: ADVANCE_SERVICE_PERIOD_INPUT_VERSION,
    businessDay: 1,
    servicePeriodPlan: authority.servicePeriodPlan,
    periodKey,
    ordinal: completedPeriodKeysBefore.length + 1,
    completedPeriodKeysBefore: deepFreeze([...completedPeriodKeysBefore]),
    previousResultHash,
    ownerAssignment: intent.ownerAssignment,
    initiator: deepFreeze({ ...authority.initiator }),
    demandSeed: authority.demandSchedule.demandSeed,
    periodWindow: deepFreeze({ ...window }),
    arrivals,
    recipes,
    inventoryState,
    recipeVersions: e03.recipeVersions,
    enabledSubstitutions: e03.substitutions,
    workers,
    equipment,
    kitchenExecutionQualityModifier: authority.kitchenExecutionQualityModifier,
    floorFlowServiceProfile: deepFreeze({ ...authority.floorFlowServiceProfile }),
    initialReputation: cloneReputation(initialReputation),
    eventSequenceStart,
    kitchenCapacity,
    frontCapacity,
    admissionEnabled,
    closingTickCeiling,
  });
  return deepFreeze({ ...payload, inputHash: canonicalHash(payload) });
}

function assertCanonicalInput(snapshot: AdvanceServicePeriodInputSnapshot): void {
  exactRecord(
    snapshot,
    [
      'admissionEnabled',
      'arrivals',
      'businessDay',
      'closingTickCeiling',
      'completedPeriodKeysBefore',
      'demandSeed',
      'enabledSubstitutions',
      'equipment',
      'eventSequenceStart',
      'floorFlowServiceProfile',
      'frontCapacity',
      'initiator',
      'inputHash',
      'inventoryState',
      'kitchenCapacity',
      'kitchenExecutionQualityModifier',
      'ordinal',
      'ownerAssignment',
      'periodKey',
      'periodWindow',
      'previousResultHash',
      'recipes',
      'recipeVersions',
      'servicePeriodPlan',
      'version',
      'workers',
      'initialReputation',
    ],
    'ADVANCE_SERVICE_PERIOD input snapshot',
  );
  const { inputHash, ...payload } = snapshot;
  if (snapshot.version !== ADVANCE_SERVICE_PERIOD_INPUT_VERSION || !sha256Pattern.test(inputHash)) {
    throw new Error('service-period input version or hash is invalid');
  }
  if (canonicalHash(payload) !== inputHash) {
    throw new Error('service-period input hash does not match its private payload');
  }
  assertCanonicalInventoryBoundary(snapshot.inventoryState, 'E03 service-period input inventory');
  const e03 = canonicalE03Authority(
    snapshot.recipes,
    snapshot.recipeVersions,
    snapshot.enabledSubstitutions,
  );
  if (
    canonicalHash({ recipes: snapshot.recipes }) !== canonicalHash({ recipes: e03.serviceRecipes }) ||
    canonicalHash({ recipeVersions: snapshot.recipeVersions }) !==
      canonicalHash({ recipeVersions: e03.recipeVersions }) ||
    canonicalHash({ substitutions: snapshot.enabledSubstitutions }) !==
      canonicalHash({ substitutions: e03.substitutions })
  ) {
    throw new Error('E03 service-period catalog arrays are not canonically ordered');
  }
  const periods = periodsByPlan[snapshot.servicePeriodPlan];
  if (
    periods === undefined ||
    snapshot.businessDay !== 1 ||
    snapshot.ordinal !== snapshot.completedPeriodKeysBefore.length + 1 ||
    snapshot.periodKey !== periods[snapshot.ordinal - 1] ||
    snapshot.completedPeriodKeysBefore.some((period, index) => period !== periods[index]) ||
    snapshot.eventSequenceStart < 0 ||
    !Number.isSafeInteger(snapshot.eventSequenceStart)
  ) {
    throw new Error('service-period input progression is invalid');
  }
  const expectedWindow = periodWindow(snapshot.servicePeriodPlan, snapshot.periodKey);
  if (
    snapshot.periodWindow.start !== expectedWindow.start ||
    snapshot.periodWindow.end !== expectedWindow.end ||
    snapshot.arrivals.some(
      (arrival) =>
        arrival.period !== snapshot.periodKey ||
        arrival.arrivalTick < expectedWindow.start ||
        arrival.arrivalTick > expectedWindow.end,
    )
  ) {
    throw new Error('service-period input does not match its canonical tick window');
  }
  const playerWorkers = snapshot.workers.filter((worker) => worker.kind === 'PLAYER');
  const expectedPlayerRole = playerRole(snapshot.initiator.role, snapshot.ownerAssignment);
  if (
    !ownerAssignments.has(snapshot.ownerAssignment) ||
    !initiatorRoles.has(snapshot.initiator.role) ||
    snapshot.initiator.actorId.length === 0 ||
    snapshot.initiator.actorId.trim() !== snapshot.initiator.actorId ||
    (snapshot.ownerAssignment === 'NONE' && playerWorkers.length !== 0) ||
    (snapshot.ownerAssignment !== 'NONE' && playerWorkers.length !== 1) ||
    snapshot.workers.some((worker) => worker.kind !== 'NPC' && worker.kind !== 'PLAYER') ||
    snapshot.workers.some(
      (worker) =>
        worker.kind === 'NPC' &&
        (worker.role !== 'KITCHEN_STAFF' && worker.role !== 'CASHIER' ||
          worker.ability !== 'MEDIUM' ||
          (worker.morale !== 'NORMAL' && worker.morale !== 'LOW') ||
          !worker.present),
    ) ||
    playerWorkers.some(
      (worker) =>
        worker.id !== `player:${snapshot.initiator.actorId}` ||
        worker.role !== expectedPlayerRole ||
        worker.ability !== 'MEDIUM' ||
        worker.morale !== 'NORMAL' ||
        !worker.present,
    )
  ) {
    throw new Error('service-period input contains a forged player roster');
  }
  validateEquipment(snapshot.equipment);
  validateFloorFlowProfile(snapshot.floorFlowServiceProfile);
  const authorizedPlayerIds = playerWorkers.map((worker) => worker.id);
  const kitchenCapacity = calculateWorkCapacity(
    snapshot.workers,
    'KITCHEN',
    snapshot.equipment,
    authorizedPlayerIds,
  );
  const frontCapacity = calculateWorkCapacity(
    snapshot.workers,
    'FRONT',
    snapshot.equipment,
    authorizedPlayerIds,
  );
  const admissionEnabled = kitchenCapacity > 0 && frontCapacity > 0;
  const ceiling = deriveClosingTickCeiling(
    snapshot.arrivals,
    kitchenCapacity,
    frontCapacity,
    admissionEnabled,
    snapshot.floorFlowServiceProfile.frontServiceDelayTicks,
  );
  if (
    snapshot.kitchenCapacity !== kitchenCapacity ||
    snapshot.frontCapacity !== frontCapacity ||
    snapshot.admissionEnabled !== admissionEnabled ||
    snapshot.closingTickCeiling !== ceiling
  ) {
    throw new Error('service-period capacity or drain authority was forged');
  }
}

type AdvanceInventoryAdapter = Readonly<{
  authority: ServiceInventoryAuthority;
  finalInventoryState: () => InventoryState;
}>;

function inventoryTransactionId(
  snapshot: AdvanceServicePeriodInputSnapshot,
  kind: 'RESERVE' | 'COMPLETE',
  orderId: string,
  recipeId: string,
): string {
  return `advance-service-period:${kind.toLowerCase()}:${canonicalHash({
    version: ADVANCE_SERVICE_PERIOD_INPUT_VERSION,
    inputHash: snapshot.inputHash,
    orderId,
    recipeId,
  })}`;
}

function createInventoryAdapter(
  snapshot: AdvanceServicePeriodInputSnapshot,
): AdvanceInventoryAdapter {
  const recipeById = new Map(snapshot.recipeVersions.map((recipe) => [recipe.id, recipe]));
  const substitutionsByRecipe = new Map<string, CatalogSubstitution[]>();
  for (const substitution of snapshot.enabledSubstitutions) {
    const entries = substitutionsByRecipe.get(substitution.recipeVersionId) ?? [];
    entries.push(substitution);
    substitutionsByRecipe.set(substitution.recipeVersionId, entries);
  }
  let inventory = cloneInventoryState(snapshot.inventoryState);
  const pending = new Map<
    string,
    Readonly<{
      reservation: OrderIngredientReservation;
      reserveTransactionId: string;
    }>
  >();
  const outcomes: ServiceInventoryOrderOutcome[] = [];
  let closed = false;

  const authority: ServiceInventoryAuthority = {
    reserveOrder(input) {
      if (closed) throw new Error('E03 inventory period is already closed');
      if (pending.has(input.orderId) || outcomes.some((outcome) => outcome.orderId === input.orderId)) {
        throw new Error('E03 inventory order identity is not unique');
      }
      for (const recipeId of input.recipePreferenceOrder) {
        const recipe = recipeById.get(recipeId);
        if (recipe === undefined) {
          throw new Error('E03 inventory preference references a non-canonical recipe');
        }
        const reserveTransactionId = inventoryTransactionId(
          snapshot,
          'RESERVE',
          input.orderId,
          recipeId,
        );
        const reservation = reserveRecipeIngredients(inventory, {
          transactionId: reserveTransactionId,
          orderId: input.orderId,
          servings: input.servings,
          recipe,
          enabledSubstitutions: substitutionsByRecipe.get(recipeId) ?? [],
        });
        if (reservation.status === 'SOLD_OUT') continue;
        inventory = reservation.inventory;
        pending.set(
          input.orderId,
          deepFreeze({ reservation: reservation.reservation, reserveTransactionId }),
        );
        return deepFreeze({
          status: 'RESERVED' as const,
          recipeId,
          substitutionQualityDelta: reservation.reservation.qualityDelta,
        });
      }
      return deepFreeze({ status: 'SOLD_OUT' as const });
    },
    completeOrder(orderId) {
      if (closed) throw new Error('E03 inventory period is already closed');
      const selected = pending.get(orderId);
      if (selected === undefined) {
        throw new Error('served order does not have an E03 ingredient reservation');
      }
      const completeTransactionId = inventoryTransactionId(
        snapshot,
        'COMPLETE',
        orderId,
        selected.reservation.recipeVersionId,
      );
      const completed = completeReservedOrder(inventory, completeTransactionId, orderId);
      inventory = completed.inventory;
      pending.delete(orderId);
      const outcome: ServiceInventoryOrderOutcome = deepFreeze({
        orderId,
        recipeId: selected.reservation.recipeVersionId,
        servings: selected.reservation.servings,
        substitutionId: selected.reservation.substitutionId,
        substitutionQualityDelta: selected.reservation.qualityDelta,
        reserveTransactionId: selected.reserveTransactionId,
        completeTransactionId,
        cogs: deepFreeze({ ...completed.cogs }),
        consumed: deepFreeze(
          completed.consumed.map((item) =>
            deepFreeze({ ...item, cost: deepFreeze({ ...item.cost }) }),
          ),
        ),
      });
      outcomes.push(outcome);
      return outcome;
    },
    closePeriod() {
      if (closed) throw new Error('E03 inventory period closure may run only once');
      if (
        pending.size !== 0 ||
        inventory.orderReservations.length !== 0 ||
        inventory.stocks.some((stock) => stock.reservedPoints !== 0)
      ) {
        throw new Error('E03 inventory period cannot close with an open reservation');
      }
      assertInventoryCostPoolInvariant(inventory);
      closed = true;
      return deepFreeze({ outcomes: deepFreeze([...outcomes]) });
    },
  };
  return deepFreeze({
    authority,
    finalInventoryState() {
      if (!closed) throw new Error('E03 final inventory is unavailable before period closure');
      return cloneInventoryState(inventory);
    },
  });
}

function serviceInput(
  snapshot: AdvanceServicePeriodInputSnapshot,
  closingTicks: number,
  inventoryAuthority: ServiceInventoryAuthority,
): ServiceDayInput {
  const playerIds = snapshot.workers
    .filter((worker) => worker.kind === 'PLAYER')
    .map((worker) => worker.id);
  const operationalTicks = Array.from(
    { length: snapshot.periodWindow.end - snapshot.periodWindow.start + 1 },
    (_, index) => snapshot.periodWindow.start + index,
  );
  const ticks = [
    ...operationalTicks.map((tick) => ({
      tick,
      admissionCapacity: snapshot.admissionEnabled ? snapshot.arrivals.length : 0,
      demand: Math.max(1, snapshot.arrivals.length),
      queueVisibility: snapshot.floorFlowServiceProfile.queueVisibility,
      periodWeight: 1,
      authorizedPlayerWorkerIds: playerIds,
    })),
    ...Array.from({ length: closingTicks }, (_, index) => ({
      tick: snapshot.periodWindow.end + index + 1,
      admissionCapacity: 0,
      demand: Math.max(1, snapshot.arrivals.length),
      queueVisibility: snapshot.floorFlowServiceProfile.queueVisibility,
      periodWeight: 1,
      authorizedPlayerWorkerIds: playerIds,
    })),
  ];
  return applyFloorFlowServiceProfile(
    {
      demandSeed: snapshot.demandSeed,
      recipes: snapshot.recipes,
      arrivals: snapshot.arrivals.map((arrival) => ({
        groupId: arrival.groupId,
        arrivalTick: arrival.arrivalTick,
        cohort: arrival.cohort,
        size: arrival.size,
        basePatienceTicks: arrival.basePatienceTicks,
        hiddenPatienceTicks: arrival.hiddenPatienceTicks,
        recipePreferenceOrder: arrival.recipePreferenceOrder,
      })),
      ticks,
      workers: snapshot.workers,
      equipment: snapshot.equipment,
      kitchenExecutionQualityModifier: snapshot.kitchenExecutionQualityModifier,
      floorFlowServiceProfile: snapshot.floorFlowServiceProfile,
      initialReputation: snapshot.initialReputation,
      inventoryAuthority,
    },
    snapshot.floorFlowServiceProfile,
  );
}

function isComplete(result: ReturnType<typeof simulateServiceDay>): boolean {
  return (
    result.waitingGroupIds.length === 0 &&
    result.orders.every((order) => order.state === 'SERVED')
  );
}

export function replayAdvanceServicePeriod(
  inputSnapshot: AdvanceServicePeriodInputSnapshot,
): AdvanceServicePeriodResultSnapshot {
  assertCanonicalInput(inputSnapshot);

  const inventoryAdapter = createInventoryAdapter(inputSnapshot);
  const result = simulateServiceDay(
    serviceInput(
      inputSnapshot,
      inputSnapshot.closingTickCeiling,
      inventoryAdapter.authority,
    ),
  );
  if (!isComplete(result)) {
    throw new Error('service period did not drain within its input-derived safe ceiling');
  }
  const finalInventoryState = inventoryAdapter.finalInventoryState();
  const inventoryOutcomes = result.inventoryOutcomes;
  if (inventoryOutcomes === undefined) {
    throw new Error('ADVANCE_SERVICE_PERIOD requires E03 inventory closure evidence');
  }
  const finalActivityTick = result.events.reduce(
    (maximum, event) => Math.max(maximum, event.tick),
    inputSnapshot.periodWindow.end,
  );
  const closingTicks = Math.max(0, finalActivityTick - inputSnapshot.periodWindow.end);
  if (closingTicks > inputSnapshot.closingTickCeiling) {
    throw new Error('service-period activity exceeded its input-derived safe ceiling');
  }

  const events = deepFreeze(
    result.events.map((event, index) =>
      deepFreeze({
        ...event,
        sequence: inputSnapshot.eventSequenceStart + index,
        details: deepFreeze({ ...event.details }),
      }),
    ),
  );
  const completedPeriodKeys = deepFreeze([
    ...inputSnapshot.completedPeriodKeysBefore,
    inputSnapshot.periodKey,
  ]);
  const payload: AdvanceServicePeriodResultPayload = deepFreeze({
    version: ADVANCE_SERVICE_PERIOD_RESULT_VERSION,
    inputHash: inputSnapshot.inputHash,
    businessDay: 1,
    servicePeriodPlan: inputSnapshot.servicePeriodPlan,
    periodKey: inputSnapshot.periodKey,
    ordinal: inputSnapshot.ordinal,
    completedPeriodKeys,
    ownerAssignment: inputSnapshot.ownerAssignment,
    workerRoster: deepFreeze(inputSnapshot.workers.map((worker) => deepFreeze({ ...worker }))),
    kitchenCapacity: inputSnapshot.kitchenCapacity,
    frontCapacity: inputSnapshot.frontCapacity,
    admissionEnabled: inputSnapshot.admissionEnabled,
    orders: deepFreeze(result.orders.map((order) => deepFreeze({ ...order }))),
    departedGroupIds: deepFreeze([...result.departedGroupIds]),
    waitingGroupIds: deepFreeze([...result.waitingGroupIds]),
    inventoryState: finalInventoryState,
    inventoryOutcomes: deepFreeze(
      inventoryOutcomes.map((outcome) => deepFreeze(clonePlainData(outcome, 'E03 order outcome'))) as
        readonly ServiceInventoryOrderOutcome[],
    ),
    reputation: deepFreeze({ ...result.reputation }),
    flowRiskHigh: result.flowRiskHigh,
    events,
    eventSequenceStart: inputSnapshot.eventSequenceStart,
    nextEventSequence: inputSnapshot.eventSequenceStart + events.length,
    closingTicks,
    lastTick: inputSnapshot.periodWindow.end + closingTicks,
    status: 'PERIOD_COMPLETE',
  });
  return deepFreeze({ ...payload, resultHash: canonicalHash(payload) });
}

export function advanceServicePeriod(
  intent: unknown,
  authority: AdvanceServicePeriodAuthority,
): AdvanceServicePeriodExecution {
  const inputSnapshot = createAdvanceServicePeriodInput(intent, authority);
  return deepFreeze({ inputSnapshot, resultSnapshot: replayAdvanceServicePeriod(inputSnapshot) });
}
