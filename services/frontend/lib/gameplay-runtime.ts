import type {
  AdvanceServicePeriodIntent,
  ConfigurePreopenDayIntent,
  GameplayCommandInput,
  InitializeCompetitiveSaveInput,
  OpenBusinessDayIntent,
  PreopenConfigurationChoices,
  RequestDayReplayIntent,
  SettleBusinessDayIntent,
} from '@econ-game/sdk';
import { createGameplayResponseValidationGuard } from '@econ-game/sdk';

import {
  commandSaveId,
  GameplayMachineError,
  GameplayResponseValidationError,
  stateFromDiscovery,
  stateFromProjection,
  stateFromReplayJob,
  type AnyGameplayRecoveryRecord,
  type GameplayMutationRequest,
  type GameplayOperation,
  type GameplayRecoveryRecord,
  type WebGameplayState,
  type WebGameplayTransport,
} from './gameplay-machine.js';

export type GameplayRecoveryStore = Readonly<{
  /** Recovery storage is untrusted browser data and is decoded by the runtime. */
  read: () => unknown | undefined;
  write: (record: AnyGameplayRecoveryRecord) => void;
  clear: () => void;
}>;

export type WebGameplayRuntimeOptions = Readonly<{
  /** This value is used only to create an in-memory API client for one request. */
  getAccessToken: () => Promise<string | undefined>;
  createClient: (accessToken: string) => WebGameplayTransport;
  recoveryStore?: GameplayRecoveryStore;
}>;

const WEB_GAMEPLAY_RESPONSE_VALIDATION_VERSION = 'gameplay-response-validation/v1' as const;
const canonicalResponseGuard = createGameplayResponseValidationGuard(
  WEB_GAMEPLAY_RESPONSE_VALIDATION_VERSION,
);

/**
 * Web-only orchestration around the shared, validated gameplay SDK transport.
 * It never creates an actor context, derives game authority, stores a credential,
 * or automatically retries a mutation.
 */
export class WebGameplayRuntime {
  private currentState: WebGameplayState = Object.freeze({
    tag: 'auth-unavailable',
    reason: 'NOT_STARTED',
  });

  private readonly recoveryStore: GameplayRecoveryStore;

  constructor(private readonly options: WebGameplayRuntimeOptions) {
    this.recoveryStore = options.recoveryStore ?? noRecoveryStore;
  }

  get state(): WebGameplayState {
    return this.currentState;
  }

  async discover(): Promise<WebGameplayState> {
    this.currentState = Object.freeze({ tag: 'discovering' });
    const client = await this.clientFor('DISCOVER');
    if (!client) return this.currentState;
    try {
      this.currentState = await this.stateFromServerDiscovery(client);
    } catch (error) {
      this.currentState = this.stateForResponseOrRequestFailure('DISCOVER', error, 'none');
    }
    return this.currentState;
  }

  /** Restoring is passive: an unconfirmed mutation remains explicit-retry only. */
  async restore(): Promise<WebGameplayState> {
    const recovery = this.readRecovery();
    if (recovery === 'invalid') return this.recoveryInvalid();
    if (!recovery) return this.discover();
    if (recovery.stage === 'MUTATION_UNCONFIRMED') {
      this.currentState = Object.freeze({
        tag: 'failure',
        operation: recovery.mutation.kind,
        code: 'RECOVERY_REQUIRES_EXPLICIT_RETRY',
        retry: 'retry-same-request',
        recovery,
      });
      return this.currentState;
    }
    if (recovery.stage === 'REFRESH_REQUIRED') return this.refreshRecovery(recovery);
    this.currentState = Object.freeze({
      tag: 'polling',
      saveId: recovery.replay.saveId,
      jobId: recovery.replay.jobId,
      status: 'QUEUED',
    });
    return this.currentState;
  }

  async initialize(input: InitializeCompetitiveSaveInput): Promise<WebGameplayState> {
    const state = this.currentState;
    if (state.tag !== 'initialize') {
      throw new GameplayMachineError('GAMEPLAY_STATE_ACTION_UNAVAILABLE');
    }
    if (input.expectedVersion !== state.bootstrap.expectedVersion) {
      throw new GameplayMachineError('GAMEPLAY_EXPECTED_VERSION_MISMATCH');
    }
    if (input.payload.scenario === 'EMPTY_PREMISES') {
      this.currentState = Object.freeze({
        tag: 'incompatible',
        reason: 'EMPTY_PREMISES_EQUIPMENT_PATH_REQUIRED',
      });
      return this.currentState;
    }
    return this.runMutation(Object.freeze({ kind: 'INITIALIZE_COMPETITIVE_SAVE', input }));
  }

  async configure(
    input: GameplayCommandInput<ConfigurePreopenDayIntent>,
  ): Promise<WebGameplayState> {
    const projection = this.requireProjection('configure');
    this.assertExpectedVersion(projection.expectedVersion, input.expectedVersion);
    return this.runMutation(
      Object.freeze({ kind: 'CONFIGURE_PREOPEN_DAY', saveId: projection.save.id, input }),
    );
  }

  /**
   * Reads the server-authoritative CONFIGURE choices only while the current
   * projection authorizes CONFIGURE_PREOPEN_DAY. The caller must bind its
   * local draft to the returned save and version before constructing intent.
   */
  async getPreopenConfigurationChoices(): Promise<PreopenConfigurationChoices> {
    const projection = this.requireProjection('configure');
    const client = await this.clientFor('DISCOVER');
    if (!client) throw new GameplayMachineError('GAMEPLAY_PREOPEN_CHOICES_UNAVAILABLE');
    try {
      const value = await client.getPreopenConfigurationChoices(projection.save.id);
      const choices = canonicalResponseGuard.preopenConfigurationChoices(value);
      if (
        choices.save.id !== projection.save.id ||
        choices.save.expectedVersion !== projection.expectedVersion ||
        choices.save.scenario !== projection.save.openingScenario ||
        choices.save.operatingMode !== projection.save.operatingMode ||
        choices.save.servicePeriodPlan !== projection.save.servicePeriodPlan ||
        choices.save.simulationRuleVersion !== projection.save.simulationRuleVersion
      ) {
        throw new GameplayResponseValidationError();
      }
      return choices;
    } catch (error) {
      if (error instanceof GameplayResponseValidationError || error instanceof TypeError) {
        this.currentState = Object.freeze({
          tag: 'incompatible',
          reason: 'UNSUPPORTED_SERVER_PROJECTION',
        });
      }
      throw error;
    }
  }

  async open(input: GameplayCommandInput<OpenBusinessDayIntent>): Promise<WebGameplayState> {
    const projection = this.requireProjection('open');
    this.assertExpectedVersion(projection.expectedVersion, input.expectedVersion);
    if (
      !projection.preopenSnapshot ||
      input.payload.preopenSnapshotId !== projection.preopenSnapshot.id ||
      input.payload.preopenSnapshotHash !== projection.preopenSnapshot.hash
    ) {
      throw new GameplayMachineError('GAMEPLAY_PREOPEN_SNAPSHOT_MISMATCH');
    }
    return this.runMutation(
      Object.freeze({ kind: 'OPEN_BUSINESS_DAY', saveId: projection.save.id, input }),
    );
  }

  async advance(
    input: GameplayCommandInput<AdvanceServicePeriodIntent>,
  ): Promise<WebGameplayState> {
    const projection = this.requireProjection('advance');
    this.assertExpectedVersion(projection.expectedVersion, input.expectedVersion);
    if (
      input.payload.businessDay !== projection.businessDay?.businessDay ||
      input.payload.expectedPeriodKey !== projection.businessDay.nextPeriodKey
    ) {
      throw new GameplayMachineError('GAMEPLAY_PERIOD_PROJECTION_MISMATCH');
    }
    return this.runMutation(
      Object.freeze({ kind: 'ADVANCE_SERVICE_PERIOD', saveId: projection.save.id, input }),
    );
  }

  async settle(input: GameplayCommandInput<SettleBusinessDayIntent>): Promise<WebGameplayState> {
    const projection = this.requireProjection('settle');
    this.assertExpectedVersion(projection.expectedVersion, input.expectedVersion);
    if (input.payload.businessDay !== projection.businessDay?.businessDay) {
      throw new GameplayMachineError('GAMEPLAY_BUSINESS_DAY_PROJECTION_MISMATCH');
    }
    return this.runMutation(
      Object.freeze({ kind: 'SETTLE_BUSINESS_DAY', saveId: projection.save.id, input }),
    );
  }

  async requestReplay(
    input: GameplayCommandInput<RequestDayReplayIntent>,
  ): Promise<WebGameplayState> {
    const projection = this.requireProjection('replay');
    this.assertExpectedVersion(projection.expectedVersion, input.expectedVersion);
    if (input.payload.businessDay !== projection.dayEnd?.businessDay) {
      throw new GameplayMachineError('GAMEPLAY_REPLAY_PROJECTION_MISMATCH');
    }
    return this.runMutation(
      Object.freeze({ kind: 'REQUEST_DAY_REPLAY', saveId: projection.save.id, input }),
    );
  }

  async pollReplay(): Promise<WebGameplayState> {
    if (this.currentState.tag !== 'polling') {
      throw new GameplayMachineError('GAMEPLAY_REPLAY_POLL_NOT_AVAILABLE');
    }
    const { saveId, jobId } = this.currentState;
    const client = await this.clientFor('POLL_REPLAY');
    if (!client) return this.currentState;
    try {
      this.currentState = await this.stateFromServerReplayPoll(client, saveId, jobId);
      if (this.currentState.tag === 'polling') {
        this.recoveryStore.write(replayRecovery(saveId, jobId));
      } else {
        this.recoveryStore.clear();
      }
    } catch (error) {
      this.currentState = this.stateForResponseOrRequestFailure(
        'POLL_REPLAY',
        error,
        'poll-only',
        replayRecovery(saveId, jobId),
      );
    }
    return this.currentState;
  }

  /** Explicit user action only. The persisted command payload and idempotency key are reused verbatim. */
  async retryLastMutation(): Promise<WebGameplayState> {
    const recovery = this.readRecovery();
    if (recovery === 'invalid') return this.recoveryInvalid();
    if (!recovery || recovery.stage !== 'MUTATION_UNCONFIRMED') {
      throw new GameplayMachineError('GAMEPLAY_RETRY_NOT_AVAILABLE');
    }
    await this.discover();
    if (this.currentState.tag === 'incompatible') return this.currentState;
    if (!recoveredMutationMatchesState(recovery.mutation, this.currentState)) {
      return this.recoveryInvalid(recovery.mutation.kind);
    }
    return this.runMutation(recovery.mutation);
  }

  async refresh(): Promise<WebGameplayState> {
    const recovery = this.readRecovery();
    if (recovery === 'invalid') return this.recoveryInvalid();
    if (recovery?.stage === 'REFRESH_REQUIRED') return this.refreshRecovery(recovery);
    if (this.currentState.tag === 'initialize') return this.discover();
    const saveId = projectionSaveId(this.currentState);
    if (!saveId) throw new GameplayMachineError('GAMEPLAY_REFRESH_NOT_AVAILABLE');
    return this.refreshSave(saveId);
  }

  private async runMutation(request: GameplayMutationRequest): Promise<WebGameplayState> {
    assertSafeRecoveryMutation(request);
    if (!isGameplayMutation(request)) {
      throw new GameplayMachineError('GAMEPLAY_RECOVERY_PAYLOAD_INVALID');
    }
    const recovery = mutationRecovery('MUTATION_UNCONFIRMED', request);
    this.recoveryStore.write(recovery);
    const client = await this.clientFor(request.kind);
    if (!client) return this.currentState;

    try {
      if (request.kind === 'REQUEST_DAY_REPLAY') {
        const receipt = await client.requestDayReplay(request.saveId, request.input);
        const replay = replayRecovery(request.saveId, receipt.jobId);
        this.recoveryStore.write(replay);
        this.currentState = Object.freeze({
          tag: 'polling',
          saveId: request.saveId,
          jobId: receipt.jobId,
          status: 'QUEUED',
        });
        return this.currentState;
      }
      await executeSynchronousMutation(client, request);
      const refresh = mutationRecovery('REFRESH_REQUIRED', request);
      this.recoveryStore.write(refresh);
      return this.refreshRecovery(refresh);
    } catch (error) {
      return this.handleMutationError(request, recovery, error);
    }
  }

  private async handleMutationError(
    request: GameplayMutationRequest,
    recovery: GameplayRecoveryRecord,
    error: unknown,
  ): Promise<WebGameplayState> {
    const status = statusOf(error);
    if (status === 409) {
      this.recoveryStore.clear();
      if (request.kind === 'INITIALIZE_COMPETITIVE_SAVE') return this.discover();
      return this.refreshSave(request.saveId);
    }
    if (status === 404) {
      this.recoveryStore.clear();
      this.currentState = Object.freeze({ tag: 'incompatible', reason: 'ROUTE_NOT_SUPPORTED' });
      return this.currentState;
    }
    if (status === 422) {
      this.recoveryStore.clear();
      this.currentState = this.readError(request.kind, error, 'none');
      return this.currentState;
    }
    if (status === 401 || status === 403) {
      this.currentState = Object.freeze({
        tag: 'auth-unavailable',
        reason: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
      });
      return this.currentState;
    }
    this.currentState = this.readError(request.kind, error, 'retry-same-request', recovery);
    return this.currentState;
  }

  private async refreshRecovery(recovery: GameplayRecoveryRecord): Promise<WebGameplayState> {
    if (recovery.mutation.kind === 'INITIALIZE_COMPETITIVE_SAVE') {
      this.currentState = Object.freeze({ tag: 'refresh' });
      const client = await this.clientFor('REFRESH');
      if (!client) return this.currentState;
      try {
        this.currentState = await this.stateFromServerDiscovery(client);
        this.recoveryStore.clear();
      } catch (error) {
        this.currentState = this.stateForResponseOrRequestFailure(
          'REFRESH',
          error,
          'refresh-only',
          recovery,
        );
      }
      return this.currentState;
    }
    return this.refreshSave(recovery.mutation.saveId, recovery);
  }

  private async refreshSave(
    saveId: string,
    recovery?: GameplayRecoveryRecord,
  ): Promise<WebGameplayState> {
    this.currentState = Object.freeze({ tag: 'refresh', saveId });
    const client = await this.clientFor('REFRESH');
    if (!client) return this.currentState;
    try {
      this.currentState = await this.stateFromServerProjection(client, saveId);
      if (recovery) this.recoveryStore.clear();
    } catch (error) {
      this.currentState = this.stateForResponseOrRequestFailure(
        'REFRESH',
        error,
        'refresh-only',
        recovery,
      );
    }
    return this.currentState;
  }

  private async clientFor(operation: GameplayOperation): Promise<WebGameplayTransport | undefined> {
    let candidate: string | undefined;
    try {
      candidate = await this.options.getAccessToken();
    } catch {
      this.currentState = Object.freeze({ tag: 'auth-unavailable', reason: 'AUTH_PROVIDER_FAILED' });
      return undefined;
    }
    const token = candidate?.trim();
    if (!token || /[\s,]/.test(token)) {
      this.currentState = Object.freeze({ tag: 'auth-unavailable', reason: 'ACCESS_TOKEN_UNAVAILABLE' });
      return undefined;
    }
    try {
      return this.options.createClient(token);
    } catch (error) {
      this.currentState = this.readError(operation, error, 'none');
      return undefined;
    }
  }

  private async stateFromServerDiscovery(client: WebGameplayTransport): Promise<WebGameplayState> {
    const value = await client.getActiveSave();
    try {
      return stateFromDiscovery(canonicalResponseGuard.activeSaveDiscovery(value));
    } catch {
      throw new GameplayResponseValidationError();
    }
  }

  private async stateFromServerProjection(
    client: WebGameplayTransport,
    saveId: string,
  ): Promise<WebGameplayState> {
    const value = await client.getGameplayProjection(saveId);
    try {
      return stateFromProjection(canonicalResponseGuard.gameplayProjection(value));
    } catch {
      throw new GameplayResponseValidationError();
    }
  }

  private async stateFromServerReplayPoll(
    client: WebGameplayTransport,
    saveId: string,
    jobId: string,
  ): Promise<WebGameplayState> {
    const value = await client.pollReplayJob(saveId, jobId);
    try {
      return stateFromReplayJob(saveId, canonicalResponseGuard.replayJobPollResponse(value).body);
    } catch {
      throw new GameplayResponseValidationError();
    }
  }

  private assertState(tag: WebGameplayState['tag']): void {
    if (this.currentState.tag !== tag) throw new GameplayMachineError('GAMEPLAY_STATE_ACTION_UNAVAILABLE');
  }

  private requireProjection(
    tag: 'configure' | 'open' | 'advance' | 'settle' | 'replay',
  ) {
    const state = this.currentState;
    if (state.tag !== tag || !hasProjection(state)) {
      throw new GameplayMachineError('GAMEPLAY_STATE_ACTION_UNAVAILABLE');
    }
    return state.projection;
  }

  private assertExpectedVersion(expected: number, actual: number): void {
    if (expected !== actual) throw new GameplayMachineError('GAMEPLAY_EXPECTED_VERSION_MISMATCH');
  }

  private readError(
    operation: GameplayOperation,
    error: unknown,
    retry: Extract<WebGameplayState, { tag: 'failure' }>['retry'],
    recovery?: AnyGameplayRecoveryRecord,
  ): WebGameplayState {
    const status = statusOf(error);
    return Object.freeze({
      tag: 'failure',
      operation,
      code: errorCode(error),
      ...(status === undefined ? {} : { status }),
      retry,
      ...(recovery ? { recovery } : {}),
    });
  }

  private stateForResponseOrRequestFailure(
    operation: GameplayOperation,
    error: unknown,
    retry: Extract<WebGameplayState, { tag: 'failure' }>['retry'],
    recovery?: AnyGameplayRecoveryRecord,
  ): WebGameplayState {
    if (error instanceof GameplayResponseValidationError) {
      return Object.freeze({ tag: 'incompatible', reason: 'UNSUPPORTED_SERVER_PROJECTION' });
    }
    return this.readError(operation, error, retry, recovery);
  }

  private readRecovery(): AnyGameplayRecoveryRecord | 'invalid' | undefined {
    const raw = this.recoveryStore.read();
    if (raw === undefined) return undefined;
    return isRecoveryRecord(raw) ? raw : 'invalid';
  }

  private recoveryInvalid(operation: GameplayOperation = 'REFRESH'): WebGameplayState {
    this.recoveryStore.clear();
    this.currentState = Object.freeze({
      tag: 'failure',
      operation,
      code: 'RECOVERY_INVALID',
      retry: 'none',
    });
    return this.currentState;
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Browser persistence is opt-in and stores only the public recovery record. */
export class BrowserGameplayRecoveryStore implements GameplayRecoveryStore {
  constructor(
    private readonly storage: StorageLike,
    private readonly key = 'econ-game.gameplay-recovery/v1',
  ) {}

  read(): unknown | undefined {
    const raw = this.storage.getItem(this.key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return Object.freeze({});
    }
  }

  write(record: AnyGameplayRecoveryRecord): void {
    this.storage.setItem(this.key, JSON.stringify(record));
  }

  clear(): void {
    this.storage.removeItem(this.key);
  }
}

const noRecoveryStore: GameplayRecoveryStore = Object.freeze({
  read: () => undefined,
  write: () => undefined,
  clear: () => undefined,
});

function hasProjection(
  state: WebGameplayState,
): state is Extract<WebGameplayState, { projection: unknown }> {
  return 'projection' in state;
}

function projectionSaveId(state: WebGameplayState): string | undefined {
  return hasProjection(state) ? state.projection.save.id : undefined;
}

function mutationRecovery<TStage extends GameplayRecoveryRecord['stage']>(
  stage: TStage,
  mutation: GameplayMutationRequest,
): Extract<GameplayRecoveryRecord, { stage: TStage }> {
  return Object.freeze({
    schemaVersion: 'web-gameplay-recovery/v1',
    stage,
    mutation: cloneJson(mutation),
  }) as Extract<GameplayRecoveryRecord, { stage: TStage }>;
}

function replayRecovery(saveId: string, jobId: string): AnyGameplayRecoveryRecord {
  return Object.freeze({
    schemaVersion: 'web-gameplay-recovery/v1',
    stage: 'REPLAY_POLL_REQUIRED',
    replay: Object.freeze({ saveId, jobId }),
  });
}

async function executeSynchronousMutation(
  client: WebGameplayTransport,
  request: Exclude<GameplayMutationRequest, { kind: 'REQUEST_DAY_REPLAY' }>,
): Promise<void> {
  switch (request.kind) {
    case 'INITIALIZE_COMPETITIVE_SAVE':
      await client.initializeCompetitiveSave(request.input);
      return;
    case 'CONFIGURE_PREOPEN_DAY':
      await client.configurePreopenDay(request.saveId, request.input);
      return;
    case 'OPEN_BUSINESS_DAY':
      await client.openBusinessDay(request.saveId, request.input);
      return;
    case 'ADVANCE_SERVICE_PERIOD':
      await client.advanceServicePeriod(request.saveId, request.input);
      return;
    case 'SETTLE_BUSINESS_DAY':
      await client.settleBusinessDay(request.saveId, request.input);
      return;
    default:
      unreachable(request);
  }
}

function statusOf(error: unknown): number | undefined {
  return typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : undefined;
}

function errorCode(error: unknown): string {
  if (typeof (error as { code?: unknown })?.code === 'string') {
    return (error as { code: string }).code;
  }
  return statusOf(error) === undefined ? 'GAMEPLAY_TRANSPORT_FAILED' : 'GAMEPLAY_REQUEST_FAILED';
}

function assertSafeRecoveryMutation(mutation: GameplayMutationRequest): void {
  if (commandSaveId(mutation) !== undefined && !commandSaveId(mutation)?.trim()) {
    throw new GameplayMachineError('GAMEPLAY_SAVE_LOCATOR_INVALID');
  }
  assertPublicJson(mutation, 'mutation');
}

function assertPublicJson(value: unknown, path: string): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublicJson(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object') throw new GameplayMachineError('GAMEPLAY_RECOVERY_PAYLOAD_INVALID');
  for (const [key, nested] of Object.entries(value)) {
    if (/token|authorization|cookie|secret|password|credential/i.test(key)) {
      throw new GameplayMachineError('GAMEPLAY_RECOVERY_PAYLOAD_SECRET_FORBIDDEN');
    }
    assertPublicJson(nested, `${path}.${key}`);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecoveryRecord(value: unknown): value is AnyGameplayRecoveryRecord {
  if (!isRecord(value) || value.schemaVersion !== 'web-gameplay-recovery/v1') return false;
  if (value.stage === 'REPLAY_POLL_REQUIRED') {
    return exactRecord(value, ['replay', 'schemaVersion', 'stage']) && isReplayRecovery(value.replay);
  }
  return (
    (value.stage === 'MUTATION_UNCONFIRMED' || value.stage === 'REFRESH_REQUIRED') &&
    exactRecord(value, ['mutation', 'schemaVersion', 'stage']) &&
    isGameplayMutation(value.mutation)
  );
}

function isReplayRecovery(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactRecord(value, ['jobId', 'saveId']) &&
    nonEmptyString(value.saveId) &&
    nonEmptyString(value.jobId)
  );
}

function isGameplayMutation(value: unknown): value is GameplayMutationRequest {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  try {
    assertPublicJson(value, 'mutation');
  } catch {
    return false;
  }
  switch (value.kind) {
    case 'INITIALIZE_COMPETITIVE_SAVE':
      return exactRecord(value, ['input', 'kind']) && isInput(value.input, isInitializePayload);
    case 'CONFIGURE_PREOPEN_DAY':
      return exactRecord(value, ['input', 'kind', 'saveId']) && nonEmptyString(value.saveId) && isInput(value.input, isConfigurePayload);
    case 'OPEN_BUSINESS_DAY':
      return exactRecord(value, ['input', 'kind', 'saveId']) && nonEmptyString(value.saveId) && isInput(value.input, isOpenPayload);
    case 'ADVANCE_SERVICE_PERIOD':
      return exactRecord(value, ['input', 'kind', 'saveId']) && nonEmptyString(value.saveId) && isInput(value.input, isAdvancePayload);
    case 'SETTLE_BUSINESS_DAY':
      return exactRecord(value, ['input', 'kind', 'saveId']) && nonEmptyString(value.saveId) && isInput(value.input, isSettlePayload);
    case 'REQUEST_DAY_REPLAY':
      return exactRecord(value, ['input', 'kind', 'saveId']) && nonEmptyString(value.saveId) && isInput(value.input, isReplayPayload);
    default:
      return false;
  }
}

function isInput(value: unknown, payloadGuard: (payload: unknown) => boolean): boolean {
  return (
    isRecord(value) &&
    exactRecord(value, ['commandId', 'expectedVersion', 'idempotencyKey', 'payload']) &&
    nonEmptyString(value.commandId) &&
    nonEmptyString(value.idempotencyKey) &&
    nonNegativeSafeInteger(value.expectedVersion) &&
    payloadGuard(value.payload)
  );
}

function isInitializePayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactRecord(value, ['operatingMode', 'scenario', 'servicePeriodPlan', 'settlementCurrency']) &&
    nonEmptyString(value.scenario) &&
    nonEmptyString(value.operatingMode) &&
    nonEmptyString(value.settlementCurrency) &&
    nonEmptyString(value.servicePeriodPlan)
  );
}

function isConfigurePayload(value: unknown): boolean {
  if (!isRecord(value) || !exactRecord(value, ['floorPlan', 'menuChoice', 'spotPurchaseDeltas'])) return false;
  const menu = value.menuChoice;
  const floor = value.floorPlan;
  return (
    isRecord(menu) &&
    exactRecord(menu, ['enabledSubstitutionIds', 'priceModifierPercentByRecipe', 'recipeVersionIds', 'themeId']) &&
    nonEmptyString(menu.themeId) &&
    stringArray(menu.recipeVersionIds) &&
    stringArray(menu.enabledSubstitutionIds) &&
    numericRecord(menu.priceModifierPercentByRecipe) &&
    isFloorPlan(floor) &&
    Array.isArray(value.spotPurchaseDeltas) &&
    value.spotPurchaseDeltas.every(isSpotPurchase)
  );
}

function isFloorPlan(value: unknown): boolean {
  if (!isRecord(value) || !exactRecord(value, ['fixtures', 'height', 'servicePoint', 'width'])) return false;
  return (
    positiveSafeInteger(value.width) &&
    positiveSafeInteger(value.height) &&
    isPoint(value.servicePoint) &&
    Array.isArray(value.fixtures) &&
    value.fixtures.every(isFixture)
  );
}

function isFixture(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactRecord(value, ['fixtureId', 'kind', 'x', 'y']) &&
    nonEmptyString(value.fixtureId) &&
    (value.kind === 'SEAT' || value.kind === 'WALKWAY' || value.kind === 'WAITING_ZONE') &&
    nonNegativeSafeInteger(value.x) &&
    nonNegativeSafeInteger(value.y)
  );
}

function isPoint(value: unknown): boolean {
  return isRecord(value) && exactRecord(value, ['x', 'y']) && nonNegativeSafeInteger(value.x) && nonNegativeSafeInteger(value.y);
}

function isSpotPurchase(value: unknown): boolean {
  return isRecord(value) && exactRecord(value, ['ingredientId', 'quantityPoints']) && nonEmptyString(value.ingredientId) && nonNegativeSafeInteger(value.quantityPoints);
}

function isOpenPayload(value: unknown): boolean {
  return isRecord(value) && exactRecord(value, ['preopenSnapshotHash', 'preopenSnapshotId']) && nonEmptyString(value.preopenSnapshotId) && sha256(value.preopenSnapshotHash);
}

function isAdvancePayload(value: unknown): boolean {
  return isRecord(value) && exactRecord(value, ['businessDay', 'expectedPeriodKey', 'ownerAssignment']) && value.businessDay === 1 && (value.expectedPeriodKey === 'LUNCH' || value.expectedPeriodKey === 'OFF_PEAK' || value.expectedPeriodKey === 'DINNER') && (value.ownerAssignment === 'KITCHEN' || value.ownerAssignment === 'FRONT' || value.ownerAssignment === 'NONE');
}

function isSettlePayload(value: unknown): boolean {
  return isRecord(value) && exactRecord(value, ['businessDay']) && value.businessDay === 1;
}

function isReplayPayload(value: unknown): boolean {
  return isRecord(value) && exactRecord(value, ['businessDay']) && positiveSafeInteger(value.businessDay);
}

function exactRecord(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value > 0;
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function numericRecord(value: unknown): boolean {
  return isRecord(value) && Object.entries(value).every(([key, amount]) => nonEmptyString(key) && typeof amount === 'number' && Number.isFinite(amount));
}

function sha256(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function recoveredMutationMatchesState(
  mutation: GameplayMutationRequest,
  state: WebGameplayState,
): boolean {
  if (mutation.kind === 'INITIALIZE_COMPETITIVE_SAVE') {
    return state.tag === 'initialize' && state.bootstrap.expectedVersion === mutation.input.expectedVersion;
  }
  if (!('projection' in state)) return false;
  const projection = state.projection;
  if (projection.save.id !== mutation.saveId || projection.expectedVersion !== mutation.input.expectedVersion) {
    return false;
  }
  switch (mutation.kind) {
    case 'CONFIGURE_PREOPEN_DAY':
      return state.tag === 'configure';
    case 'OPEN_BUSINESS_DAY':
      return (
        state.tag === 'open' &&
        projection.preopenSnapshot?.id === mutation.input.payload.preopenSnapshotId &&
        projection.preopenSnapshot.hash === mutation.input.payload.preopenSnapshotHash
      );
    case 'ADVANCE_SERVICE_PERIOD':
      return (
        state.tag === 'advance' &&
        projection.businessDay?.businessDay === mutation.input.payload.businessDay &&
        projection.businessDay.nextPeriodKey === mutation.input.payload.expectedPeriodKey
      );
    case 'SETTLE_BUSINESS_DAY':
      return state.tag === 'settle' && projection.businessDay?.businessDay === mutation.input.payload.businessDay;
    case 'REQUEST_DAY_REPLAY':
      return state.tag === 'replay' && projection.dayEnd?.businessDay === mutation.input.payload.businessDay;
    default:
      return false;
  }
}

function unreachable(value: never): never {
  throw new GameplayMachineError(`GAMEPLAY_UNREACHABLE_${String(value)}`);
}
