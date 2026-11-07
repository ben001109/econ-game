import type {
  ActiveGameplaySaveDiscovery,
  AdvanceServicePeriodIntent,
  ConfigurePreopenDayIntent,
  GameplayApiClient,
  GameplayCommandInput,
  GameplayProjection,
  InitializeCompetitiveSaveInput,
  OpenBusinessDayIntent,
  PreopenConfigurationChoices,
  ReplayJobProjection,
  ReplayJobPollResponse,
  RequestDayReplayIntent,
  SettleBusinessDayIntent,
} from '@econ-game/sdk';

/**
 * Type-only SDK boundary. The frontend does not parse HTTP responses or recreate
 * the SDK client: its injected implementation must already be a validated SDK
 * client (or an adapter with the exact same narrow method surface).
 */
export type WebGameplayTransport = Pick<
  GameplayApiClient,
  | 'initializeCompetitiveSave'
  | 'getActiveSave'
  | 'getGameplayProjection'
  | 'getPreopenConfigurationChoices'
  | 'pollReplayJob'
  | 'configurePreopenDay'
  | 'openBusinessDay'
  | 'advanceServicePeriod'
  | 'settleBusinessDay'
  | 'requestDayReplay'
>;

/**
 * Runtime validation boundary for injected transports. Production adapters must
 * delegate to the SDK's response validators (or equivalent version-pinned
 * validators) before a projection can drive this machine.
 */
export class GameplayResponseValidationError extends Error {
  constructor() {
    super('GAMEPLAY_RESPONSE_INVALID');
    this.name = 'GameplayResponseValidationError';
  }
}

export type GameplayMutationRequest =
  | Readonly<{
      kind: 'INITIALIZE_COMPETITIVE_SAVE';
      input: InitializeCompetitiveSaveInput;
    }>
  | Readonly<{
      kind: 'CONFIGURE_PREOPEN_DAY';
      saveId: string;
      input: GameplayCommandInput<ConfigurePreopenDayIntent>;
    }>
  | Readonly<{
      kind: 'OPEN_BUSINESS_DAY';
      saveId: string;
      input: GameplayCommandInput<OpenBusinessDayIntent>;
    }>
  | Readonly<{
      kind: 'ADVANCE_SERVICE_PERIOD';
      saveId: string;
      input: GameplayCommandInput<AdvanceServicePeriodIntent>;
    }>
  | Readonly<{
      kind: 'SETTLE_BUSINESS_DAY';
      saveId: string;
      input: GameplayCommandInput<SettleBusinessDayIntent>;
    }>
  | Readonly<{
      kind: 'REQUEST_DAY_REPLAY';
      saveId: string;
      input: GameplayCommandInput<RequestDayReplayIntent>;
    }>;

export type MutationUnconfirmedRecoveryRecord = Readonly<{
  schemaVersion: 'web-gameplay-recovery/v1';
  stage: 'MUTATION_UNCONFIRMED';
  mutation: GameplayMutationRequest;
}>;

export type RefreshRequiredRecoveryRecord = Readonly<{
  schemaVersion: 'web-gameplay-recovery/v1';
  stage: 'REFRESH_REQUIRED';
  mutation: GameplayMutationRequest;
}>;

export type GameplayRecoveryRecord =
  | MutationUnconfirmedRecoveryRecord
  | RefreshRequiredRecoveryRecord;

export type GameplayReplayRecoveryRecord = Readonly<{
  schemaVersion: 'web-gameplay-recovery/v1';
  stage: 'REPLAY_POLL_REQUIRED';
  replay: Readonly<{ saveId: string; jobId: string }>;
}>;

export type AnyGameplayRecoveryRecord =
  | GameplayRecoveryRecord
  | GameplayReplayRecoveryRecord;

export type WebGameplayState =
  | Readonly<{ tag: 'auth-unavailable'; reason: 'NOT_STARTED' | 'ACCESS_TOKEN_UNAVAILABLE' | 'AUTH_PROVIDER_FAILED' | 'UNAUTHORIZED' | 'FORBIDDEN' }>
  | Readonly<{ tag: 'discovering' }>
  | Readonly<{ tag: 'initialize'; bootstrap: Extract<ActiveGameplaySaveDiscovery, { state: 'INITIALIZE_REQUIRED' }>['bootstrap'] }>
  | Readonly<{ tag: 'configure'; projection: GameplayProjection }>
  | Readonly<{ tag: 'open'; projection: GameplayProjection }>
  | Readonly<{ tag: 'advance'; projection: GameplayProjection }>
  | Readonly<{ tag: 'settle'; projection: GameplayProjection }>
  | Readonly<{ tag: 'replay'; projection: GameplayProjection }>
  | Readonly<{ tag: 'polling'; saveId: string; jobId: string; status: Extract<ReplayJobProjection, { terminal: false }>['status'] }>
  | Readonly<{
      tag: 'match';
      saveId: string;
      job: Extract<ReplayJobProjection, { terminal: true; verification: unknown }>;
    }>
  | Readonly<{
      tag: 'mismatch';
      saveId: string;
      /** A contradictory MATCH verification is also fail-closed as a mismatch. */
      job: Extract<ReplayJobProjection, { terminal: true; verification: unknown }>;
    }>
  | Readonly<{
      tag: 'failure';
      operation: GameplayOperation;
      code: string;
      status?: number;
      retry: 'none' | 'retry-same-request' | 'refresh-only' | 'poll-only';
      recovery?: AnyGameplayRecoveryRecord;
    }>
  | Readonly<{ tag: 'refresh'; saveId?: string }>
  | Readonly<{
      tag: 'incompatible';
      reason: 'EMPTY_PREMISES_EQUIPMENT_PATH_REQUIRED' | 'UNSUPPORTED_SERVER_PROJECTION' | 'ROUTE_NOT_SUPPORTED';
    }>;

export type GameplayOperation = GameplayMutationRequest['kind'] | 'DISCOVER' | 'REFRESH' | 'POLL_REPLAY';

export class GameplayMachineError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'GameplayMachineError';
  }
}

/** Maps only validated server projections to a visible frontend state. */
export function stateFromProjection(projection: GameplayProjection): WebGameplayState {
  if (projection.save.openingScenario === 'EMPTY_PREMISES') {
    return Object.freeze({ tag: 'incompatible', reason: 'EMPTY_PREMISES_EQUIPMENT_PATH_REQUIRED' });
  }

  switch (projection.phase) {
    case 'CONFIGURE_REQUIRED':
      return Object.freeze({ tag: 'configure', projection });
    case 'OPEN_REQUIRED':
      return Object.freeze({ tag: 'open', projection });
    case 'ADVANCE_REQUIRED':
      return Object.freeze({ tag: 'advance', projection });
    case 'SETTLE_REQUIRED':
      return Object.freeze({ tag: 'settle', projection });
    case 'REPLAY_AVAILABLE':
      return Object.freeze({ tag: 'replay', projection });
    default:
      return Object.freeze({ tag: 'incompatible', reason: 'UNSUPPORTED_SERVER_PROJECTION' });
  }
}

export function stateFromDiscovery(discovery: ActiveGameplaySaveDiscovery): WebGameplayState {
  if (discovery.state === 'INITIALIZE_REQUIRED') {
    return Object.freeze({ tag: 'initialize', bootstrap: discovery.bootstrap });
  }
  return stateFromProjection(discovery.activeSave);
}

export function stateFromReplayJob(
  saveId: string,
  job: ReplayJobPollResponse['body'],
): WebGameplayState {
  if (job.terminal === false) {
    return Object.freeze({ tag: 'polling', saveId, jobId: job.jobId, status: job.status });
  }
  if (job.status === 'MATCH') {
    if (job.verification.eventHash.match && job.verification.snapshotHash.match) {
      return Object.freeze({ tag: 'match', saveId, job });
    }
    return Object.freeze({ tag: 'mismatch', saveId, job });
  }
  if (job.status === 'MISMATCH') return Object.freeze({ tag: 'mismatch', saveId, job });
  return Object.freeze({
    tag: 'failure',
    operation: 'POLL_REPLAY',
    code: job.status,
    retry: 'none',
  });
}

export function commandSaveId(request: GameplayMutationRequest): string | undefined {
  return request.kind === 'INITIALIZE_COMPETITIVE_SAVE' ? undefined : request.saveId;
}
