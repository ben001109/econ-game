import { CommandError, type CanonicalCommandValue } from '../../commands/command-contract.js';
import {
  assertValidCommandHandlerResult,
  commandLedgerEffect,
  commandOutboxEffects,
  type CommandExecutionStore,
  type CommandHandlerResult,
  type CommandStoreInput,
  type DurableCommandPersistence,
  type DurableOutboxEffect,
  type LedgerTransactionalEffect,
} from '../../commands/command-dispatcher.js';

export type D03Queryable = Readonly<{
  $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T>;
}>;

export type D03Database = Readonly<{
  $transaction<T>(operation: (transaction: D03Queryable) => Promise<T>): Promise<T>;
}>;

type IdRow = Readonly<{ id: string }>;
type VersionRow = Readonly<{ version: number }>;
type IdempotencyRow = Readonly<{
  commandId: string;
  requestFingerprint: string;
  status: string;
  responseSnapshot: unknown;
}>;
type OriginalTransactionRow = Readonly<{ currency: string }>;

/**
 * Generic D03 durable command store. Receipt acquisition, aggregate locking,
 * handler persistence, optional ledger writes, outbox writes, exact version
 * advance, and terminal receipt are committed by one PostgreSQL transaction.
 */
export class PostgresDurableCommandExecutionStore implements CommandExecutionStore {
  constructor(private readonly database: D03Database) {}

  async execute(
    input: CommandStoreInput,
    operation: (
      currentVersion: number,
      persistence: DurableCommandPersistence,
    ) => Promise<CommandHandlerResult>,
  ): Promise<Readonly<{ commandId: string; execution: CommandHandlerResult }>> {
    try {
      return await this.database.$transaction((transaction) =>
        this.executeInTransaction(transaction, input, operation),
      );
    } catch (error) {
      if (error instanceof CommandError) throw error;
      const constraint = databaseConstraint(error);
      if (
        constraint === 'ServicePeriodExecution_order_check' ||
        constraint === 'ServicePeriodExecution_previous_hash_check' ||
        constraint === 'BusinessDay_service_complete_evidence_check'
      ) {
        throw new CommandError(409, 'SERVICE_PERIOD_ORDER_CONFLICT');
      }
      if (
        constraint === 'BusinessDay_settled_evidence_check' ||
        constraint === 'ReplayEvent_settlement_order_check'
      ) {
        throw new CommandError(409, 'SETTLEMENT_EVIDENCE_CONFLICT');
      }
      if (constraint.includes('reversesTransactionId')) {
        throw new CommandError(409, 'LEDGER_TRANSACTION_ALREADY_COMPENSATED');
      }
      if (constraint.startsWith('Inventory')) {
        throw new CommandError(422, 'INVENTORY_INVARIANT_VIOLATION');
      }
      if (constraint.startsWith('MarketTick') || constraint.startsWith('MarketSeed')) {
        throw new CommandError(422, 'MARKET_TICK_INVARIANT_VIOLATION');
      }
      if (databaseCode(error) === '23505' || databaseCode(error) === 'P2002') {
        throw new CommandError(409, 'COMMAND_ID_CONFLICT');
      }
      if (databaseCode(error) === '23514') {
        throw new CommandError(422, 'LEDGER_INVARIANT_VIOLATION');
      }
      throw error;
    }
  }

  private async executeInTransaction(
    transaction: D03Queryable,
    input: CommandStoreInput,
    operation: (
      currentVersion: number,
      persistence: DurableCommandPersistence,
    ) => Promise<CommandHandlerResult>,
  ): Promise<Readonly<{ commandId: string; execution: CommandHandlerResult }>> {
    const acquired = await transaction.$queryRawUnsafe<readonly IdRow[]>(
      `INSERT INTO "IdempotencyRecord" (
         "id", "restaurantId", "playerId", "actorScope", "idempotencyKey",
         "requestFingerprint", "status", "aggregateType", "aggregateId",
         "createdAt", "expiresAt"
       ) VALUES ($1,$2,$3,$4,$5,$6,'PROCESSING','CompetitiveSave',$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + INTERVAL '30 days')
       ON CONFLICT DO NOTHING
       RETURNING "id"`,
      input.commandId,
      input.context.tenantId,
      input.context.actorId,
      input.actorScope,
      input.idempotencyKey,
      input.requestFingerprint,
      input.context.saveId,
    );

    if (!acquired[0]) return this.replayExisting(transaction, input);

    const scope = await transaction.$queryRawUnsafe<readonly VersionRow[]>(
      `SELECT save."version"
       FROM "CompetitiveSave" save
       JOIN "RestaurantMembership" membership
         ON membership."id" = $3
        AND membership."playerId" = $4
        AND membership."restaurantId" = save."restaurantId"
        AND membership."revokedAt" IS NULL
        AND membership."role" IN ('OWNER', 'MANAGER')
       WHERE save."id" = $1
         AND save."restaurantId" = $2
         AND save."retiredAt" IS NULL
       FOR UPDATE OF save, membership`,
      input.context.saveId,
      input.context.tenantId,
      input.context.membershipId,
      input.context.actorId,
    );
    const currentVersion = scope[0]?.version;
    if (currentVersion === undefined) throw new CommandError(403, 'LEDGER_SCOPE_FORBIDDEN');
    if (currentVersion !== input.expectedVersion) {
      throw new CommandError(409, 'EXPECTED_VERSION_CONFLICT', {
        actualVersion: currentVersion,
        expectedVersion: input.expectedVersion,
      });
    }

    let handlerMutationCount = 0;
    const persistence: DurableCommandPersistence = Object.freeze({
      durable: true,
      mutate: async <T>(statement: string, ...values: readonly unknown[]): Promise<T> => {
        if (!statement.trim()) {
          throw new CommandError(422, 'COMMAND_PERSISTENCE_STATEMENT_INVALID');
        }
        handlerMutationCount += 1;
        return transaction.$queryRawUnsafe<T>(statement, ...values);
      },
    });
    const proposed = await operation(currentVersion, persistence);
    assertValidCommandHandlerResult(proposed, currentVersion);
    const ledger = commandLedgerEffect(proposed);
    const declaredOutbox = commandOutboxEffects(proposed);
    if (proposed.status !== 202 && handlerMutationCount > 0 && declaredOutbox.length === 0) {
      throw new CommandError(422, 'COMMAND_OUTBOX_EFFECT_REQUIRED');
    }
    let legacyLedgerOutbox:
      | Readonly<{
          eventId: string;
          eventType: string;
          payload: Readonly<Record<string, CanonicalCommandValue>>;
        }>
      | undefined;
    if (ledger) {
      assertEffectIdentity(ledger, input.commandId);
      legacyLedgerOutbox = await this.writeLedger(transaction, input, ledger);
    }

    const outbox =
      declaredOutbox.length > 0
        ? declaredOutbox
        : legacyLedgerOutbox
          ? [
              Object.freeze<DurableOutboxEffect>({
                kind: 'outbox.event/v1',
                eventId: legacyLedgerOutbox.eventId,
                eventSequence: 0,
                eventType: legacyLedgerOutbox.eventType,
                eventVersion: 1,
                payload: legacyLedgerOutbox.payload,
              }),
            ]
          : [];
    for (const [index, effect] of outbox.entries()) {
      await transaction.$queryRawUnsafe(
        `INSERT INTO "OutboxEvent" (
           "id", "restaurantId", "saveId", "transactionId", "causationCommandId",
           "eventSequence", "aggregateType", "aggregateId", "aggregateVersion",
           "eventType", "eventVersion", "payload"
         ) VALUES ($1,$2,$3,$4,$5,$6,'CompetitiveSave',$3,$7,$8,$9,$10::jsonb)`,
        effect.eventId,
        input.context.tenantId,
        input.context.saveId,
        ledger && index === 0 ? ledger.transactionId : null,
        input.commandId,
        effect.eventSequence,
        proposed.aggregateVersion,
        effect.eventType,
        effect.eventVersion,
        JSON.stringify(effect.payload),
      );
    }

    const updated = await transaction.$queryRawUnsafe<readonly VersionRow[]>(
      `UPDATE "CompetitiveSave"
       SET "version" = $4, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1 AND "restaurantId" = $2 AND "version" = $3
       RETURNING "version"`,
      input.context.saveId,
      input.context.tenantId,
      currentVersion,
      proposed.aggregateVersion,
    );
    if (updated[0]?.version !== proposed.aggregateVersion) {
      throw new CommandError(409, 'EXPECTED_VERSION_CONFLICT');
    }

    const execution = publicExecution(proposed);
    const completed = Object.freeze({ commandId: input.commandId, execution });
    await transaction.$queryRawUnsafe(
      `UPDATE "IdempotencyRecord"
       SET "status" = 'COMPLETED', "responseSnapshot" = $2::jsonb,
           "terminalAt" = CURRENT_TIMESTAMP,
           "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '30 days'
       WHERE "id" = $1`,
      input.commandId,
      JSON.stringify(completed),
    );
    return completed;
  }

  private async replayExisting(
    transaction: D03Queryable,
    input: CommandStoreInput,
  ): Promise<Readonly<{ commandId: string; execution: CommandHandlerResult }>> {
    const records = await transaction.$queryRawUnsafe<readonly IdempotencyRow[]>(
      `SELECT "id" AS "commandId", "requestFingerprint", "status", "responseSnapshot"
       FROM "IdempotencyRecord"
       WHERE "actorScope" = $1 AND "idempotencyKey" = $2
       FOR SHARE`,
      input.actorScope,
      input.idempotencyKey,
    );
    const record = records[0];
    if (!record) throw new CommandError(409, 'COMMAND_ID_CONFLICT');
    if (record.requestFingerprint !== input.requestFingerprint) {
      throw new CommandError(409, 'IDEMPOTENCY_KEY_REUSED');
    }
    if (record.status !== 'COMPLETED') throw new CommandError(409, 'COMMAND_IN_PROGRESS');
    return parseStoredExecution(record.responseSnapshot);
  }

  private async writeLedger(
    transaction: D03Queryable,
    input: CommandStoreInput,
    effect: LedgerTransactionalEffect,
  ): Promise<
    Readonly<{
      eventId: string;
      eventType: string;
      payload: Readonly<Record<string, CanonicalCommandValue>>;
    }>
  > {
    if (effect.kind === 'ledger.posting/v1') {
      await this.insertTransaction(transaction, input, effect, 'POSTING', effect.currency, null);
      for (const [sequence, line] of effect.lines.entries()) {
        await transaction.$queryRawUnsafe(
          `INSERT INTO "LedgerLine" (
             "id", "restaurantId", "saveId", "transactionId", "sequence",
             "accountCode", "direction", "amountMinor"
           ) VALUES (
             $1 || ':' || $4::text, $2, $3, $1, $4, $5,
             $6::"LedgerDirection", $7::bigint
           )`,
          effect.transactionId,
          input.context.tenantId,
          input.context.saveId,
          sequence,
          line.accountCode,
          line.direction,
          line.amountMinor,
        );
      }
      return Object.freeze({
        eventId: effect.eventId,
        eventType: 'ledger.transaction.posted',
        payload: Object.freeze({
          transactionId: effect.transactionId,
          commandId: input.commandId,
          kind: 'POSTING',
          currency: effect.currency,
        }),
      });
    }

    const originals = await transaction.$queryRawUnsafe<readonly OriginalTransactionRow[]>(
      `SELECT "currency"
       FROM "LedgerTransaction"
       WHERE "id" = $1 AND "restaurantId" = $2 AND "saveId" = $3
       FOR SHARE`,
      effect.reversesTransactionId,
      input.context.tenantId,
      input.context.saveId,
    );
    const original = originals[0];
    if (!original) throw new CommandError(422, 'LEDGER_COMPENSATION_TARGET_INVALID');
    await this.insertTransaction(
      transaction,
      input,
      effect,
      'COMPENSATION',
      original.currency,
      effect.reversesTransactionId,
    );
    await transaction.$queryRawUnsafe(
      `INSERT INTO "LedgerLine" (
         "id", "restaurantId", "saveId", "transactionId", "sequence",
         "accountCode", "direction", "amountMinor"
       )
       SELECT $1 || ':' || original."sequence"::text, $2, $3, $1,
              original."sequence", original."accountCode",
              CASE original."direction"
                WHEN 'DEBIT'::"LedgerDirection" THEN 'CREDIT'::"LedgerDirection"
                ELSE 'DEBIT'::"LedgerDirection"
              END,
              original."amountMinor"
       FROM "LedgerLine" original
       WHERE original."transactionId" = $4
       ORDER BY original."sequence"`,
      effect.transactionId,
      input.context.tenantId,
      input.context.saveId,
      effect.reversesTransactionId,
    );
    return Object.freeze({
      eventId: effect.eventId,
      eventType: 'ledger.transaction.compensated',
      payload: Object.freeze({
        transactionId: effect.transactionId,
        commandId: input.commandId,
        kind: 'COMPENSATION',
        currency: original.currency,
        reversesTransactionId: effect.reversesTransactionId,
      }),
    });
  }

  private async insertTransaction(
    transaction: D03Queryable,
    input: CommandStoreInput,
    effect: LedgerTransactionalEffect,
    kind: 'POSTING' | 'COMPENSATION',
    currency: string,
    reversesTransactionId: string | null,
  ): Promise<void> {
    await transaction.$queryRawUnsafe(
      `INSERT INTO "LedgerTransaction" (
         "id", "restaurantId", "saveId", "commandId", "actorPlayerId",
         "kind", "currency", "reason", "reversesTransactionId"
       ) VALUES ($1,$2,$3,$1,$4,$5::"LedgerTransactionKind",$6,$7,$8)`,
      effect.transactionId,
      input.context.tenantId,
      input.context.saveId,
      input.context.actorId,
      kind,
      currency,
      effect.reason,
      reversesTransactionId,
    );
  }
}

/** Compatibility export for existing ledger-focused compositions and tests. */
export {
  PostgresDurableCommandExecutionStore as PostgresLedgerCommandExecutionStore,
};

export type OutboxConsumerEvent = Readonly<{
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateId: string;
  aggregateVersion: number;
  payload: unknown;
}>;

type OutboxEventRow = Readonly<{
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateId: string;
  aggregateVersion: number;
  payload: unknown;
}>;

/** Durable inbox receipt plus a database-local projection in one transaction. */
export class PostgresOutboxConsumer {
  constructor(private readonly database: D03Database) {}

  consume(
    input: Readonly<{ restaurantId: string; eventId: string; consumerName: string }>,
    project: (transaction: D03Queryable, event: OutboxConsumerEvent) => Promise<void>,
  ): Promise<boolean> {
    validateConsumerInput(input);
    return this.database.$transaction(async (transaction) => {
      const events = await transaction.$queryRawUnsafe<readonly OutboxEventRow[]>(
        `SELECT "id" AS "eventId", "eventType", "eventVersion", "aggregateId",
                "aggregateVersion", "payload"
         FROM "OutboxEvent"
         WHERE "id" = $1 AND "restaurantId" = $2
         FOR SHARE`,
        input.eventId,
        input.restaurantId,
      );
      const event = events[0];
      if (!event) throw new CommandError(422, 'OUTBOX_EVENT_SCOPE_INVALID');
      const inserted = await transaction.$queryRawUnsafe<readonly IdRow[]>(
        `INSERT INTO "OutboxConsumerReceipt" (
           "id", "restaurantId", "eventId", "consumerName"
         ) VALUES ($1 || ':' || $3,$2,$1,$3)
         ON CONFLICT ("eventId", "consumerName") DO NOTHING
         RETURNING "id"`,
        input.eventId,
        input.restaurantId,
        input.consumerName,
      );
      if (!inserted[0]) return false;
      await project(transaction, Object.freeze({ ...event }));
      return true;
    });
  }
}

function publicExecution(result: CommandHandlerResult): CommandHandlerResult {
  if (result.status === 202) {
    return Object.freeze({
      status: 202,
      aggregateVersion: result.aggregateVersion,
      result: result.result,
      jobId: result.jobId,
    });
  }
  return Object.freeze({ aggregateVersion: result.aggregateVersion, result: result.result });
}

function parseStoredExecution(
  snapshot: unknown,
): Readonly<{ commandId: string; execution: CommandHandlerResult }> {
  const parsed = typeof snapshot === 'string' ? (JSON.parse(snapshot) as unknown) : snapshot;
  if (!isRecord(parsed) || typeof parsed.commandId !== 'string' || !isRecord(parsed.execution)) {
    throw new CommandError(503, 'IDEMPOTENCY_RESPONSE_CORRUPT');
  }
  const aggregateVersion = parsed.execution.aggregateVersion;
  if (
    typeof aggregateVersion !== 'number' ||
    !Number.isSafeInteger(aggregateVersion) ||
    aggregateVersion < 1 ||
    !Object.hasOwn(parsed.execution, 'result')
  ) {
    throw new CommandError(503, 'IDEMPOTENCY_RESPONSE_CORRUPT');
  }
  if (parsed.execution.status === 202) {
    if (typeof parsed.execution.jobId !== 'string' || !parsed.execution.jobId.trim()) {
      throw new CommandError(503, 'IDEMPOTENCY_RESPONSE_CORRUPT');
    }
    return Object.freeze({
      commandId: parsed.commandId,
      execution: Object.freeze({
        status: 202,
        aggregateVersion,
        result: parsed.execution.result as CanonicalCommandValue,
        jobId: parsed.execution.jobId,
      }),
    });
  }
  return Object.freeze({
    commandId: parsed.commandId,
    execution: Object.freeze({
      aggregateVersion,
      result: parsed.execution.result as CanonicalCommandValue,
    }),
  });
}

function assertEffectIdentity(effect: LedgerTransactionalEffect, commandId: string): void {
  if (effect.transactionId !== commandId || effect.eventId !== commandId) {
    throw new CommandError(422, 'LEDGER_EFFECT_IDENTITY_INVALID');
  }
}

function validateConsumerInput(
  input: Readonly<{ restaurantId: string; eventId: string; consumerName: string }>,
): void {
  if (
    !input.restaurantId ||
    input.restaurantId.length > 200 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.eventId,
    ) ||
    !/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(input.consumerName)
  ) {
    throw new CommandError(422, 'OUTBOX_CONSUMER_INPUT_INVALID');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function databaseCode(error: unknown): string {
  if (!isRecord(error)) return '';
  if (typeof error.code === 'string') {
    if (error.code === 'P2010' && isRecord(error.meta) && typeof error.meta.code === 'string') {
      return error.meta.code;
    }
    return error.code;
  }
  return '';
}

function databaseConstraint(error: unknown): string {
  if (!isRecord(error)) return '';
  if (typeof error.constraint === 'string') return error.constraint;
  if (isRecord(error.meta)) {
    if (typeof error.meta.constraint === 'string') return error.meta.constraint;
    if (typeof error.meta.target === 'string') return error.meta.target;
    if (Array.isArray(error.meta.target)) return error.meta.target.join(',');
  }
  return '';
}
