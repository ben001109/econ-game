import {
  CommandError,
  encodeCommandScope,
  hashCommandRequest,
  parseCommandEnvelope,
  parseTrustedCommandContext,
  type CanonicalCommandValue,
  type CommandEnvelope,
  type TrustedCommandContext,
} from './command-contract.js';

export type LedgerPostingLineEffect = Readonly<{
  accountCode: string;
  direction: 'DEBIT' | 'CREDIT';
  amountMinor: string;
}>;

export type LedgerTransactionalEffect =
  | Readonly<{
      kind: 'ledger.posting/v1';
      transactionId: string;
      eventId: string;
      currency: string;
      reason: string;
      lines: readonly LedgerPostingLineEffect[];
    }>
  | Readonly<{
      kind: 'ledger.compensation/v1';
      transactionId: string;
      eventId: string;
      reversesTransactionId: string;
      reason: string;
    }>;

export type OutboxEventEffect = Readonly<{
  kind: 'outbox.event/v1';
  eventId: string;
  eventSequence: number;
  eventType: string;
  eventVersion: number;
  payload: Readonly<Record<string, CanonicalCommandValue>>;
}>;

export type JobRequestOutboxEffect = Readonly<{
  kind: 'outbox.job-request/v1';
  eventId: string;
  eventSequence: number;
  eventType: string;
  eventVersion: number;
  jobId: string;
  payload: Readonly<Record<string, CanonicalCommandValue>>;
}>;

export type DurableOutboxEffect = OutboxEventEffect | JobRequestOutboxEffect;

export type CommandTransactionalEffects = Readonly<{
  ledger?: LedgerTransactionalEffect;
  outbox?: readonly DurableOutboxEffect[];
}>;

/**
 * A transaction-bound capability supplied by the durable execution store.
 * Implementations must execute every mutation in the command coordinator's
 * database transaction. The memory adapter deliberately rejects all calls.
 */
export interface DurableCommandPersistence {
  readonly durable: boolean;
  mutate<T>(statement: string, ...values: readonly unknown[]): Promise<T>;
}

export const unavailableDurableCommandPersistence: DurableCommandPersistence = Object.freeze({
  durable: false,
  mutate<T>(): Promise<T> {
    return Promise.reject(new CommandError(503, 'COMMAND_PERSISTENCE_REQUIRED'));
  },
});

type CommandHandlerResultBase = Readonly<{
  aggregateVersion: number;
  result: CanonicalCommandValue;
  effects?: CommandTransactionalEffects;
  /** @deprecated Use effects.ledger for new handlers. */
  transactionalEffect?: LedgerTransactionalEffect;
}>;

export type SynchronousCommandHandlerResult = CommandHandlerResultBase &
  Readonly<{
    status?: 200;
    jobId?: never;
  }>;

export type AsyncCommandHandlerResult = CommandHandlerResultBase &
  Readonly<{
    status: 202;
    jobId: string;
  }>;

export type CommandHandlerResult = SynchronousCommandHandlerResult | AsyncCommandHandlerResult;

export type CommandHandler = Readonly<{
  commandType: string;
  execute(
    input: Readonly<{
      context: TrustedCommandContext;
      command: CommandEnvelope;
      currentVersion: number;
      persistence: DurableCommandPersistence;
    }>,
  ): Promise<CommandHandlerResult>;
}>;

type CommandSuccessBase = Readonly<{
  commandId: string;
  idempotencyKey: string;
  commandType: string;
  aggregateId: string;
  aggregateVersion: number;
  result: CanonicalCommandValue;
}>;

export type CommandSuccess =
  | (CommandSuccessBase & Readonly<{ jobId?: never }>)
  | (CommandSuccessBase & Readonly<{ jobId: string }>);

export type CommandStoreInput = Readonly<{
  actorScope: string;
  aggregateScope: string;
  idempotencyKey: string;
  commandId: string;
  requestFingerprint: string;
  expectedVersion: number;
  context: TrustedCommandContext;
}>;

export interface CommandExecutionStore {
  execute(
    input: CommandStoreInput,
    operation: (
      currentVersion: number,
      persistence: DurableCommandPersistence,
    ) => Promise<CommandHandlerResult>,
  ): Promise<Readonly<{ commandId: string; execution: CommandHandlerResult }>>;
}

/** Default composition hard-stop until D03 installs a transactional store. */
export class PersistenceRequiredCommandExecutionStore implements CommandExecutionStore {
  execute(): Promise<never> {
    return Promise.reject(new CommandError(503, 'COMMAND_PERSISTENCE_REQUIRED'));
  }
}

/**
 * Contract-only adapter. D03 must replace this with a database transaction that
 * atomically owns IdempotencyRecord, aggregate version, ledger, and outbox.
 */
export class InMemoryCommandExecutionStore implements CommandExecutionStore {
  private readonly records = new Map<
    string,
    Readonly<{
      fingerprint: string;
      outcome: Promise<Readonly<{ commandId: string; execution: CommandHandlerResult }>>;
    }>
  >();
  private readonly versions = new Map<string, number>();
  private readonly aggregateQueues = new Map<string, Promise<void>>();

  execute(
    input: CommandStoreInput,
    operation: (
      currentVersion: number,
      persistence: DurableCommandPersistence,
    ) => Promise<CommandHandlerResult>,
  ): Promise<Readonly<{ commandId: string; execution: CommandHandlerResult }>> {
    const idempotencyIdentity = encodeCommandScope([input.actorScope, input.idempotencyKey]);
    const existing = this.records.get(idempotencyIdentity);
    if (existing) {
      if (existing.fingerprint !== input.requestFingerprint) {
        return Promise.reject(new CommandError(409, 'IDEMPOTENCY_KEY_REUSED'));
      }
      return existing.outcome;
    }

    const outcome = this.runAggregate(input, operation);
    this.records.set(
      idempotencyIdentity,
      Object.freeze({ fingerprint: input.requestFingerprint, outcome }),
    );
    return outcome;
  }

  private async runAggregate(
    input: CommandStoreInput,
    operation: (
      currentVersion: number,
      persistence: DurableCommandPersistence,
    ) => Promise<CommandHandlerResult>,
  ): Promise<Readonly<{ commandId: string; execution: CommandHandlerResult }>> {
    const previous = this.aggregateQueues.get(input.aggregateScope) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.aggregateQueues.set(input.aggregateScope, current);
    await previous.catch(() => undefined);

    try {
      const currentVersion = this.versions.get(input.aggregateScope) ?? 1;
      if (currentVersion !== input.expectedVersion) {
        throw new CommandError(409, 'EXPECTED_VERSION_CONFLICT', {
          actualVersion: currentVersion,
          expectedVersion: input.expectedVersion,
        });
      }

      const result = await operation(currentVersion, unavailableDurableCommandPersistence);
      assertValidCommandHandlerResult(result, currentVersion);
      if (commandLedgerEffect(result) !== undefined || commandOutboxEffects(result).length > 0) {
        throw new CommandError(503, 'COMMAND_PERSISTENCE_REQUIRED');
      }
      this.versions.set(input.aggregateScope, result.aggregateVersion);
      return Object.freeze({ commandId: input.commandId, execution: Object.freeze({ ...result }) });
    } finally {
      release();
      if (this.aggregateQueues.get(input.aggregateScope) === current) {
        this.aggregateQueues.delete(input.aggregateScope);
      }
    }
  }
}

export class CommandDispatcher {
  private readonly handlers: ReadonlyMap<string, CommandHandler>;

  constructor(
    handlers: readonly CommandHandler[],
    private readonly store: CommandExecutionStore,
  ) {
    const commandTypes = new Set<string>();
    for (const handler of handlers) {
      if (commandTypes.has(handler.commandType)) {
        throw new Error(`duplicate command handler: ${handler.commandType}`);
      }
      commandTypes.add(handler.commandType);
    }
    this.handlers = new Map(handlers.map((handler) => [handler.commandType, handler]));
  }

  async dispatch(
    input: Readonly<{
      context: unknown;
      target: Readonly<{ saveId: string; commandType: string }>;
      envelope: unknown;
    }>,
  ): Promise<Readonly<{ status: 200 | 202; body: CommandSuccess }>> {
    const context = parseTrustedCommandContext(input.context);
    const command = parseCommandEnvelope(input.envelope);
    if (context.saveId !== input.target.saveId || command.aggregateId !== input.target.saveId) {
      throw new CommandError(422, 'COMMAND_SCOPE_MISMATCH');
    }
    if (command.commandType !== input.target.commandType) {
      throw new CommandError(422, 'COMMAND_TARGET_MISMATCH');
    }
    enforceD04Scope(context, command);

    const handler = this.handlers.get(command.commandType);
    if (!handler) throw new CommandError(422, 'UNKNOWN_COMMAND');

    const result = await this.store.execute(
      {
        actorScope: encodeCommandScope([context.tenantId, context.saveId, context.actorId]),
        aggregateScope: encodeCommandScope([context.tenantId, context.saveId, command.aggregateId]),
        idempotencyKey: command.idempotencyKey,
        commandId: command.commandId,
        requestFingerprint: hashCommandRequest(command, {
          actorId: context.actorId,
          tenantId: context.tenantId,
          saveId: context.saveId,
        }),
        expectedVersion: command.expectedVersion,
        context,
      },
      (currentVersion, persistence) =>
        handler.execute({ context, command, currentVersion, persistence }),
    );

    const status = result.execution.status ?? 200;
    const bodyBase = {
      commandId: result.commandId,
      idempotencyKey: command.idempotencyKey,
      commandType: command.commandType,
      aggregateId: command.aggregateId,
      aggregateVersion: result.execution.aggregateVersion,
      result: result.execution.result,
    };
    if (status === 202) {
      return Object.freeze({
        status,
        body: Object.freeze({ ...bodyBase, jobId: result.execution.jobId }),
      });
    }
    return Object.freeze({ status, body: Object.freeze(bodyBase) });
  }
}

export function assertValidCommandHandlerResult(
  result: CommandHandlerResult,
  currentVersion: number,
): void {
  const ledger = commandLedgerEffect(result);
  const outbox = commandOutboxEffects(result);
  if (result.transactionalEffect !== undefined && result.effects?.ledger !== undefined) {
    throw new Error('command handler must not declare duplicate ledger effects');
  }
  assertValidOutboxEffects(outbox);
  if (result.status === 202) {
    if (!result.jobId.trim()) {
      throw new Error('accepted command handler must provide a non-empty jobId');
    }
    if (ledger !== undefined) {
      throw new Error('accepted command handler must not include a ledger effect');
    }
    if (outbox.length !== 1 || outbox[0]?.kind !== 'outbox.job-request/v1') {
      throw new Error('accepted command handler must emit exactly one job-request outbox effect');
    }
    if (outbox[0].jobId !== result.jobId || outbox[0].payload.jobId !== result.jobId) {
      throw new Error('accepted command jobId must match its job-request outbox effect');
    }
  } else if ('jobId' in result) {
    throw new Error('synchronous command handler must not provide jobId');
  }
  if (result.aggregateVersion !== currentVersion + 1) {
    throw new Error('command handler must advance aggregateVersion by exactly one');
  }
}

export function commandLedgerEffect(
  result: CommandHandlerResult,
): LedgerTransactionalEffect | undefined {
  return result.effects?.ledger ?? result.transactionalEffect;
}

export function commandOutboxEffects(result: CommandHandlerResult): readonly DurableOutboxEffect[] {
  return result.effects?.outbox ?? [];
}

function assertValidOutboxEffects(effects: readonly DurableOutboxEffect[]): void {
  const eventIdentities = new Set<string>();
  const eventSequences = new Set<number>();
  for (const effect of effects) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        effect.eventId,
      ) ||
      !Number.isSafeInteger(effect.eventSequence) ||
      effect.eventSequence < 0 ||
      !/^[a-z][a-z0-9_.-]{1,99}$/.test(effect.eventType) ||
      !Number.isSafeInteger(effect.eventVersion) ||
      effect.eventVersion < 1 ||
      eventIdentities.has(effect.eventId) ||
      eventSequences.has(effect.eventSequence)
    ) {
      throw new Error('command handler emitted an invalid outbox effect');
    }
    if (
      effect.kind === 'outbox.job-request/v1' &&
      (!effect.jobId.trim() || effect.jobId.length > 200)
    ) {
      throw new Error('command handler emitted an invalid job-request outbox effect');
    }
    eventIdentities.add(effect.eventId);
    eventSequences.add(effect.eventSequence);
  }
}

function enforceD04Scope(context: TrustedCommandContext, command: CommandEnvelope): void {
  if (
    context.principal.type === 'discord_bot' &&
    command.idempotencyKey !== context.principal.interactionId
  ) {
    throw new CommandError(409, 'DISCORD_INTERACTION_IDEMPOTENCY_MISMATCH');
  }
  if (context.branchScope.kind === 'all') return;
  const branchId = command.payload.branchId;
  if (
    typeof branchId !== 'string' ||
    !branchId ||
    !context.branchScope.branchIds.includes(branchId)
  ) {
    throw new CommandError(403, 'COMMAND_BRANCH_SCOPE_FORBIDDEN');
  }
}
