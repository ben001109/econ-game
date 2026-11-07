import {
  assertOpeningSnapshotSupported,
  type OpeningSnapshot,
} from '../domains/opening-scenario/snapshot.js';

export const INITIALIZE_COMPETITIVE_SAVE = 'INITIALIZE_COMPETITIVE_SAVE' as const;

export type InitializeCompetitiveSaveIntent = Readonly<{
  scenario: string;
  operatingMode: string;
  settlementCurrency: string;
  servicePeriodPlan: string;
}>;

export type TrustedBootstrapContext = Readonly<{
  actorPlayerId: string;
  authorityId: string;
  commandId: string;
  requestFingerprint: string;
  playerCommandVersion: number;
}>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

/** Every value in this plan is produced by server-owned registries/ID generators. */
export type ServerDerivedBootstrapPlan = Readonly<{
  provisionedRestaurantId: string;
  restaurantName: string;
  restaurantTimezone: string;
  ownerMembershipId: string;
  saveId: string;
  ownerAuditLogId: string;
  mode: 'COMPETITIVE';
  openingScenario: string;
  operatingMode: string;
  servicePeriodPlan: string;
  difficultyGroup: string;
  demandSeed: string;
  simulationRuleVersion: string;
  openingSnapshot: OpeningSnapshot;
  openingSnapshotHash: string;
  marketSeedAuthority: Readonly<{
    seed: string;
    seedVersion: string;
  }>;
  inventoryPoolAuthority: Readonly<{
    revision: number;
    storageBundleVersion: string;
    storageBundleKind: string;
    capacityPoints: Readonly<{
      DURABLE: number;
      PERISHABLE: number;
    }>;
  }>;
}>;

export type InventoryPool = 'DURABLE' | 'PERISHABLE';

export type QualifyingBootstrapAuthority = Readonly<{
  id: string;
  playerId: string;
  sourceEligibilityRestaurantId: string;
}>;

export type BootstrapEpochRecord = Readonly<{
  id: string;
  authorityId: string;
  playerId: string;
  epochNumber: number;
  playerCommandVersion: number;
  predecessorEpochId: string | null;
  status: 'ACTIVE' | 'RETIRED' | 'CLEARED';
  provisionedRestaurantId: string;
  ownerMembershipId: string;
  saveId: string;
  ownerAuditLogId: string;
  commandId: string;
  requestFingerprint: string;
}>;

export type InitializeCompetitiveSaveResult = Readonly<{
  authorityId: string;
  epochId: string;
  epochNumber: number;
  provisionedRestaurantId: string;
  ownerMembershipId: string;
  saveId: string;
  ownerAuditLogId: string;
  replayed: boolean;
}>;

export class InitializeCompetitiveSaveError extends Error {
  readonly status: 403 | 409 | 422 | 503;
  readonly code: string;

  constructor(status: 403 | 409 | 422 | 503, code: string) {
    super(code);
    this.name = 'InitializeCompetitiveSaveError';
    this.status = status;
    this.code = code;
  }
}

export interface InitializeCompetitiveSaveUnitOfWork {
  findCommandReplay(context: TrustedBootstrapContext): Promise<BootstrapEpochRecord | undefined>;
  lockQualifyingAuthority(
    actorPlayerId: string,
    authorityId: string,
  ): Promise<QualifyingBootstrapAuthority | undefined>;
  lockLatestEpoch(authorityId: string): Promise<BootstrapEpochRecord | undefined>;
  createRestaurant(input: Readonly<{
    id: string;
    name: string;
    timezone: string;
  }>): Promise<void>;
  createOwnerMembership(input: Readonly<{
    id: string;
    playerId: string;
    restaurantId: string;
  }>): Promise<void>;
  createCompetitiveSave(input: Readonly<{
    id: string;
    playerId: string;
    restaurantId: string;
    plan: ServerDerivedBootstrapPlan;
  }>): Promise<void>;
  createMarketSeedAuthority(input: Readonly<{
    restaurantId: string;
    saveId: string;
    seed: string;
    seedVersion: string;
    createdByCommandId: string;
  }>): Promise<void>;
  createInventoryPoolState(input: Readonly<{
    restaurantId: string;
    saveId: string;
    pool: InventoryPool;
    revision: number;
    capacityPoints: number;
    storageBundleVersion: string;
    storageBundleKind: string;
    updatedByCommandId: string;
  }>): Promise<void>;
  createOwnerAudit(input: Readonly<{
    id: string;
    playerId: string;
    restaurantId: string;
    membershipId: string;
    commandId: string;
  }>): Promise<void>;
  createEpoch(input: BootstrapEpochRecord): Promise<void>;
}

export interface InitializeCompetitiveSaveRepository {
  provision(input: InitializeCompetitiveSaveTransactionInput): Promise<InitializeCompetitiveSaveResult>;
}

export type InitializeCompetitiveSaveTransactionInput = Readonly<{
  context: TrustedBootstrapContext;
  plan: ServerDerivedBootstrapPlan;
  epochId: string;
}>;

export async function executeInitializeCompetitiveSaveTransaction(
  transaction: InitializeCompetitiveSaveUnitOfWork,
  input: InitializeCompetitiveSaveTransactionInput,
): Promise<InitializeCompetitiveSaveResult> {
  validateTrustedInput(input);

  const replay = await transaction.findCommandReplay(input.context);
  if (replay) {
    if (
      replay.authorityId !== input.context.authorityId ||
      replay.playerId !== input.context.actorPlayerId ||
      replay.requestFingerprint !== input.context.requestFingerprint
    ) {
      throw conflict();
    }
    return resultFromEpoch(replay, true);
  }

  const authority = await transaction.lockQualifyingAuthority(
    input.context.actorPlayerId,
    input.context.authorityId,
  );
  if (
    !authority ||
    authority.id !== input.context.authorityId ||
    authority.playerId !== input.context.actorPlayerId ||
    authority.sourceEligibilityRestaurantId === input.plan.provisionedRestaurantId
  ) {
    throw forbidden();
  }

  const predecessor = await transaction.lockLatestEpoch(authority.id);
  if (predecessor && predecessor.status !== 'CLEARED') throw conflict();
  if (predecessor && predecessor.playerId !== authority.playerId) throw forbidden();

  const epoch: BootstrapEpochRecord = Object.freeze({
    id: input.epochId,
    authorityId: authority.id,
    playerId: authority.playerId,
    epochNumber: (predecessor?.epochNumber ?? 0) + 1,
    playerCommandVersion: input.context.playerCommandVersion,
    predecessorEpochId: predecessor?.id ?? null,
    status: 'ACTIVE',
    provisionedRestaurantId: input.plan.provisionedRestaurantId,
    ownerMembershipId: input.plan.ownerMembershipId,
    saveId: input.plan.saveId,
    ownerAuditLogId: input.plan.ownerAuditLogId,
    commandId: input.context.commandId,
    requestFingerprint: input.context.requestFingerprint,
  });

  await transaction.createRestaurant({
    id: input.plan.provisionedRestaurantId,
    name: input.plan.restaurantName,
    timezone: input.plan.restaurantTimezone,
  });
  await transaction.createOwnerMembership({
    id: input.plan.ownerMembershipId,
    playerId: authority.playerId,
    restaurantId: input.plan.provisionedRestaurantId,
  });
  await transaction.createCompetitiveSave({
    id: input.plan.saveId,
    playerId: authority.playerId,
    restaurantId: input.plan.provisionedRestaurantId,
    plan: input.plan,
  });
  await transaction.createMarketSeedAuthority({
    restaurantId: input.plan.provisionedRestaurantId,
    saveId: input.plan.saveId,
    seed: input.plan.marketSeedAuthority.seed,
    seedVersion: input.plan.marketSeedAuthority.seedVersion,
    createdByCommandId: input.context.commandId,
  });
  await transaction.createInventoryPoolState({
    restaurantId: input.plan.provisionedRestaurantId,
    saveId: input.plan.saveId,
    pool: 'DURABLE',
    revision: input.plan.inventoryPoolAuthority.revision,
    capacityPoints: input.plan.inventoryPoolAuthority.capacityPoints.DURABLE,
    storageBundleVersion: input.plan.inventoryPoolAuthority.storageBundleVersion,
    storageBundleKind: input.plan.inventoryPoolAuthority.storageBundleKind,
    updatedByCommandId: input.context.commandId,
  });
  await transaction.createInventoryPoolState({
    restaurantId: input.plan.provisionedRestaurantId,
    saveId: input.plan.saveId,
    pool: 'PERISHABLE',
    revision: input.plan.inventoryPoolAuthority.revision,
    capacityPoints: input.plan.inventoryPoolAuthority.capacityPoints.PERISHABLE,
    storageBundleVersion: input.plan.inventoryPoolAuthority.storageBundleVersion,
    storageBundleKind: input.plan.inventoryPoolAuthority.storageBundleKind,
    updatedByCommandId: input.context.commandId,
  });
  await transaction.createOwnerAudit({
    id: input.plan.ownerAuditLogId,
    playerId: authority.playerId,
    restaurantId: input.plan.provisionedRestaurantId,
    membershipId: input.plan.ownerMembershipId,
    commandId: input.context.commandId,
  });
  await transaction.createEpoch(epoch);
  return resultFromEpoch(epoch, false);
}

export type ServerBootstrapPlanFactory = (
  context: TrustedBootstrapContext,
  intent: InitializeCompetitiveSaveIntent,
) => Readonly<{ epochId: string; plan: ServerDerivedBootstrapPlan }>;

export class InitializeCompetitiveSaveService {
  constructor(
    private readonly repository: InitializeCompetitiveSaveRepository,
    private readonly createServerPlan: ServerBootstrapPlanFactory,
  ) {}

  initialize(
    context: TrustedBootstrapContext,
    clientInput: unknown,
  ): Promise<InitializeCompetitiveSaveResult> {
    const intent = parseInitializeCompetitiveSaveIntent(clientInput);
    const derived = this.createServerPlan(context, intent);
    return this.repository.provision({ context, epochId: derived.epochId, plan: derived.plan });
  }
}

export function parseInitializeCompetitiveSaveIntent(input: unknown): InitializeCompetitiveSaveIntent {
  if (!isRecord(input)) throw invalid();
  const expected = ['operatingMode', 'scenario', 'servicePeriodPlan', 'settlementCurrency'];
  const keys = Object.keys(input).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw invalid();
  }
  for (const key of expected) {
    if (typeof input[key] !== 'string' || input[key].trim().length === 0) throw invalid();
  }
  return Object.freeze({
    scenario: input.scenario as string,
    operatingMode: input.operatingMode as string,
    settlementCurrency: input.settlementCurrency as string,
    servicePeriodPlan: input.servicePeriodPlan as string,
  });
}

function validateTrustedInput(input: InitializeCompetitiveSaveTransactionInput): void {
  const marketSeedAuthority = input.plan.marketSeedAuthority;
  const inventoryPoolAuthority = input.plan.inventoryPoolAuthority;
  const identifiers = [
    input.context.actorPlayerId,
    input.context.authorityId,
    input.context.commandId,
    input.epochId,
    input.plan.provisionedRestaurantId,
    input.plan.ownerMembershipId,
    input.plan.saveId,
    input.plan.ownerAuditLogId,
  ];
  if (identifiers.some((value) => !value.trim()) || !isBootstrapCommandId(input.context.commandId)) {
    throw invalid();
  }
  if (!/^[0-9a-f]{64}$/.test(input.context.requestFingerprint)) throw invalid();
  if (!/^[0-9a-f]{64}$/.test(input.plan.openingSnapshotHash)) throw invalid();
  try {
    if (input.plan.openingSnapshotHash !== input.plan.openingSnapshot.openingSnapshotHash) {
      throw new Error('opening snapshot hash does not match the server plan');
    }
    assertOpeningSnapshotSupported(input.plan.openingSnapshot);
    if (
      input.plan.openingScenario !== input.plan.openingSnapshot.scenario ||
      input.plan.operatingMode !== input.plan.openingSnapshot.operatingMode ||
      input.plan.simulationRuleVersion !== input.plan.openingSnapshot.simulationRuleVersion
    ) {
      throw new Error('opening snapshot does not match the server plan');
    }
  } catch {
    throw invalid();
  }
  if (
    !Number.isSafeInteger(input.context.playerCommandVersion) ||
    input.context.playerCommandVersion < 1
  ) {
    throw invalid();
  }
  if (input.plan.mode !== 'COMPETITIVE') throw invalid();
  if (
    !isBoundedSqlText(marketSeedAuthority?.seed, 300) ||
    !isBoundedSqlText(marketSeedAuthority?.seedVersion, 128) ||
    !Number.isSafeInteger(inventoryPoolAuthority?.revision) ||
    (inventoryPoolAuthority?.revision ?? 0) < 1 ||
    (inventoryPoolAuthority?.revision ?? 0) > 2_147_483_647 ||
    !isBoundedSqlText(inventoryPoolAuthority?.storageBundleVersion, 128) ||
    !isBoundedSqlText(inventoryPoolAuthority?.storageBundleKind, 128) ||
    !isNonNegativeSafeInteger(inventoryPoolAuthority?.capacityPoints?.DURABLE) ||
    !isNonNegativeSafeInteger(inventoryPoolAuthority?.capacityPoints?.PERISHABLE)
  ) {
    throw invalid();
  }
}

/**
 * Bootstrap command IDs are persisted into E03 provenance columns whose
 * database constraint accepts RFC 4122 UUID versions 1 through 8 only.
 * Keep this check at server-side transaction boundaries; route parsing alone
 * is not a safe authority boundary.
 */
export function isBootstrapCommandId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isBoundedSqlText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !value.includes('\u0000') &&
    isWellFormedUtf16(value) &&
    Array.from(value).length <= maximumLength
  );
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function resultFromEpoch(
  epoch: BootstrapEpochRecord,
  replayed: boolean,
): InitializeCompetitiveSaveResult {
  return Object.freeze({
    authorityId: epoch.authorityId,
    epochId: epoch.id,
    epochNumber: epoch.epochNumber,
    provisionedRestaurantId: epoch.provisionedRestaurantId,
    ownerMembershipId: epoch.ownerMembershipId,
    saveId: epoch.saveId,
    ownerAuditLogId: epoch.ownerAuditLogId,
    replayed,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): InitializeCompetitiveSaveError {
  return new InitializeCompetitiveSaveError(422, 'INITIALIZE_COMPETITIVE_SAVE_INVALID');
}

function forbidden(): InitializeCompetitiveSaveError {
  return new InitializeCompetitiveSaveError(403, 'INITIALIZE_COMPETITIVE_SAVE_FORBIDDEN');
}

function conflict(): InitializeCompetitiveSaveError {
  return new InitializeCompetitiveSaveError(409, 'INITIALIZE_COMPETITIVE_SAVE_CONFLICT');
}
