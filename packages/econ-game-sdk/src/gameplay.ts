import {
  COMMAND_ENVELOPE_VERSION,
  GameCommandClient,
  type GameCommandAccepted,
  type GameCommandCompleted,
  type CommandValue,
  type GameCommandEnvelope,
  type GameCommandSuccess,
  validateGameCommandSuccess,
} from './game-command.js';
import { encodePathSegment, type EconGameClientOptions } from './core.js';

export const BOOTSTRAP_COMMAND_ENVELOPE_VERSION = 'd02-bootstrap-command/v1' as const;

export type GameplayCommandType =
  | 'CONFIGURE_PREOPEN_DAY'
  | 'OPEN_BUSINESS_DAY'
  | 'ADVANCE_SERVICE_PERIOD'
  | 'SETTLE_BUSINESS_DAY'
  | 'REQUEST_DAY_REPLAY';

type GameplayCommandPayload = Readonly<Record<string, CommandValue>>;

export type GameplayCommandInput<TPayload extends GameplayCommandPayload> = Readonly<{
  commandId: string;
  idempotencyKey: string;
  /** Use the previous projection or command receipt aggregateVersion unchanged. */
  expectedVersion: number;
  payload: TPayload;
}>;

/** The aggregateVersion in a receipt is the only SDK handoff for the next mutation. */
export type GameplayCommandReceipt<T extends CommandValue = CommandValue> =
  GameCommandCompleted<T>;

export type GameplayReplayRequestReceipt<T extends CommandValue = CommandValue> =
  GameCommandAccepted<T>;

export type InitializeCompetitiveSaveIntent = Readonly<{
  scenario: string;
  operatingMode: string;
  settlementCurrency: string;
  servicePeriodPlan: string;
}>;

export type InitializeCompetitiveSaveInput = GameplayCommandInput<InitializeCompetitiveSaveIntent>;

export type FloorFixtureIntent = Readonly<{
  fixtureId: string;
  kind: 'SEAT' | 'WALKWAY' | 'WAITING_ZONE';
  x: number;
  y: number;
}>;

export type ConfigurePreopenDayIntent = Readonly<{
  menuChoice: Readonly<{
    themeId: string;
    recipeVersionIds: readonly string[];
    priceModifierPercentByRecipe: Readonly<Record<string, number>>;
    enabledSubstitutionIds: readonly string[];
  }>;
  floorPlan: Readonly<{
    width: number;
    height: number;
    servicePoint: Readonly<{ x: number; y: number }>;
    fixtures: readonly FloorFixtureIntent[];
  }>;
  spotPurchaseDeltas: readonly Readonly<{
    ingredientId: string;
    quantityPoints: number;
  }>[];
}>;

export type OpenBusinessDayIntent = Readonly<{
  preopenSnapshotId: string;
  preopenSnapshotHash: string;
}>;

export type AdvanceServicePeriodIntent = Readonly<{
  businessDay: 1;
  expectedPeriodKey: 'LUNCH' | 'OFF_PEAK' | 'DINNER';
  ownerAssignment: 'KITCHEN' | 'FRONT' | 'NONE';
}>;

export type SettleBusinessDayIntent = Readonly<{ businessDay: 1 }>;
export type RequestDayReplayIntent = Readonly<{ businessDay: number }>;

export type GameplayPhase =
  | 'CONFIGURE_REQUIRED'
  | 'OPEN_REQUIRED'
  | 'ADVANCE_REQUIRED'
  | 'SETTLE_REQUIRED'
  | 'REPLAY_AVAILABLE';

export type GameplayProjection = Readonly<{
  schemaVersion: 'gameplay.current-projection/v1';
  save: Readonly<{
    id: string;
    aggregateVersion: number;
    openingScenario: string;
    operatingMode: string;
    servicePeriodPlan: 'TWO_PERIODS' | 'THREE_PERIODS';
    difficultyGroup: string;
    simulationRuleVersion: string;
  }>;
  phase: GameplayPhase;
  nextCommand: GameplayCommandType;
  /** Pass unchanged to the next save-scoped mutation helper. */
  expectedVersion: number;
  /** Present only while OPEN_BUSINESS_DAY is the authorized next command. */
  preopenSnapshot?: Readonly<{ id: string; hash: string }>;
  businessDay: null | Readonly<{
    businessDay: 1;
    status: 'PREOPEN' | 'OPEN' | 'SERVICE_COMPLETE' | 'SETTLED';
    simulationRuleVersion: string;
    completedServicePeriods: number;
    totalServicePeriods: 2 | 3;
    nextPeriodKey: 'LUNCH' | 'OFF_PEAK' | 'DINNER' | null;
  }>;
  dayEnd: null | Readonly<{
    businessDay: 1;
    dayEndSnapshotId: string;
    eventHash: string;
    snapshotHash: string;
  }>;
}>;

export type ActiveGameplaySaveDiscovery =
  | Readonly<{
      schemaVersion: 'gameplay.active-save-discovery/v1';
      state: 'INITIALIZE_REQUIRED';
      bootstrap: Readonly<{
        route: '/bootstrap/actions/INITIALIZE_COMPETITIVE_SAVE';
        aggregateId: string;
        expectedVersion: number;
      }>;
      activeSave: null;
    }>
  | Readonly<{
      schemaVersion: 'gameplay.active-save-discovery/v1';
      state: 'ACTIVE_SAVE';
      bootstrap: null;
      activeSave: GameplayProjection;
    }>;

export type ReplayJobPendingProjection = Readonly<{
  schemaVersion: 'gameplay.replay-job/v1';
  jobId: string;
  saveId: string;
  businessDay: number;
  status: 'QUEUED' | 'RUNNING' | 'RETRYING';
  terminal: false;
}>;

export type ReplayJobCompletedProjection = Readonly<{
  schemaVersion: 'gameplay.replay-job/v1';
  jobId: string;
  saveId: string;
  businessDay: number;
  status: 'MATCH' | 'MISMATCH';
  terminal: true;
  verification: Readonly<{
    eventCount: number;
    eventHash: Readonly<{ expected: string; computed: string; match: boolean }>;
    snapshotHash: Readonly<{ expected: string; computed: string; match: boolean }>;
  }>;
  failure?: never;
}>;

export type ReplayJobFailedProjection = Readonly<{
  schemaVersion: 'gameplay.replay-job/v1';
  jobId: string;
  saveId: string;
  businessDay: number;
  status: 'PERMANENT_FAILURE' | 'RETRY_EXHAUSTED';
  terminal: true;
  failure: Readonly<{ retryable: false; category: 'PERMANENT' | 'RETRY_EXHAUSTED' }>;
  verification?: never;
}>;

export type ReplayJobProjection =
  | ReplayJobPendingProjection
  | ReplayJobCompletedProjection
  | ReplayJobFailedProjection;

export type ReplayJobPollResponse = Readonly<{
  status: 200 | 202;
  body: ReplayJobProjection;
}>;

/** Public, Web-only Day 1 choices for constructing a CONFIGURE_PREOPEN_DAY intent. */
export type PreopenConfigurationChoices = Readonly<{
  save: Readonly<{
    id: string;
    expectedVersion: number;
    scenario: 'EMPTY_PREMISES' | 'DEFAULT_SMALL_SHOP' | 'TROUBLED_SHOP';
    operatingMode: 'STRATEGY' | 'LIGHTWEIGHT_REALTIME';
    servicePeriodPlan: 'TWO_PERIODS' | 'THREE_PERIODS';
    servicePeriods: readonly ('LUNCH' | 'OFF_PEAK' | 'DINNER')[];
    simulationRuleVersion: 'mvp-e01-v1';
  }>;
  businessDay: 1;
  versions: Readonly<{
    preopenSchema: 'p0-preopen-day/v1';
    openingCatalog: 'mvp-e01-opening-v2';
    simulationRule: 'mvp-e01-v1';
    currencyMetadata: 'iso-4217-mvp/v1';
    catalog: 'mvp-first-day-catalog/v1';
    ingredientCatalog: 'mvp-first-day-ingredients/v1';
    recipeCatalog: 'mvp-first-day-recipes/v1';
    substitutionCatalog: 'mvp-first-day-substitutions/v1';
    floorSpace: 'e02-space-v1';
  }>;
  menu: Readonly<{
    difficulty: 'STANDARD';
    requiredRecipeCount: 3;
    themeId: 'bistro';
    recipeCards: readonly PreopenRecipeCard[];
    substitutions: readonly PreopenSubstitution[];
  }>;
  procurement: Readonly<{
    settlementCurrency: 'TWD' | 'USD';
    spendLimit: PreopenMoney;
    poolCapacities: Readonly<{ DURABLE: number; PERISHABLE: number }>;
    lockedDay1Quotes: readonly PreopenQuote[];
  }>;
  floor: PreopenFloorChoices;
}>;

export type PreopenMoney = Readonly<{ currency: 'TWD' | 'USD'; minorUnits: string }>;
export type PreopenIngredientRequirement = Readonly<{ ingredientId: string; quantityPoints: number }>;
export type PreopenRecipeCard = Readonly<{
  recipeVersionId: string;
  recipeId: string;
  baseQuality: number;
  ingredients: readonly PreopenIngredientRequirement[];
  basePrice: PreopenMoney;
  priceOptions: readonly Readonly<{ modifierPercent: number; salePrice: PreopenMoney }>[];
  substitutionIds: readonly string[];
}>;
export type PreopenSubstitution = Readonly<{
  id: string;
  recipeVersionId: string;
  priority: number;
  qualityDelta: number;
  ingredients: readonly PreopenIngredientRequirement[];
}>;
export type PreopenQuote = Readonly<{
  ingredientId: string;
  pool: 'DURABLE' | 'PERISHABLE';
  unitPrice: PreopenMoney;
  priceModifierBps: 0;
}>;
export type PreopenFloorChoices = Readonly<{
  catalogVersion: 'e02-space-v1';
  width: number;
  height: number;
  usableFloorCells: number;
  maxSeats: number;
  maxWaitingGroups: number;
  allowedFixtureKinds: readonly ('SEAT' | 'WALKWAY' | 'WAITING_ZONE')[];
  constraints: Readonly<{
    phase: 'PRE_OPEN';
    exactScenarioDimensionsRequired: true;
    servicePointInBoundsRequired: true;
    servicePointMustNotOverlapFixture: true;
    fixtureIdsMustBeUnique: true;
    fixturesMustBeInBounds: true;
    fixturesMustNotOverlap: true;
    seatsAndWaitingZonesRequireWalkwayConnection: true;
  }>;
}>;

type BootstrapCommandEnvelope = Readonly<{
  schemaVersion: typeof BOOTSTRAP_COMMAND_ENVELOPE_VERSION;
  commandId: string;
  idempotencyKey: string;
  commandType: 'INITIALIZE_COMPETITIVE_SAVE';
  expectedVersion: number;
  payload: InitializeCompetitiveSaveIntent;
}>;

/**
 * Typed P0 gameplay transport. It has no actor, player, tenant, role, seed,
 * money, or authority parameters: callers supply only their approved headers.
 * Mutations are deliberately one-shot; idempotency and retries remain caller-owned.
 */
export class GameplayApiClient extends GameCommandClient {
  initializeCompetitiveSave(
    input: InitializeCompetitiveSaveInput,
  ): Promise<GameplayCommandReceipt> {
    const envelope: BootstrapCommandEnvelope = Object.freeze({
      schemaVersion: BOOTSTRAP_COMMAND_ENVELOPE_VERSION,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'INITIALIZE_COMPETITIVE_SAVE',
      expectedVersion: input.expectedVersion,
      payload: input.payload,
    });
    return this.requestWithStatus<unknown>({
      method: 'POST',
      path: '/bootstrap/actions/INITIALIZE_COMPETITIVE_SAVE',
      body: envelope,
    }).then((response) => validateBootstrapCommandResponse(response.status, response.body));
  }

  getActiveSave(): Promise<ActiveGameplaySaveDiscovery> {
    return this.request<unknown>({
      method: 'GET',
      path: '/gameplay/active-save',
    }).then(validateActiveSaveDiscovery);
  }

  getGameplayProjection(saveId: string): Promise<GameplayProjection> {
    assertIdentifier(saveId, 'saveId');
    return this.request<unknown>({
      method: 'GET',
      path: `/saves/${encodePathSegment(saveId)}/gameplay`,
    }).then(validateGameplayProjection);
  }

  /** Web-only server-authoritative choices; this never builds or dispatches a configuration. */
  getPreopenConfigurationChoices(saveId: string): Promise<PreopenConfigurationChoices> {
    assertIdentifier(saveId, 'saveId');
    return this.request<unknown>({
      method: 'GET',
      path: `/saves/${encodePathSegment(saveId)}/preopen/configuration-choices`,
    }).then((body) => validatePreopenConfigurationChoicesTarget(body, saveId));
  }

  pollReplayJob(saveId: string, jobId: string): Promise<ReplayJobPollResponse> {
    assertIdentifier(saveId, 'saveId');
    assertIdentifier(jobId, 'jobId');
    return this.requestWithStatus<ReplayJobProjection>({
      method: 'GET',
      path: `/saves/${encodePathSegment(saveId)}/replay-jobs/${encodePathSegment(jobId)}`,
    }).then((response) =>
      validateReplayJobTarget(validateReplayJobResponse(response.status, response.body), {
        saveId,
        jobId,
      }),
    );
  }

  /**
   * Recovers the single existing first-day replay job after a client reload.
   * This is a read-only lookup; it never requests or retries replay creation.
   */
  getLatestReplayJob(saveId: string, businessDay: 1): Promise<ReplayJobPollResponse> {
    assertIdentifier(saveId, 'saveId');
    if (businessDay !== 1) {
      throw new TypeError('Replay recovery only supports businessDay 1.');
    }
    return this.requestWithStatus<ReplayJobProjection>({
      method: 'GET',
      path: `/saves/${encodePathSegment(saveId)}/replay-jobs/latest?businessDay=1`,
    }).then((response) =>
      validateReplayJobTarget(validateReplayJobResponse(response.status, response.body), {
        saveId,
        businessDay,
      }),
    );
  }

  configurePreopenDay(
    saveId: string,
    input: GameplayCommandInput<ConfigurePreopenDayIntent>,
  ): Promise<GameplayCommandReceipt> {
    return this.executeGameplayCommand(saveId, 'CONFIGURE_PREOPEN_DAY', input);
  }

  openBusinessDay(
    saveId: string,
    input: GameplayCommandInput<OpenBusinessDayIntent>,
  ): Promise<GameplayCommandReceipt> {
    return this.executeGameplayCommand(saveId, 'OPEN_BUSINESS_DAY', input);
  }

  advanceServicePeriod(
    saveId: string,
    input: GameplayCommandInput<AdvanceServicePeriodIntent>,
  ): Promise<GameplayCommandReceipt> {
    return this.executeGameplayCommand(saveId, 'ADVANCE_SERVICE_PERIOD', input);
  }

  settleBusinessDay(
    saveId: string,
    input: GameplayCommandInput<SettleBusinessDayIntent>,
  ): Promise<GameplayCommandReceipt> {
    return this.executeGameplayCommand(saveId, 'SETTLE_BUSINESS_DAY', input);
  }

  requestDayReplay(
    saveId: string,
    input: GameplayCommandInput<RequestDayReplayIntent>,
  ): Promise<GameplayReplayRequestReceipt> {
    const envelope = this.buildGameplayEnvelope(saveId, 'REQUEST_DAY_REPLAY', input);
    return this.executeSaveAction(saveId, 'REQUEST_DAY_REPLAY', envelope).then(
      (receipt) => validateReplayRequestResponse(receipt, saveId),
    );
  }

  private executeGameplayCommand<TPayload extends GameplayCommandPayload>(
    saveId: string,
    commandType: Exclude<GameplayCommandType, 'REQUEST_DAY_REPLAY'>,
    input: GameplayCommandInput<TPayload>,
  ): Promise<GameplayCommandReceipt> {
    const envelope = this.buildGameplayEnvelope(saveId, commandType, input);
    return this.executeSaveAction(saveId, commandType, envelope).then((receipt) =>
      validateCompletedCommandResponse(receipt, commandType, saveId),
    );
  }

  private buildGameplayEnvelope<TPayload extends GameplayCommandPayload>(
    saveId: string,
    commandType: GameplayCommandType,
    input: GameplayCommandInput<TPayload>,
  ): GameCommandEnvelope {
    return Object.freeze({
      schemaVersion: COMMAND_ENVELOPE_VERSION,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      commandType,
      aggregateId: saveId,
      expectedVersion: input.expectedVersion,
      payload: input.payload,
    });
  }
}

export const createGameplayApiClient = (options: EconGameClientOptions): GameplayApiClient =>
  new GameplayApiClient(options);

/**
 * Version-pinned raw response validator for clients that inject a gameplay
 * transport. It reuses the same strict SDK decoders as GameplayApiClient;
 * callers cannot supply a permissive pass-through guard.
 */
export const GAMEPLAY_RESPONSE_VALIDATION_VERSION = 'gameplay-response-validation/v1' as const;

export type GameplayResponseValidationGuard = Readonly<{
  version: typeof GAMEPLAY_RESPONSE_VALIDATION_VERSION;
  activeSaveDiscovery: (value: unknown) => ActiveGameplaySaveDiscovery;
  gameplayProjection: (value: unknown) => GameplayProjection;
  preopenConfigurationChoices: (value: unknown) => PreopenConfigurationChoices;
  replayJobPollResponse: (value: unknown) => ReplayJobPollResponse;
}>;

export function createGameplayResponseValidationGuard(
  expectedVersion: typeof GAMEPLAY_RESPONSE_VALIDATION_VERSION,
): GameplayResponseValidationGuard {
  if (expectedVersion !== GAMEPLAY_RESPONSE_VALIDATION_VERSION) {
    throw new RangeError('Gameplay response validation version is unsupported.');
  }
  return Object.freeze({
    version: GAMEPLAY_RESPONSE_VALIDATION_VERSION,
    activeSaveDiscovery: validateActiveSaveDiscovery,
    gameplayProjection: validateGameplayProjection,
    preopenConfigurationChoices: validatePreopenConfigurationChoices,
    replayJobPollResponse: (value: unknown): ReplayJobPollResponse => {
      const response = plainRecord(value, 'replay job poll response');
      exactKeys(response, ['body', 'status'], 'replay job poll response');
      if (response.status !== 200 && response.status !== 202) {
        throw new TypeError('Replay job poll response has an unsupported status.');
      }
      return validateReplayJobResponse(response.status, response.body);
    },
  });
}

const projectionBaseKeys = Object.freeze([
  'businessDay',
  'dayEnd',
  'expectedVersion',
  'nextCommand',
  'phase',
  'save',
  'schemaVersion',
]);
const phaseCommand = Object.freeze({
  CONFIGURE_REQUIRED: 'CONFIGURE_PREOPEN_DAY',
  OPEN_REQUIRED: 'OPEN_BUSINESS_DAY',
  ADVANCE_REQUIRED: 'ADVANCE_SERVICE_PERIOD',
  SETTLE_REQUIRED: 'SETTLE_BUSINESS_DAY',
  REPLAY_AVAILABLE: 'REQUEST_DAY_REPLAY',
} satisfies Readonly<Record<GameplayPhase, GameplayCommandType>>);
const periodOrder = Object.freeze({
  TWO_PERIODS: Object.freeze(['LUNCH', 'DINNER'] as const),
  THREE_PERIODS: Object.freeze(['LUNCH', 'OFF_PEAK', 'DINNER'] as const),
});

function validateActiveSaveDiscovery(value: unknown): ActiveGameplaySaveDiscovery {
  const discovery = plainRecord(value, 'active-save discovery');
  exactKeys(
    discovery,
    ['activeSave', 'bootstrap', 'schemaVersion', 'state'],
    'active-save discovery',
  );
  if (discovery.schemaVersion !== 'gameplay.active-save-discovery/v1') {
    throw new TypeError('Active-save discovery schemaVersion is unsupported.');
  }
  if (discovery.state === 'INITIALIZE_REQUIRED') {
    if (discovery.activeSave !== null) {
      throw new TypeError('INITIALIZE_REQUIRED discovery must not include an active save.');
    }
    const bootstrap = plainRecord(discovery.bootstrap, 'active-save bootstrap handoff');
    exactKeys(
      bootstrap,
      ['aggregateId', 'expectedVersion', 'route'],
      'active-save bootstrap handoff',
    );
    if (
      bootstrap.route !== '/bootstrap/actions/INITIALIZE_COMPETITIVE_SAVE' ||
      !boundedString(bootstrap.aggregateId) ||
      !nonNegativeSafeInteger(bootstrap.expectedVersion)
    ) {
      throw new TypeError('Active-save bootstrap handoff is malformed.');
    }
  } else if (discovery.state === 'ACTIVE_SAVE') {
    if (discovery.bootstrap !== null) {
      throw new TypeError('ACTIVE_SAVE discovery must not include a bootstrap handoff.');
    }
    validateGameplayProjection(discovery.activeSave);
  } else {
    throw new TypeError('Active-save discovery state is unsupported.');
  }
  return discovery as ActiveGameplaySaveDiscovery;
}

function validatePreopenConfigurationChoicesTarget(
  value: unknown,
  requestedSaveId: string,
): PreopenConfigurationChoices {
  const choices = validatePreopenConfigurationChoices(value);
  if (choices.save.id !== requestedSaveId) {
    throw new TypeError('Pre-open choices response does not match the requested save scope.');
  }
  return choices;
}

function validatePreopenConfigurationChoices(value: unknown): PreopenConfigurationChoices {
  const choices = plainRecord(value, 'pre-open configuration choices');
  exactKeys(choices, ['businessDay', 'floor', 'menu', 'procurement', 'save', 'versions'], 'pre-open configuration choices');
  if (choices.businessDay !== 1) throw new TypeError('Pre-open choices are only valid for business day 1.');

  const save = plainRecord(choices.save, 'pre-open choices save');
  exactKeys(save, ['expectedVersion', 'id', 'operatingMode', 'scenario', 'servicePeriodPlan', 'servicePeriods', 'simulationRuleVersion'], 'pre-open choices save');
  if (
    !boundedString(save.id) || !nonNegativeSafeInteger(save.expectedVersion) ||
    !['EMPTY_PREMISES', 'DEFAULT_SMALL_SHOP', 'TROUBLED_SHOP'].includes(String(save.scenario)) ||
    !['STRATEGY', 'LIGHTWEIGHT_REALTIME'].includes(String(save.operatingMode)) ||
    !['TWO_PERIODS', 'THREE_PERIODS'].includes(String(save.servicePeriodPlan)) ||
    save.simulationRuleVersion !== 'mvp-e01-v1'
  ) throw new TypeError('Pre-open choices save is malformed.');
  const expectedPeriods = save.servicePeriodPlan === 'TWO_PERIODS'
    ? ['LUNCH', 'DINNER'] : ['LUNCH', 'OFF_PEAK', 'DINNER'];
  if (!sameStringArray(save.servicePeriods, expectedPeriods)) {
    throw new TypeError('Pre-open choices service periods do not match the locked period plan.');
  }

  const versions = plainRecord(choices.versions, 'pre-open choices versions');
  exactKeys(versions, ['catalog', 'currencyMetadata', 'floorSpace', 'ingredientCatalog', 'openingCatalog', 'preopenSchema', 'recipeCatalog', 'simulationRule', 'substitutionCatalog'], 'pre-open choices versions');
  const requiredVersions: Readonly<Record<string, string>> = {
    preopenSchema: 'p0-preopen-day/v1', openingCatalog: 'mvp-e01-opening-v2', simulationRule: 'mvp-e01-v1',
    currencyMetadata: 'iso-4217-mvp/v1', catalog: 'mvp-first-day-catalog/v1', ingredientCatalog: 'mvp-first-day-ingredients/v1',
    recipeCatalog: 'mvp-first-day-recipes/v1', substitutionCatalog: 'mvp-first-day-substitutions/v1', floorSpace: 'e02-space-v1',
  };
  for (const [key, expected] of Object.entries(requiredVersions)) {
    if (versions[key] !== expected) throw new TypeError(`Pre-open choices has an unsupported ${key} version.`);
  }

  const procurement = validatePreopenProcurement(choices.procurement);
  const settlementCurrency = procurement.settlementCurrency as string;
  const menu = validatePreopenMenu(choices.menu, settlementCurrency);
  validatePreopenQuotes(procurement.lockedDay1Quotes as readonly unknown[], menu, settlementCurrency);
  validatePreopenFloor(choices.floor);
  assertNoPrivateAuthorityFields(choices, 'pre-open configuration choices');
  return choices as PreopenConfigurationChoices;
}

function validatePreopenMenu(value: unknown, currency: string): Record<string, unknown> {
  const menu = plainRecord(value, 'pre-open choices menu');
  exactKeys(menu, ['difficulty', 'recipeCards', 'requiredRecipeCount', 'substitutions', 'themeId'], 'pre-open choices menu');
  if (menu.difficulty !== 'STANDARD' || menu.requiredRecipeCount !== 3 || menu.themeId !== 'bistro' || !Array.isArray(menu.recipeCards) || !Array.isArray(menu.substitutions) || menu.recipeCards.length < menu.requiredRecipeCount) {
    throw new TypeError('Pre-open choices menu is malformed.');
  }
  const recipeIds = new Set<string>();
  const recipeVersionIds = new Set<string>();
  const cardSubstitutionIds = new Set<string>();
  const substitutionOwner = new Map<string, string>();
  for (const rawCard of menu.recipeCards) {
    const card = plainRecord(rawCard, 'pre-open recipe card');
    exactKeys(card, ['basePrice', 'baseQuality', 'ingredients', 'priceOptions', 'recipeId', 'recipeVersionId', 'substitutionIds'], 'pre-open recipe card');
    const recipeVersionId = card.recipeVersionId;
    const recipeId = card.recipeId;
    const baseQuality = card.baseQuality;
    if (!boundedString(recipeVersionId) || !boundedString(recipeId) || typeof baseQuality !== 'number' || !Number.isInteger(baseQuality) || baseQuality < 75 || baseQuality > 90 || !Array.isArray(card.ingredients) || !Array.isArray(card.priceOptions) || !Array.isArray(card.substitutionIds) || recipeVersionIds.has(recipeVersionId) || recipeIds.has(recipeId)) {
      throw new TypeError('Pre-open recipe card is malformed.');
    }
    recipeVersionIds.add(recipeVersionId); recipeIds.add(recipeId);
    validatePreopenMoney(card.basePrice, currency, 'pre-open recipe base price');
    validateIngredientRequirements(card.ingredients, 'pre-open recipe ingredients');
    if (!sameNumberArray(card.priceOptions.map((option) => plainRecord(option, 'pre-open price option').modifierPercent), Array.from({ length: 21 }, (_, index) => index - 10))) {
      throw new TypeError('Pre-open recipe prices must contain the canonical -10 through +10 options.');
    }
    for (const rawOption of card.priceOptions) {
      const option = plainRecord(rawOption, 'pre-open price option');
      exactKeys(option, ['modifierPercent', 'salePrice'], 'pre-open price option');
      const modifierPercent = option.modifierPercent;
      if (typeof modifierPercent !== 'number' || !Number.isInteger(modifierPercent) || modifierPercent < -10 || modifierPercent > 10) throw new TypeError('Pre-open price modifier is malformed.');
      validatePreopenMoney(option.salePrice, currency, 'pre-open recipe sale price');
    }
    const substitutionIds = uniqueBoundedStrings(card.substitutionIds, 'pre-open recipe substitution IDs');
    for (const id of substitutionIds) {
      if (substitutionOwner.has(id)) throw new TypeError('Pre-open substitutions may belong to only one recipe card.');
      cardSubstitutionIds.add(id); substitutionOwner.set(id, recipeVersionId);
    }
  }
  const substitutionIds = new Set<string>();
  for (const rawSubstitution of menu.substitutions) {
    const substitution = plainRecord(rawSubstitution, 'pre-open substitution');
    exactKeys(substitution, ['id', 'ingredients', 'priority', 'qualityDelta', 'recipeVersionId'], 'pre-open substitution');
    if (!boundedString(substitution.id) || !recipeVersionIds.has(substitution.recipeVersionId as string) || substitutionOwner.get(substitution.id as string) !== substitution.recipeVersionId || !positiveSafeInteger(substitution.priority) || !Number.isInteger(substitution.qualityDelta) || !Array.isArray(substitution.ingredients) || substitutionIds.has(substitution.id)) {
      throw new TypeError('Pre-open substitution is malformed.');
    }
    substitutionIds.add(substitution.id);
    validateIngredientRequirements(substitution.ingredients, 'pre-open substitution ingredients');
  }
  if (substitutionIds.size !== cardSubstitutionIds.size || [...substitutionIds].some((id) => !cardSubstitutionIds.has(id))) {
    throw new TypeError('Pre-open recipe substitutions do not match the substitution catalog.');
  }
  return menu;
}

function validatePreopenProcurement(value: unknown): Record<string, unknown> {
  const procurement = plainRecord(value, 'pre-open choices procurement');
  exactKeys(procurement, ['lockedDay1Quotes', 'poolCapacities', 'settlementCurrency', 'spendLimit'], 'pre-open choices procurement');
  if ((procurement.settlementCurrency !== 'TWD' && procurement.settlementCurrency !== 'USD') || !Array.isArray(procurement.lockedDay1Quotes)) throw new TypeError('Pre-open procurement is malformed.');
  validatePreopenMoney(procurement.spendLimit, procurement.settlementCurrency, 'pre-open spend limit');
  const capacities = plainRecord(procurement.poolCapacities, 'pre-open pool capacities');
  exactKeys(capacities, ['DURABLE', 'PERISHABLE'], 'pre-open pool capacities');
  if (!positiveSafeInteger(capacities.DURABLE) || !positiveSafeInteger(capacities.PERISHABLE)) throw new TypeError('Pre-open pool capacities are malformed.');
  return procurement;
}

function validatePreopenQuotes(quotes: readonly unknown[], menu: Record<string, unknown>, currency: string): void {
  const ingredientIds = new Set<string>();
  for (const card of menu.recipeCards as readonly unknown[]) for (const item of plainRecord(card, 'pre-open recipe card').ingredients as readonly unknown[]) ingredientIds.add(plainRecord(item, 'pre-open ingredient').ingredientId as string);
  for (const substitution of menu.substitutions as readonly unknown[]) for (const item of plainRecord(substitution, 'pre-open substitution').ingredients as readonly unknown[]) ingredientIds.add(plainRecord(item, 'pre-open ingredient').ingredientId as string);
  const quoted = new Set<string>();
  for (const rawQuote of quotes) {
    const quote = plainRecord(rawQuote, 'pre-open locked quote');
    exactKeys(quote, ['ingredientId', 'pool', 'priceModifierBps', 'unitPrice'], 'pre-open locked quote');
    if (!boundedString(quote.ingredientId) || !ingredientIds.has(quote.ingredientId) || quoted.has(quote.ingredientId) || (quote.pool !== 'DURABLE' && quote.pool !== 'PERISHABLE') || quote.priceModifierBps !== 0) throw new TypeError('Pre-open locked quote is malformed.');
    validatePreopenMoney(quote.unitPrice, currency, 'pre-open locked quote price');
    quoted.add(quote.ingredientId);
  }
  if (quoted.size !== ingredientIds.size || [...ingredientIds].some((id) => !quoted.has(id))) throw new TypeError('Pre-open locked quotes must cover every menu ingredient exactly once.');
}

function validatePreopenFloor(value: unknown): void {
  const floor = plainRecord(value, 'pre-open floor choices');
  exactKeys(floor, ['allowedFixtureKinds', 'catalogVersion', 'constraints', 'height', 'maxSeats', 'maxWaitingGroups', 'usableFloorCells', 'width'], 'pre-open floor choices');
  if (floor.catalogVersion !== 'e02-space-v1' || !positiveSafeInteger(floor.width) || !positiveSafeInteger(floor.height) || floor.usableFloorCells !== floor.width * floor.height || !positiveSafeInteger(floor.maxSeats) || !nonNegativeSafeInteger(floor.maxWaitingGroups) || !sameStringArray(floor.allowedFixtureKinds, ['SEAT', 'WALKWAY', 'WAITING_ZONE'])) throw new TypeError('Pre-open floor choices are malformed.');
  const constraints = plainRecord(floor.constraints, 'pre-open floor constraints');
  const keys = ['exactScenarioDimensionsRequired', 'fixtureIdsMustBeUnique', 'fixturesMustBeInBounds', 'fixturesMustNotOverlap', 'phase', 'seatsAndWaitingZonesRequireWalkwayConnection', 'servicePointInBoundsRequired', 'servicePointMustNotOverlapFixture'];
  exactKeys(constraints, keys, 'pre-open floor constraints');
  if (constraints.phase !== 'PRE_OPEN' || keys.filter((key) => key !== 'phase').some((key) => constraints[key] !== true)) throw new TypeError('Pre-open floor constraints are malformed.');
}

function validateIngredientRequirements(values: readonly unknown[], name: string): void {
  if (values.length < 2 || values.length > 3) throw new TypeError(`${name} must contain two or three ingredients.`);
  let quantity = 0;
  const ingredientIds = new Set<string>();
  for (const rawValue of values) {
    const value = plainRecord(rawValue, name);
    exactKeys(value, ['ingredientId', 'quantityPoints'], name);
    if (!boundedString(value.ingredientId) || !positiveSafeInteger(value.quantityPoints) || ingredientIds.has(value.ingredientId)) throw new TypeError(`${name} is malformed.`);
    ingredientIds.add(value.ingredientId); quantity += value.quantityPoints;
  }
  if (quantity !== 3) throw new TypeError(`${name} must consume exactly three points.`);
}

function validatePreopenMoney(value: unknown, currency: string, name: string): void {
  const money = plainRecord(value, name);
  exactKeys(money, ['currency', 'minorUnits'], name);
  if (money.currency !== currency || !/^(?:0|[1-9]\d*)$/.test(String(money.minorUnits ?? ''))) throw new TypeError(`${name} is malformed.`);
}

function uniqueBoundedStrings(value: readonly unknown[], name: string): readonly string[] {
  if (value.some((item) => !boundedString(item)) || new Set(value).size !== value.length) throw new TypeError(`${name} are malformed.`);
  return value as readonly string[];
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function sameNumberArray(value: readonly unknown[], expected: readonly number[]): boolean {
  return value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function validateGameplayProjection(value: unknown): GameplayProjection {
  const projection = plainRecord(value, 'gameplay projection');
  const hasPin = Object.hasOwn(projection, 'preopenSnapshot');
  exactKeys(
    projection,
    hasPin ? [...projectionBaseKeys, 'preopenSnapshot'] : projectionBaseKeys,
    'gameplay projection',
  );
  if (projection.schemaVersion !== 'gameplay.current-projection/v1') {
    throw new TypeError('Gameplay projection schemaVersion is unsupported.');
  }
  const save = plainRecord(projection.save, 'gameplay save projection');
  exactKeys(
    save,
    [
      'aggregateVersion',
      'difficultyGroup',
      'id',
      'openingScenario',
      'operatingMode',
      'servicePeriodPlan',
      'simulationRuleVersion',
    ],
    'gameplay save projection',
  );
  if (
    !boundedString(save.id) ||
    !nonNegativeSafeInteger(save.aggregateVersion) ||
    !boundedString(save.openingScenario) ||
    !boundedString(save.operatingMode) ||
    (save.servicePeriodPlan !== 'TWO_PERIODS' && save.servicePeriodPlan !== 'THREE_PERIODS') ||
    !boundedString(save.difficultyGroup) ||
    !boundedString(save.simulationRuleVersion) ||
    projection.expectedVersion !== save.aggregateVersion
  ) {
    throw new TypeError('Gameplay save projection is malformed.');
  }
  if (!Object.hasOwn(phaseCommand, String(projection.phase))) {
    throw new TypeError('Gameplay phase is unsupported.');
  }
  const phase = projection.phase as GameplayPhase;
  if (projection.nextCommand !== phaseCommand[phase]) {
    throw new TypeError('Gameplay nextCommand does not match its phase.');
  }

  if (phase === 'CONFIGURE_REQUIRED') {
    if (projection.businessDay !== null || projection.dayEnd !== null || hasPin) {
      throw new TypeError('CONFIGURE_REQUIRED projection has unauthorized day evidence.');
    }
    return projection as GameplayProjection;
  }

  const day = validateBusinessDayProjection(
    projection.businessDay,
    save.servicePeriodPlan,
    save.simulationRuleVersion,
  );
  if (phase === 'OPEN_REQUIRED') {
    const pin = plainRecord(projection.preopenSnapshot, 'pre-open recovery pin');
    exactKeys(pin, ['hash', 'id'], 'pre-open recovery pin');
    if (!boundedString(pin.id) || !sha256Pattern.test(String(pin.hash ?? ''))) {
      throw new TypeError('Pre-open recovery pin is malformed.');
    }
    if (
      day.status !== 'PREOPEN' ||
      day.completedServicePeriods !== 0 ||
      day.nextPeriodKey !== null ||
      projection.dayEnd !== null
    ) {
      throw new TypeError('OPEN_REQUIRED projection has contradictory day state.');
    }
    return projection as GameplayProjection;
  }
  if (hasPin) throw new TypeError('Pre-open recovery pin is only allowed in OPEN_REQUIRED.');

  if (phase === 'ADVANCE_REQUIRED') {
    const expectedPeriod = periodOrder[save.servicePeriodPlan][day.completedServicePeriods];
    if (
      day.status !== 'OPEN' ||
      day.completedServicePeriods >= day.totalServicePeriods ||
      day.nextPeriodKey !== expectedPeriod ||
      projection.dayEnd !== null
    ) {
      throw new TypeError('ADVANCE_REQUIRED projection has contradictory day state.');
    }
    return projection as GameplayProjection;
  }
  if (
    day.completedServicePeriods !== day.totalServicePeriods ||
    day.nextPeriodKey !== null
  ) {
    throw new TypeError('Terminal service projection has an incomplete day.');
  }
  if (phase === 'SETTLE_REQUIRED') {
    if (day.status !== 'SERVICE_COMPLETE' || projection.dayEnd !== null) {
      throw new TypeError('SETTLE_REQUIRED projection has contradictory day state.');
    }
    return projection as GameplayProjection;
  }
  if (day.status !== 'SETTLED') {
    throw new TypeError('REPLAY_AVAILABLE projection must reference a settled day.');
  }
  validateDayEndProjection(projection.dayEnd);
  return projection as GameplayProjection;
}

function validateBusinessDayProjection(
  value: unknown,
  plan: 'TWO_PERIODS' | 'THREE_PERIODS',
  simulationRuleVersion: unknown,
): NonNullable<GameplayProjection['businessDay']> {
  const day = plainRecord(value, 'business-day projection');
  exactKeys(
    day,
    [
      'businessDay',
      'completedServicePeriods',
      'nextPeriodKey',
      'simulationRuleVersion',
      'status',
      'totalServicePeriods',
    ],
    'business-day projection',
  );
  const total = periodOrder[plan].length;
  if (
    day.businessDay !== 1 ||
    !['PREOPEN', 'OPEN', 'SERVICE_COMPLETE', 'SETTLED'].includes(String(day.status)) ||
    day.simulationRuleVersion !== simulationRuleVersion ||
    !nonNegativeSafeInteger(day.completedServicePeriods) ||
    day.completedServicePeriods > total ||
    day.totalServicePeriods !== total ||
    (day.nextPeriodKey !== null && !periodOrder[plan].includes(day.nextPeriodKey as never))
  ) {
    throw new TypeError('Business-day projection is malformed.');
  }
  return day as NonNullable<GameplayProjection['businessDay']>;
}

function validateDayEndProjection(value: unknown): void {
  const dayEnd = plainRecord(value, 'day-end projection');
  exactKeys(
    dayEnd,
    ['businessDay', 'dayEndSnapshotId', 'eventHash', 'snapshotHash'],
    'day-end projection',
  );
  if (
    dayEnd.businessDay !== 1 ||
    !boundedString(dayEnd.dayEndSnapshotId) ||
    !sha256Pattern.test(String(dayEnd.eventHash ?? '')) ||
    !sha256Pattern.test(String(dayEnd.snapshotHash ?? ''))
  ) {
    throw new TypeError('Day-end projection is malformed.');
  }
}

function validateReceiptTarget(
  receipt: GameCommandSuccess,
  commandType: GameplayCommandType,
  saveId: string,
): void {
  if (receipt.commandType !== commandType || receipt.aggregateId !== saveId) {
    throw new TypeError('Gameplay command response does not match its requested command target.');
  }
}

function validateBootstrapResult(value: unknown): void {
  const result = plainRecord(value, 'bootstrap result');
  exactKeys(
    result,
    [
      'authorityId',
      'epochId',
      'epochNumber',
      'ownerAuditLogId',
      'ownerMembershipId',
      'provisionedRestaurantId',
      'replayed',
      'saveId',
    ],
    'bootstrap result',
  );
  if (
    !boundedString(result.authorityId) ||
    !boundedString(result.epochId) ||
    !positiveSafeInteger(result.epochNumber) ||
    !boundedString(result.ownerAuditLogId) ||
    !boundedString(result.ownerMembershipId) ||
    !boundedString(result.provisionedRestaurantId) ||
    typeof result.replayed !== 'boolean' ||
    !boundedString(result.saveId)
  ) {
    throw new TypeError('Bootstrap result is malformed.');
  }
}

function validateCommandResult(
  commandType: Exclude<GameplayCommandType, 'REQUEST_DAY_REPLAY'>,
  value: unknown,
  aggregateVersion: number,
  saveId: string,
): void {
  const result = plainRecord(value, `${commandType} result`);
  if (commandType === 'CONFIGURE_PREOPEN_DAY') {
    exactKeys(result, ['competitiveSave', 'preopenDaySnapshot'], `${commandType} result`);
    validateCompetitiveSaveResult(result.competitiveSave, aggregateVersion, saveId);
    validatePublicPreopenResult(result.preopenDaySnapshot);
  } else if (commandType === 'OPEN_BUSINESS_DAY') {
    exactKeys(
      result,
      ['businessDay', 'competitiveSave', 'demandForecast', 'preopenDaySnapshot'],
      `${commandType} result`,
    );
    validateCompetitiveSaveResult(result.competitiveSave, aggregateVersion, saveId);
    const day = plainRecord(result.businessDay, 'OPEN businessDay result');
    exactKeys(
      day,
      [
        'businessDay',
        'consumedPreopenSnapshotId',
        'id',
        'openSnapshotHash',
        'servicePeriodPlan',
        'simulationRuleVersion',
        'status',
      ],
      'OPEN businessDay result',
    );
    if (
      day.businessDay !== 1 ||
      day.status !== 'OPEN' ||
      !boundedString(day.id) ||
      !boundedString(day.consumedPreopenSnapshotId) ||
      !sha256Pattern.test(String(day.openSnapshotHash ?? '')) ||
      (day.servicePeriodPlan !== 'TWO_PERIODS' && day.servicePeriodPlan !== 'THREE_PERIODS') ||
      !boundedString(day.simulationRuleVersion)
    ) {
      throw new TypeError('OPEN businessDay result is malformed.');
    }
    const snapshot = plainRecord(result.preopenDaySnapshot, 'OPEN pre-open snapshot result');
    exactKeys(
      snapshot,
      ['id', 'revision', 'snapshotHash', 'snapshotSchemaVersion'],
      'OPEN pre-open snapshot result',
    );
    if (
      snapshot.id !== day.consumedPreopenSnapshotId ||
      snapshot.revision !== 1 ||
      snapshot.snapshotHash !== day.openSnapshotHash ||
      !boundedString(snapshot.snapshotSchemaVersion)
    ) {
      throw new TypeError('OPEN pre-open snapshot result is malformed.');
    }
    validateDemandForecast(result.demandForecast);
  } else if (commandType === 'ADVANCE_SERVICE_PERIOD') {
    exactKeys(
      result,
      ['businessDay', 'competitiveSave', 'servicePeriodExecution'],
      `${commandType} result`,
    );
    validateCompetitiveSaveResult(result.competitiveSave, aggregateVersion, saveId);
    const day = plainRecord(result.businessDay, 'ADVANCE businessDay result');
    exactKeys(
      day,
      ['businessDay', 'id', 'simulationRuleVersion', 'status'],
      'ADVANCE businessDay result',
    );
    if (
      day.businessDay !== 1 ||
      (day.status !== 'OPEN' && day.status !== 'SERVICE_COMPLETE') ||
      !boundedString(day.id) ||
      !boundedString(day.simulationRuleVersion)
    ) {
      throw new TypeError('ADVANCE businessDay result is malformed.');
    }
    validateServicePeriodResult(result.servicePeriodExecution, day.status === 'SERVICE_COMPLETE');
  } else {
    validateSettlementResult(result, aggregateVersion, saveId);
  }
  assertNoPrivateAuthorityFields(result, `${commandType} result`);
}

function validateCompetitiveSaveResult(
  value: unknown,
  aggregateVersion: number,
  saveId: string,
): void {
  const save = plainRecord(value, 'competitive save result');
  exactKeys(save, ['id', 'version'], 'competitive save result');
  if (save.id !== saveId || save.version !== aggregateVersion) {
    throw new TypeError('Competitive save result does not match the receipt.');
  }
}

function validatePublicPreopenResult(value: unknown): void {
  const snapshot = plainRecord(value, 'CONFIGURE pre-open result');
  exactKeys(
    snapshot,
    [
      'businessDay',
      'demandForecast',
      'envelopeVersion',
      'floorPlan',
      'menu',
      'preopenSnapshotHash',
      'preopenSnapshotId',
    ],
    'CONFIGURE pre-open result',
  );
  if (
    snapshot.envelopeVersion !== 'p0-preopen-day/v1' ||
    snapshot.businessDay !== 1 ||
    !boundedString(snapshot.preopenSnapshotId) ||
    !sha256Pattern.test(String(snapshot.preopenSnapshotHash ?? ''))
  ) {
    throw new TypeError('CONFIGURE pre-open result is malformed.');
  }
  validatePublicMenu(snapshot.menu);
  validatePublicFloorPlan(snapshot.floorPlan);
  validateDemandForecast(snapshot.demandForecast);
}

function validatePublicMenu(value: unknown): void {
  const menu = plainRecord(value, 'CONFIGURE menu result');
  exactKeys(menu, ['items', 'themeId'], 'CONFIGURE menu result');
  if (!boundedString(menu.themeId) || !Array.isArray(menu.items)) {
    throw new TypeError('CONFIGURE menu result is malformed.');
  }
  for (const value of menu.items) {
    const item = plainRecord(value, 'CONFIGURE menu item');
    exactKeys(
      item,
      [
        'basePrice',
        'enabledSubstitutionIds',
        'priceModifierPercent',
        'recipeVersionId',
        'salePrice',
      ],
      'CONFIGURE menu item',
    );
    if (
      !boundedString(item.recipeVersionId) ||
      typeof item.priceModifierPercent !== 'number' ||
      !Number.isFinite(item.priceModifierPercent) ||
      !Array.isArray(item.enabledSubstitutionIds) ||
      item.enabledSubstitutionIds.some((id) => !boundedString(id))
    ) {
      throw new TypeError('CONFIGURE menu item is malformed.');
    }
    validateMoney(item.basePrice, 'CONFIGURE base price');
    validateMoney(item.salePrice, 'CONFIGURE sale price');
  }
}

function validatePublicFloorPlan(value: unknown): void {
  const floor = plainRecord(value, 'CONFIGURE floor-plan result');
  exactKeys(floor, ['layout', 'layoutHash', 'revision'], 'CONFIGURE floor-plan result');
  if (
    !nonNegativeSafeInteger(floor.revision) ||
    !sha256Pattern.test(String(floor.layoutHash ?? ''))
  ) {
    throw new TypeError('CONFIGURE floor-plan result is malformed.');
  }
  const layout = plainRecord(floor.layout, 'CONFIGURE layout result');
  exactKeys(layout, ['fixtures', 'height', 'servicePoint', 'width'], 'CONFIGURE layout result');
  if (
    !positiveSafeInteger(layout.width) ||
    !positiveSafeInteger(layout.height) ||
    !Array.isArray(layout.fixtures)
  ) {
    throw new TypeError('CONFIGURE layout result is malformed.');
  }
  validateGridPoint(layout.servicePoint, 'CONFIGURE service point');
  for (const value of layout.fixtures) {
    const fixture = plainRecord(value, 'CONFIGURE fixture');
    exactKeys(fixture, ['fixtureId', 'kind', 'x', 'y'], 'CONFIGURE fixture');
    if (
      !boundedString(fixture.fixtureId) ||
      !['SEAT', 'WALKWAY', 'WAITING_ZONE'].includes(String(fixture.kind))
    ) {
      throw new TypeError('CONFIGURE fixture is malformed.');
    }
    validateGridPoint(fixture, 'CONFIGURE fixture');
  }
}

function validateGridPoint(value: unknown, name: string): void {
  const point = plainRecord(value, name);
  if (!nonNegativeSafeInteger(point.x) || !nonNegativeSafeInteger(point.y)) {
    throw new TypeError(`${name} is malformed.`);
  }
}

function validateMoney(value: unknown, name: string): void {
  const money = plainRecord(value, name);
  exactKeys(money, ['currency', 'minorUnits'], name);
  if (
    !/^[A-Z]{3}$/.test(String(money.currency ?? '')) ||
    !/^(?:0|-?[1-9]\d*)$/.test(String(money.minorUnits ?? ''))
  ) {
    throw new TypeError(`${name} is malformed.`);
  }
}

function validateDemandForecast(value: unknown): void {
  const forecast = plainRecord(value, 'demand forecast');
  exactKeys(
    forecast,
    [
      'allDayGroups',
      'day',
      'disclosure',
      'patienceTicks',
      'periodPlan',
      'periods',
      'weather',
    ],
    'demand forecast',
  );
  if (
    forecast.day !== 1 ||
    (forecast.periodPlan !== 'TWO_PERIODS' && forecast.periodPlan !== 'THREE_PERIODS') ||
    !Array.isArray(forecast.periods)
  ) {
    throw new TypeError('Demand forecast is malformed.');
  }
  validateRange(forecast.allDayGroups, 'all-day demand range');
  const weather = plainRecord(forecast.weather, 'demand forecast weather');
  exactKeys(weather, ['demandModifierPercent', 'label'], 'demand forecast weather');
  if (!boundedString(weather.label) || typeof weather.demandModifierPercent !== 'number' || !Number.isFinite(weather.demandModifierPercent)) {
    throw new TypeError('Demand forecast weather is malformed.');
  }
  const expectedPeriods = periodOrder[forecast.periodPlan];
  if (forecast.periods.length !== expectedPeriods.length) {
    throw new TypeError('Demand forecast periods do not match the period plan.');
  }
  forecast.periods.forEach((value, index) => {
    const period = plainRecord(value, 'demand forecast period');
    exactKeys(period, ['groups', 'mainCohortTendencies', 'period'], 'demand forecast period');
    if (
      period.period !== expectedPeriods[index] ||
      !Array.isArray(period.mainCohortTendencies) ||
      period.mainCohortTendencies.some((cohort) => !cohorts.includes(cohort as never))
    ) {
      throw new TypeError('Demand forecast period is malformed.');
    }
    validateRange(period.groups, 'period demand range');
  });
  const patience = plainRecord(forecast.patienceTicks, 'demand forecast patience');
  exactKeys(patience, cohorts, 'demand forecast patience');
  for (const cohort of cohorts) validateRange(patience[cohort], `${cohort} patience range`);
  const disclosure = plainRecord(forecast.disclosure, 'demand forecast disclosure');
  exactKeys(
    disclosure,
    [
      'demandSeedShown',
      'exactArrivalTimesShown',
      'exactPatienceCountdownShown',
      'individualOrdersShown',
    ],
    'demand forecast disclosure',
  );
  if (Object.values(disclosure).some((flag) => flag !== false)) {
    throw new TypeError('Demand forecast disclosure is unsafe.');
  }
}

const cohorts = Object.freeze([
  'EXPERIENCE_ORIENTED',
  'PRICE_SENSITIVE',
  'TIME_SENSITIVE',
] as const);

function validateRange(value: unknown, name: string): void {
  const range = plainRecord(value, name);
  exactKeys(range, ['max', 'min'], name);
  if (
    !nonNegativeSafeInteger(range.min) ||
    !nonNegativeSafeInteger(range.max) ||
    range.min > range.max
  ) {
    throw new TypeError(`${name} is malformed.`);
  }
}

function validateServicePeriodResult(value: unknown, finalDay: boolean): void {
  const execution = plainRecord(value, 'service-period result');
  exactKeys(
    execution,
    ['finalPeriod', 'id', 'inputHash', 'ordinal', 'periodKey', 'resultHash', 'summary'],
    'service-period result',
  );
  if (
    !boundedString(execution.id) ||
    !positiveSafeInteger(execution.ordinal) ||
    !['LUNCH', 'OFF_PEAK', 'DINNER'].includes(String(execution.periodKey)) ||
    !sha256Pattern.test(String(execution.inputHash ?? '')) ||
    !sha256Pattern.test(String(execution.resultHash ?? '')) ||
    execution.finalPeriod !== finalDay
  ) {
    throw new TypeError('Service-period result is malformed.');
  }
  const summary = plainRecord(execution.summary, 'service-period summary');
  exactKeys(
    summary,
    ['flowRiskHigh', 'groupsDeparted', 'ordersServed', 'reputation'],
    'service-period summary',
  );
  if (
    typeof summary.flowRiskHigh !== 'boolean' ||
    !nonNegativeSafeInteger(summary.groupsDeparted) ||
    !nonNegativeSafeInteger(summary.ordersServed)
  ) {
    throw new TypeError('Service-period summary is malformed.');
  }
  validateReputation(summary.reputation);
}

function validateSettlementResult(
  result: Record<string, unknown>,
  aggregateVersion: number,
  saveId: string,
): void {
  exactKeys(
    result,
    [
      'businessDay',
      'businessDayId',
      'competitiveSave',
      'dayEndSnapshotId',
      'eventHash',
      'ledgerSummary',
      'reputation',
      'risk',
      'snapshotHash',
      'status',
      'summary',
    ],
    'SETTLE_BUSINESS_DAY result',
  );
  validateCompetitiveSaveResult(result.competitiveSave, aggregateVersion, saveId);
  if (
    result.businessDay !== 1 ||
    result.status !== 'SETTLED' ||
    !boundedString(result.businessDayId) ||
    !boundedString(result.dayEndSnapshotId) ||
    !sha256Pattern.test(String(result.eventHash ?? '')) ||
    !sha256Pattern.test(String(result.snapshotHash ?? ''))
  ) {
    throw new TypeError('SETTLE_BUSINESS_DAY result is malformed.');
  }
  const summary = plainRecord(result.summary, 'settlement summary');
  exactKeys(
    summary,
    ['ordersServed', 'servicePeriodsCompleted', 'wasteLinesRecorded'],
    'settlement summary',
  );
  if (Object.values(summary).some((item) => !nonNegativeSafeInteger(item))) {
    throw new TypeError('Settlement summary is malformed.');
  }
  const ledger = plainRecord(result.ledgerSummary, 'settlement ledger summary');
  exactKeys(ledger, ['balanced', 'currency', 'transactionId'], 'settlement ledger summary');
  if (
    ledger.balanced !== true ||
    !boundedString(ledger.currency) ||
    !boundedString(ledger.transactionId)
  ) {
    throw new TypeError('Settlement ledger summary is malformed.');
  }
  const risk = plainRecord(result.risk, 'settlement risk');
  exactKeys(
    risk,
    ['highRiskRevenueEnabled', 'leaderboardEligible', 'status', 'tags'],
    'settlement risk',
  );
  if (
    !boundedString(risk.status) ||
    !Array.isArray(risk.tags) ||
    risk.tags.some((tag) => !boundedString(tag)) ||
    typeof risk.highRiskRevenueEnabled !== 'boolean' ||
    typeof risk.leaderboardEligible !== 'boolean'
  ) {
    throw new TypeError('Settlement risk is malformed.');
  }
  validateReputation(result.reputation);
}

function validateReputation(value: unknown): void {
  const reputation = plainRecord(value, 'reputation');
  exactKeys(reputation, ['fairness', 'price', 'quality', 'speed', 'vibe'], 'reputation');
  if (Object.values(reputation).some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new TypeError('Reputation is malformed.');
  }
}

function validateReplayRequestResult(value: unknown): void {
  const result = plainRecord(value, 'REQUEST_DAY_REPLAY result');
  exactKeys(
    result,
    ['businessDay', 'eventHash', 'replayAvailability', 'snapshotHash'],
    'REQUEST_DAY_REPLAY result',
  );
  if (
    !positiveSafeInteger(result.businessDay) ||
    result.replayAvailability !== 'QUEUED' ||
    !sha256Pattern.test(String(result.eventHash ?? '')) ||
    !sha256Pattern.test(String(result.snapshotHash ?? ''))
  ) {
    throw new TypeError('REQUEST_DAY_REPLAY result is malformed.');
  }
  assertNoPrivateAuthorityFields(result, 'REQUEST_DAY_REPLAY result');
}

const privateAuthorityFieldNames = new Set([
  'accountingevidence',
  'arrivaltick',
  'cashavailable',
  'cost',
  'costs',
  'costpool',
  'demandseed',
  'hiddenpatienceticks',
  'inventoryprocurement',
  'inventory',
  'marketseed',
  'privatepayload',
  'recipepreferenceorder',
]);

function assertNoPrivateAuthorityFields(value: unknown, name: string): void {
  if (Array.isArray(value)) {
    for (const nested of value) assertNoPrivateAuthorityFields(nested, name);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (privateAuthorityFieldNames.has(key.toLowerCase())) {
      throw new TypeError(`${name} contains a private authority field.`);
    }
    assertNoPrivateAuthorityFields(nested, name);
  }
}

function validateBootstrapCommandResponse(
  status: number,
  body: unknown,
): GameplayCommandReceipt {
  if (status !== 200) {
    throw new TypeError('INITIALIZE_COMPETITIVE_SAVE must return a 200 response without a jobId.');
  }
  const receipt = validateGameCommandSuccess(status, body) as GameplayCommandReceipt;
  if (receipt.commandType !== 'INITIALIZE_COMPETITIVE_SAVE') {
    throw new TypeError('Bootstrap command response has an unexpected commandType.');
  }
  validateBootstrapResult(receipt.result);
  return receipt;
}

function validateCompletedCommandResponse(
  body: GameCommandSuccess,
  commandType: Exclude<GameplayCommandType, 'REQUEST_DAY_REPLAY'>,
  saveId: string,
): GameplayCommandReceipt {
  if (typeof (body as { jobId?: unknown }).jobId === 'string') {
    throw new TypeError('This gameplay command must not return a jobId.');
  }
  validateReceiptTarget(body, commandType, saveId);
  validateCommandResult(commandType, body.result, body.aggregateVersion, saveId);
  return body as GameplayCommandReceipt;
}

function validateReplayRequestResponse(
  body: GameCommandSuccess,
  saveId: string,
): GameplayReplayRequestReceipt {
  if (typeof (body as { jobId?: unknown }).jobId !== 'string') {
    throw new TypeError('REQUEST_DAY_REPLAY must return a non-empty jobId.');
  }
  validateReceiptTarget(body, 'REQUEST_DAY_REPLAY', saveId);
  validateReplayRequestResult(body.result);
  return body as GameplayReplayRequestReceipt;
}

function validateReplayJobResponse(status: number, body: unknown): ReplayJobPollResponse {
  const base = replayBase(body);
  if (base.terminal === false) {
    exactKeys(base, replayBaseKeys, 'pending replay job');
    if (status !== 202 || !pendingStatuses.has(base.status as string)) {
      throw new TypeError('Replay job HTTP status must match a valid pending state.');
    }
    return Object.freeze({ status: 202, body: base as ReplayJobPendingProjection });
  }
  if (status !== 200 || base.terminal !== true) {
    throw new TypeError('Replay job HTTP status must match its terminal state.');
  }
  if (base.status === 'MATCH' || base.status === 'MISMATCH') {
    exactKeys(base, [...replayBaseKeys, 'verification'], 'verified replay job');
    validateVerification(base.status, base.verification);
    return Object.freeze({ status: 200, body: base as ReplayJobCompletedProjection });
  }
  if (base.status === 'PERMANENT_FAILURE' || base.status === 'RETRY_EXHAUSTED') {
    exactKeys(base, [...replayBaseKeys, 'failure'], 'failed replay job');
    validateFailure(base.status, base.failure);
    return Object.freeze({ status: 200, body: base as ReplayJobFailedProjection });
  }
  throw new TypeError('Replay job terminal status is invalid.');
}

function validateReplayJobTarget(
  response: ReplayJobPollResponse,
  expected: Readonly<{ saveId: string; jobId?: string; businessDay?: 1 }>,
): ReplayJobPollResponse {
  if (
    response.body.saveId !== expected.saveId ||
    (expected.jobId !== undefined && response.body.jobId !== expected.jobId) ||
    (expected.businessDay !== undefined && response.body.businessDay !== expected.businessDay)
  ) {
    throw new TypeError('Replay job response does not match the requested scope.');
  }
  return response;
}

const replayBaseKeys = Object.freeze([
  'businessDay',
  'jobId',
  'saveId',
  'schemaVersion',
  'status',
  'terminal',
]);
const pendingStatuses = new Set(['QUEUED', 'RUNNING', 'RETRYING']);
const sha256Pattern = /^[0-9a-f]{64}$/;

function replayBase(value: unknown): Record<string, unknown> {
  const record = plainRecord(value, 'replay job');
  if (
    record.schemaVersion !== 'gameplay.replay-job/v1' ||
    !boundedString(record.jobId) ||
    !boundedString(record.saveId) ||
    !positiveSafeInteger(record.businessDay) ||
    typeof record.status !== 'string' ||
    typeof record.terminal !== 'boolean'
  ) {
    throw new TypeError('Replay job response has an invalid base shape.');
  }
  return record;
}

function validateVerification(status: 'MATCH' | 'MISMATCH', value: unknown): void {
  const verification = plainRecord(value, 'replay verification');
  exactKeys(verification, ['eventCount', 'eventHash', 'snapshotHash'], 'replay verification');
  if (!nonNegativeSafeInteger(verification.eventCount)) {
    throw new TypeError('Replay verification requires a non-negative eventCount.');
  }
  const eventMatch = validateHashVerification(verification.eventHash, 'eventHash');
  const snapshotMatch = validateHashVerification(verification.snapshotHash, 'snapshotHash');
  const derivedStatus = eventMatch && snapshotMatch ? 'MATCH' : 'MISMATCH';
  if (status !== derivedStatus) {
    throw new TypeError('Replay verification does not match its terminal status.');
  }
}

function validateHashVerification(value: unknown, name: string): boolean {
  const hash = plainRecord(value, `replay verification ${name}`);
  exactKeys(hash, ['computed', 'expected', 'match'], `replay verification ${name}`);
  if (
    !sha256Pattern.test(String(hash.expected ?? '')) ||
    !sha256Pattern.test(String(hash.computed ?? '')) ||
    typeof hash.match !== 'boolean' ||
    hash.match !== (hash.expected === hash.computed)
  ) {
    throw new TypeError(`Replay verification ${name} is invalid.`);
  }
  return hash.match;
}

function validateFailure(status: string, value: unknown): void {
  const failure = plainRecord(value, 'replay failure');
  exactKeys(failure, ['category', 'retryable'], 'replay failure');
  const category = status === 'PERMANENT_FAILURE' ? 'PERMANENT' : 'RETRY_EXHAUSTED';
  if (failure.retryable !== false || failure.category !== category) {
    throw new TypeError('Replay failure is not a safe terminal failure projection.');
  }
}

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expectedKeys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has unknown or missing fields.`);
  }
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertIdentifier(value: string, name: string): void {
  if (!value.trim()) throw new TypeError(`${name} must be non-empty.`);
}
