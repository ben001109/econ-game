import type {
  ActiveGameplaySaveDiscovery,
  EconGameApiError,
  EconGameClientOptions,
  GameplayApiClient,
  GameplayCommandReceipt,
  GameplayProjection,
  GameplayReplayRequestReceipt,
  ReplayJobPollResponse,
} from '@econ-game/sdk';

export type BotGameplayAction =
  | 'STATUS'
  | 'OPEN_BUSINESS_DAY'
  | 'ADVANCE_SERVICE_PERIOD'
  | 'SETTLE_BUSINESS_DAY'
  | 'REQUEST_DAY_REPLAY'
  | 'REPLAY_STATUS'
  | 'LATEST_REPLAY';

export type BotGameplayInteraction = Readonly<{
  discordUserId: string;
  interactionId: string;
  correlationId?: string;
}>;

export type BotGameplayDisplay =
  | Readonly<{
      kind: 'status';
      phase: GameplayProjection['phase'];
      nextAction: GameplayProjection['nextCommand'];
      aggregateVersion: number;
      businessDay: null | Readonly<{
        status: NonNullable<GameplayProjection['businessDay']>['status'];
        completedServicePeriods: number;
        totalServicePeriods: 2 | 3;
        nextPeriodKey: NonNullable<GameplayProjection['businessDay']>['nextPeriodKey'];
      }>;
      notice?: 'CONFLICT_REFRESHED';
    }>
  | Readonly<{
      kind: 'replay';
      jobId: string;
      status: ReplayJobPollResponse['body']['status'];
      terminal: boolean;
      outcome?: 'MATCH' | 'MISMATCH' | 'FAILED';
    }>
  | Readonly<{
      kind: 'failure';
      action: BotGameplayAction;
      code: string;
      httpStatus?: number;
      resolution: 'NONE' | 'STATUS_REQUIRED';
    }>;

export type BotGameplayRuntimeOptions = Readonly<{
  apiBaseUrl: string;
  serviceCredential: string;
  createClient: (options: EconGameClientOptions) => GameplayApiClient;
  createCommandId?: () => string;
}>;

/**
 * Minimal structural surface used by the Discord slash-command adapter.
 *
 * Keeping this independent from discord.js makes the authority boundary
 * directly testable: the adapter may only read the Discord interaction id,
 * linked Discord user id, and the explicitly declared slash options.
 */
export type BotGameplaySlashInteraction = Readonly<{
  id: string;
  user: Readonly<{ id: string }>;
  options: Readonly<{
    data: readonly unknown[];
    getSubcommand(required?: boolean): string;
    getString(name: string, required?: boolean): string | null;
  }>;
  deferReply(options: Readonly<{ ephemeral: true }>): Promise<unknown>;
  editReply(content: string): Promise<unknown>;
}>;

export type BotGameplaySlashRuntime = Pick<
  BotGameplayRuntime,
  'status' | 'open' | 'advance' | 'settle' | 'replay' | 'replayStatus'
>;

export type CreateBotGameplaySlashRuntime = () => BotGameplaySlashRuntime;

type MutationAction = Exclude<
  BotGameplayAction,
  'STATUS' | 'REPLAY_STATUS' | 'LATEST_REPLAY'
>;

type MutationExecutor = (
  client: GameplayApiClient,
  projection: GameplayProjection,
  commandId: string,
  interactionId: string,
) => Promise<GameplayCommandReceipt | GameplayReplayRequestReceipt>;

/**
 * Pure Discord gameplay orchestration. Discord binding and slash registration
 * remain outside this module; the server still derives player, tenant, role,
 * membership, active scope, and all game authority.
 */
export class BotGameplayRuntime {
  private readonly apiBaseUrl: string;
  private readonly serviceCredential: string;

  constructor(private readonly options: BotGameplayRuntimeOptions) {
    this.apiBaseUrl = validApiBaseUrl(options.apiBaseUrl);
    this.serviceCredential = validCredential(options.serviceCredential);
  }

  async status(interaction: BotGameplayInteraction): Promise<BotGameplayDisplay> {
    return this.readProjection('STATUS', interaction, async (_client, projection) =>
      statusDisplay(projection),
    );
  }

  async open(interaction: BotGameplayInteraction): Promise<BotGameplayDisplay> {
    return this.mutate(
      'OPEN_BUSINESS_DAY',
      interaction,
      'OPEN_REQUIRED',
      'OPEN_BUSINESS_DAY',
      (client, projection, commandId, interactionId) => {
        const pin = projection.preopenSnapshot;
        if (!pin) throw new BotGameplayRuntimeError('BOT_GAMEPLAY_PROJECTION_INVALID');
        return client.openBusinessDay(projection.save.id, {
          commandId,
          idempotencyKey: interactionId,
          expectedVersion: projection.expectedVersion,
          payload: {
            preopenSnapshotId: pin.id,
            preopenSnapshotHash: pin.hash,
          },
        });
      },
    );
  }

  async advance(
    interaction: BotGameplayInteraction,
    ownerAssignment: 'KITCHEN' | 'FRONT' | 'NONE',
  ): Promise<BotGameplayDisplay> {
    if (!['KITCHEN', 'FRONT', 'NONE'].includes(ownerAssignment)) {
      throw new BotGameplayRuntimeError('BOT_GAMEPLAY_INPUT_INVALID');
    }
    return this.mutate(
      'ADVANCE_SERVICE_PERIOD',
      interaction,
      'ADVANCE_REQUIRED',
      'ADVANCE_SERVICE_PERIOD',
      (client, projection, commandId, interactionId) => {
        const day = projection.businessDay;
        if (!day || day.businessDay !== 1 || day.nextPeriodKey === null) {
          throw new BotGameplayRuntimeError('BOT_GAMEPLAY_PROJECTION_INVALID');
        }
        return client.advanceServicePeriod(projection.save.id, {
          commandId,
          idempotencyKey: interactionId,
          expectedVersion: projection.expectedVersion,
          payload: {
            businessDay: 1,
            expectedPeriodKey: day.nextPeriodKey,
            ownerAssignment,
          },
        });
      },
    );
  }

  async settle(interaction: BotGameplayInteraction): Promise<BotGameplayDisplay> {
    return this.mutate(
      'SETTLE_BUSINESS_DAY',
      interaction,
      'SETTLE_REQUIRED',
      'SETTLE_BUSINESS_DAY',
      (client, projection, commandId, interactionId) =>
        client.settleBusinessDay(projection.save.id, {
          commandId,
          idempotencyKey: interactionId,
          expectedVersion: projection.expectedVersion,
          payload: { businessDay: 1 },
        }),
    );
  }

  async replay(interaction: BotGameplayInteraction): Promise<BotGameplayDisplay> {
    return this.readProjection('REQUEST_DAY_REPLAY', interaction, async (client, projection) => {
      if (
        projection.phase !== 'REPLAY_AVAILABLE' ||
        projection.nextCommand !== 'REQUEST_DAY_REPLAY' ||
        projection.dayEnd?.businessDay !== 1
      ) {
        return failure('REQUEST_DAY_REPLAY', 'BOT_GAMEPLAY_ACTION_UNAVAILABLE');
      }

      try {
        const existing = await client.getLatestReplayJob(projection.save.id, 1);
        return replayDisplay(existing);
      } catch (error) {
        if (httpStatus(error) !== 404) return safeFailure('REQUEST_DAY_REPLAY', error);
      }

      return this.executeMutation(
        'REQUEST_DAY_REPLAY',
        interaction.interactionId,
        client,
        projection,
        (sameClient, sameProjection, commandId, interactionId) =>
          sameClient.requestDayReplay(sameProjection.save.id, {
            commandId,
            idempotencyKey: interactionId,
            expectedVersion: sameProjection.expectedVersion,
            payload: { businessDay: 1 },
          }),
      );
    });
  }

  async replayStatus(
    interaction: BotGameplayInteraction,
    jobId: string,
  ): Promise<BotGameplayDisplay> {
    assertIdentifier(jobId);
    return this.readProjection('REPLAY_STATUS', interaction, async (client, projection) => {
      try {
        return replayDisplay(await client.pollReplayJob(projection.save.id, jobId));
      } catch (error) {
        return safeFailure('REPLAY_STATUS', error);
      }
    });
  }

  async latestReplay(interaction: BotGameplayInteraction): Promise<BotGameplayDisplay> {
    return this.readProjection('LATEST_REPLAY', interaction, async (client, projection) => {
      try {
        return replayDisplay(await client.getLatestReplayJob(projection.save.id, 1));
      } catch (error) {
        return safeFailure('LATEST_REPLAY', error);
      }
    });
  }

  private async mutate(
    action: MutationAction,
    interaction: BotGameplayInteraction,
    phase: GameplayProjection['phase'],
    nextCommand: GameplayProjection['nextCommand'],
    execute: MutationExecutor,
  ): Promise<BotGameplayDisplay> {
    return this.readProjection(action, interaction, async (client, projection) => {
      if (projection.phase !== phase || projection.nextCommand !== nextCommand) {
        return failure(action, 'BOT_GAMEPLAY_ACTION_UNAVAILABLE');
      }
      return this.executeMutation(action, interaction.interactionId, client, projection, execute);
    });
  }

  private async executeMutation(
    action: MutationAction,
    interactionId: string,
    client: GameplayApiClient,
    projection: GameplayProjection,
    execute: MutationExecutor,
  ): Promise<BotGameplayDisplay> {
    const commandId = this.commandId();
    let receipt: GameplayCommandReceipt | GameplayReplayRequestReceipt;
    try {
      receipt = await execute(client, projection, commandId, interactionId);
    } catch (firstError) {
      if (httpStatus(firstError) === 409) {
        return this.refreshAfterConflict(client, projection.save.id);
      }
      const firstStatus = httpStatus(firstError);
      if (firstStatus !== undefined) {
        return firstStatus >= 500
          ? failure(action, safeCode(firstError), 'STATUS_REQUIRED', firstStatus)
          : safeFailure(action, firstError);
      }
      try {
        receipt = await execute(client, projection, commandId, interactionId);
      } catch (secondError) {
        if (httpStatus(secondError) === 409) {
          return this.refreshAfterConflict(client, projection.save.id);
        }
        if (httpStatus(secondError) === 422) return safeFailure(action, secondError);
        return failure(
          action,
          'BOT_GAMEPLAY_MUTATION_UNCONFIRMED',
          'STATUS_REQUIRED',
          httpStatus(secondError),
        );
      }
    }

    if (action === 'REQUEST_DAY_REPLAY') {
      if (!('jobId' in receipt) || typeof receipt.jobId !== 'string') {
        return failure(action, 'BOT_GAMEPLAY_RESPONSE_INVALID', 'STATUS_REQUIRED');
      }
      try {
        await client.getGameplayProjection(projection.save.id);
        return replayDisplay(await client.pollReplayJob(projection.save.id, receipt.jobId));
      } catch (error) {
        return failure(
          action,
          httpStatus(error) === undefined
            ? 'BOT_GAMEPLAY_REPLAY_STATUS_UNCONFIRMED'
            : safeCode(error),
          'STATUS_REQUIRED',
          httpStatus(error),
        );
      }
    }

    try {
      return statusDisplay(await client.getGameplayProjection(projection.save.id));
    } catch (error) {
      return failure(
        action,
        httpStatus(error) === undefined
          ? 'BOT_GAMEPLAY_REFRESH_REQUIRED'
          : safeCode(error),
        'STATUS_REQUIRED',
        httpStatus(error),
      );
    }
  }

  private async refreshAfterConflict(
    client: GameplayApiClient,
    saveId: string,
  ): Promise<BotGameplayDisplay> {
    try {
      return Object.freeze({
        ...statusDisplay(await client.getGameplayProjection(saveId)),
        notice: 'CONFLICT_REFRESHED' as const,
      });
    } catch (error) {
      return failure(
        'STATUS',
        httpStatus(error) === undefined ? 'BOT_GAMEPLAY_REFRESH_REQUIRED' : safeCode(error),
        'STATUS_REQUIRED',
        httpStatus(error),
      );
    }
  }

  private async readProjection(
    action: BotGameplayAction,
    interaction: BotGameplayInteraction,
    execute: (client: GameplayApiClient, projection: GameplayProjection) => Promise<BotGameplayDisplay>,
  ): Promise<BotGameplayDisplay> {
    let client: GameplayApiClient;
    try {
      client = this.client(interaction);
    } catch (error) {
      return safeFailure(action, error);
    }
    try {
      const discovery: ActiveGameplaySaveDiscovery = await client.getActiveSave();
      if (discovery.state !== 'ACTIVE_SAVE') {
        return failure(action, 'BOT_GAMEPLAY_ACTIVE_SAVE_REQUIRED');
      }
      const saveId = discovery.activeSave.save.id;
      const projection = await client.getGameplayProjection(saveId);
      if (projection.save.id !== saveId) {
        return failure(action, 'BOT_GAMEPLAY_PROJECTION_TARGET_MISMATCH');
      }
      return await execute(client, projection);
    } catch (error) {
      return safeFailure(action, error);
    }
  }

  private client(interaction: BotGameplayInteraction): GameplayApiClient {
    assertInteraction(interaction);
    return this.options.createClient({
      baseUrl: this.apiBaseUrl,
      headers: Object.freeze({
        authorization: `Bot ${this.serviceCredential}`,
        'x-correlation-id': interaction.correlationId ?? interaction.interactionId,
        'x-discord-interaction-id': interaction.interactionId,
        'x-discord-user-id': interaction.discordUserId,
      }),
    });
  }

  private commandId(): string {
    const value = (this.options.createCommandId ?? (() => globalThis.crypto.randomUUID()))();
    assertIdentifier(value);
    return value;
  }
}

/**
 * Executes the fixed `/game` command surface. It deliberately accepts no
 * caller-supplied save id, aggregate version, business day, header, role, or
 * authority scope: those values remain derived by BotGameplayRuntime and the
 * server-owned API authorization path.
 */
export async function executeGameplaySlashCommand(
  interaction: BotGameplaySlashInteraction,
  createRuntime: CreateBotGameplaySlashRuntime,
): Promise<void> {
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch {
    // A closed Discord interaction cannot be answered safely.
    return;
  }

  try {
    assertSlashInteraction(interaction);
    const runtime = createRuntime();
    const input = interactionInput(interaction);
    const display = await dispatchSlashInteraction(runtime, input);
    await interaction.editReply(renderSlashDisplay(display));
  } catch {
    // Do not render transport errors or configuration values: either could
    // contain credentials, request headers, or provider-specific internals.
    await safeEditReply(interaction, 'Game command failed (BOT_GAMEPLAY_COMMAND_FAILED).');
  }
}

export class BotGameplayRuntimeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'BotGameplayRuntimeError';
    this.code = code;
  }
}

function statusDisplay(projection: GameplayProjection): BotGameplayDisplay {
  const businessDay = projection.businessDay
    ? Object.freeze({
        status: projection.businessDay.status,
        completedServicePeriods: projection.businessDay.completedServicePeriods,
        totalServicePeriods: projection.businessDay.totalServicePeriods,
        nextPeriodKey: projection.businessDay.nextPeriodKey,
      })
    : null;
  return Object.freeze({
    kind: 'status',
    phase: projection.phase,
    nextAction: projection.nextCommand,
    aggregateVersion: projection.expectedVersion,
    businessDay,
  });
}

function replayDisplay(response: ReplayJobPollResponse): BotGameplayDisplay {
  const body = response.body;
  const outcome =
    body.status === 'MATCH' || body.status === 'MISMATCH'
      ? body.status
      : body.status === 'PERMANENT_FAILURE' || body.status === 'RETRY_EXHAUSTED'
        ? 'FAILED'
        : undefined;
  return Object.freeze({
    kind: 'replay',
    jobId: body.jobId,
    status: body.status,
    terminal: body.terminal,
    ...(outcome === undefined ? {} : { outcome }),
  });
}

function safeFailure(action: BotGameplayAction, error: unknown): BotGameplayDisplay {
  return failure(action, safeCode(error), 'NONE', httpStatus(error));
}

function failure(
  action: BotGameplayAction,
  code: string,
  resolution: 'NONE' | 'STATUS_REQUIRED' = 'NONE',
  status?: number,
): BotGameplayDisplay {
  return Object.freeze({
    kind: 'failure',
    action,
    code,
    ...(status === undefined ? {} : { httpStatus: status }),
    resolution,
  });
}

function safeCode(error: unknown): string {
  if (error instanceof BotGameplayRuntimeError) return error.code;
  const code = (error as Partial<EconGameApiError>)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,99}$/.test(code)
    ? code
    : httpStatus(error) === undefined
      ? 'BOT_GAMEPLAY_TRANSPORT_FAILED'
      : 'BOT_GAMEPLAY_REQUEST_FAILED';
}

function httpStatus(error: unknown): number | undefined {
  const value = (error as Partial<EconGameApiError>)?.status;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function validApiBaseUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new TypeError();
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    throw new BotGameplayRuntimeError('BOT_GAMEPLAY_API_BASE_URL_INVALID');
  }
}

function validCredential(value: string): string {
  if (!value.trim() || value.length > 4_096 || /[\s,]/.test(value)) {
    throw new BotGameplayRuntimeError('BOT_GAMEPLAY_CREDENTIAL_INVALID');
  }
  return value;
}

function assertInteraction(interaction: BotGameplayInteraction): void {
  if (
    !boundedString(interaction.discordUserId, 500) ||
    !boundedString(interaction.interactionId, 200) ||
    (interaction.correlationId !== undefined && !boundedString(interaction.correlationId, 500))
  ) {
    throw new BotGameplayRuntimeError('BOT_GAMEPLAY_INTERACTION_INVALID');
  }
}

function assertIdentifier(value: string): void {
  if (!boundedString(value, 200)) {
    throw new BotGameplayRuntimeError('BOT_GAMEPLAY_IDENTIFIER_INVALID');
  }
}

function boundedString(value: string, maximum: number): boolean {
  return value.trim() === value && value.length > 0 && value.length <= maximum;
}

type GameplaySlashInput =
  | Readonly<{ kind: 'status'; interaction: BotGameplayInteraction }>
  | Readonly<{ kind: 'open'; interaction: BotGameplayInteraction }>
  | Readonly<{
      kind: 'advance';
      interaction: BotGameplayInteraction;
      ownerAssignment: 'KITCHEN' | 'FRONT' | 'NONE';
    }>
  | Readonly<{ kind: 'settle'; interaction: BotGameplayInteraction }>
  | Readonly<{ kind: 'replay'; interaction: BotGameplayInteraction }>
  | Readonly<{ kind: 'replay-status'; interaction: BotGameplayInteraction; jobId: string }>;

function interactionInput(interaction: BotGameplaySlashInteraction): GameplaySlashInput {
  const botInteraction = Object.freeze({
    discordUserId: interaction.user.id,
    interactionId: interaction.id,
    correlationId: interaction.id,
  });
  const subcommand = interaction.options.getSubcommand(true);
  if (subcommand === 'status') {
    assertOptionNames(interaction.options.data, 'status', []);
    return Object.freeze({ kind: 'status', interaction: botInteraction });
  }
  if (subcommand === 'open') {
    assertOptionNames(interaction.options.data, 'open', []);
    return Object.freeze({ kind: 'open', interaction: botInteraction });
  }
  if (subcommand === 'advance') {
    assertOptionNames(interaction.options.data, 'advance', ['owner-assignment']);
    const ownerAssignment = interaction.options.getString('owner-assignment', true);
    if (ownerAssignment !== 'KITCHEN' && ownerAssignment !== 'FRONT' && ownerAssignment !== 'NONE') {
      throw new BotGameplayRuntimeError('BOT_GAMEPLAY_SLASH_OPTION_INVALID');
    }
    return Object.freeze({ kind: 'advance', interaction: botInteraction, ownerAssignment });
  }
  if (subcommand === 'settle') {
    assertOptionNames(interaction.options.data, 'settle', []);
    return Object.freeze({ kind: 'settle', interaction: botInteraction });
  }
  if (subcommand === 'replay') {
    assertOptionNames(interaction.options.data, 'replay', []);
    return Object.freeze({ kind: 'replay', interaction: botInteraction });
  }
  if (subcommand === 'replay-status') {
    assertOptionNames(interaction.options.data, 'replay-status', ['job-id']);
    const jobId = interaction.options.getString('job-id', true);
    if (!isSlashIdentifier(jobId)) {
      throw new BotGameplayRuntimeError('BOT_GAMEPLAY_SLASH_OPTION_INVALID');
    }
    return Object.freeze({ kind: 'replay-status', interaction: botInteraction, jobId });
  }
  throw new BotGameplayRuntimeError('BOT_GAMEPLAY_SLASH_SUBCOMMAND_INVALID');
}

async function dispatchSlashInteraction(
  runtime: BotGameplaySlashRuntime,
  input: GameplaySlashInput,
): Promise<BotGameplayDisplay> {
  switch (input.kind) {
    case 'status':
      return runtime.status(input.interaction);
    case 'open':
      return runtime.open(input.interaction);
    case 'advance':
      return runtime.advance(input.interaction, input.ownerAssignment);
    case 'settle':
      return runtime.settle(input.interaction);
    case 'replay':
      return runtime.replay(input.interaction);
    case 'replay-status':
      return runtime.replayStatus(input.interaction, input.jobId);
  }
}

function assertSlashInteraction(interaction: BotGameplaySlashInteraction): void {
  if (!isSlashIdentifier(interaction.id) || !isSlashIdentifier(interaction.user.id)) {
    throw new BotGameplayRuntimeError('BOT_GAMEPLAY_SLASH_INTERACTION_INVALID');
  }
}

function isSlashIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function assertOptionNames(
  data: readonly unknown[],
  expectedSubcommand: string,
  expectedOptionNames: readonly string[],
): void {
  if (!Array.isArray(data) || data.length !== 1) {
    throw new BotGameplayRuntimeError('BOT_GAMEPLAY_SLASH_OPTION_INVALID');
  }
  const root = asRecord(data[0]);
  if (!root || root.name !== expectedSubcommand) {
    throw new BotGameplayRuntimeError('BOT_GAMEPLAY_SLASH_OPTION_INVALID');
  }
  const options = root.options === undefined ? [] : root.options;
  if (!Array.isArray(options) || options.length !== expectedOptionNames.length) {
    throw new BotGameplayRuntimeError('BOT_GAMEPLAY_SLASH_OPTION_INVALID');
  }
  const names = options.map((option) => asRecord(option)?.name);
  if (names.some((name) => typeof name !== 'string') || !sameStringSet(names, expectedOptionNames)) {
    throw new BotGameplayRuntimeError('BOT_GAMEPLAY_SLASH_OPTION_INVALID');
  }
}

function sameStringSet(values: readonly unknown[], expected: readonly string[]): boolean {
  return values.length === expected.length && new Set(values).size === values.length && expected.every((value) => values.includes(value));
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : undefined;
}

function renderSlashDisplay(display: BotGameplayDisplay): string {
  if (display.kind === 'status') {
    const period = display.businessDay
      ? ` day=${display.businessDay.status}:${display.businessDay.completedServicePeriods}/${display.businessDay.totalServicePeriods}`
      : '';
    const notice = display.notice === 'CONFLICT_REFRESHED' ? ' Refreshed after a conflict.' : '';
    return `Game status: phase=${safeDisplayToken(display.phase)} next=${safeDisplayToken(display.nextAction)} version=${display.aggregateVersion}.${period}${notice}`;
  }
  if (display.kind === 'replay') {
    const outcome = display.outcome ? ` outcome=${display.outcome}` : '';
    return `Replay: job=${safeDisplayIdentifier(display.jobId)} status=${safeDisplayToken(display.status)} terminal=${display.terminal}.${outcome}`;
  }
  const resolution = display.resolution === 'STATUS_REQUIRED' ? ' Run /game status before retrying.' : '';
  return `Game action failed (${safeDisplayToken(display.code)}).${resolution}`;
}

function safeDisplayToken(value: string): string {
  return /^[A-Z][A-Z0-9_]{1,99}$/.test(value) ? value : 'UNAVAILABLE';
}

function safeDisplayIdentifier(value: string): string {
  return isSlashIdentifier(value) ? value : 'UNAVAILABLE';
}

async function safeEditReply(interaction: BotGameplaySlashInteraction, content: string): Promise<void> {
  try {
    await interaction.editReply(content);
  } catch {
    // The original ephemeral acknowledgement already established the reply scope.
  }
}
