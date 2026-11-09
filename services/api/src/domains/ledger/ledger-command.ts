import {
  CommandError,
  type CommandEnvelope,
  type TrustedCommandContext,
} from '../../commands/command-contract.js';
import type {
  CommandHandler,
  LedgerPostingLineEffect,
  LedgerTransactionalEffect,
} from '../../commands/command-dispatcher.js';

export const POST_LEDGER_TRANSACTION = 'POST_LEDGER_TRANSACTION' as const;
export const COMPENSATE_LEDGER_TRANSACTION = 'COMPENSATE_LEDGER_TRANSACTION' as const;

const maximumPostgresBigInt = 9_223_372_036_854_775_807n;
const transactionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const accountCodePattern = /^[A-Z][A-Z0-9_:-]{0,99}$/;
const positiveCanonicalIntegerPattern = /^[1-9]\d*$/;

export function createLedgerCommandHandlers(): readonly CommandHandler[] {
  const posting: CommandHandler = Object.freeze({
    commandType: POST_LEDGER_TRANSACTION,
    async execute({ context, command, currentVersion }) {
      enforceLedgerRole(context);
      const posting = parsePosting(command);
      const transactionalEffect: LedgerTransactionalEffect = Object.freeze({
        kind: 'ledger.posting/v1',
        transactionId: command.commandId,
        eventId: command.commandId,
        currency: posting.currency,
        reason: posting.reason,
        lines: posting.lines,
      });
      return Object.freeze({
        aggregateVersion: currentVersion + 1,
        result: Object.freeze({
          transactionId: command.commandId,
          eventId: command.commandId,
          kind: 'POSTING',
        }),
        transactionalEffect,
      });
    },
  });
  const compensation: CommandHandler = Object.freeze({
    commandType: COMPENSATE_LEDGER_TRANSACTION,
    async execute({ context, command, currentVersion }) {
      enforceLedgerRole(context);
      const compensation = parseCompensation(command);
      const transactionalEffect: LedgerTransactionalEffect = Object.freeze({
        kind: 'ledger.compensation/v1',
        transactionId: command.commandId,
        eventId: command.commandId,
        reversesTransactionId: compensation.reversesTransactionId,
        reason: compensation.reason,
      });
      return Object.freeze({
        aggregateVersion: currentVersion + 1,
        result: Object.freeze({
          transactionId: command.commandId,
          eventId: command.commandId,
          kind: 'COMPENSATION',
          reversesTransactionId: compensation.reversesTransactionId,
        }),
        transactionalEffect,
      });
    },
  });
  return Object.freeze([posting, compensation]);
}

function parsePosting(command: CommandEnvelope): Readonly<{
  currency: string;
  reason: string;
  lines: readonly LedgerPostingLineEffect[];
}> {
  const payload = command.payload;
  if (!hasOnlyKeys(payload, ['settlementCurrency', 'reason', 'lines'])) invalid('payload');
  const currency = payload.settlementCurrency;
  const reason = payload.reason;
  const lines = payload.lines;
  if (
    typeof currency !== 'string' ||
    !/^[A-Z]{3}$/.test(currency) ||
    typeof reason !== 'string' ||
    !reason.trim() ||
    reason.length > 500 ||
    !Array.isArray(lines) ||
    lines.length < 2 ||
    lines.length > 200
  ) {
    invalid('payload');
  }

  let debit = 0n;
  let credit = 0n;
  const parsedLines = lines.map((value, sequence) => {
    if (!isPlainObject(value) || !hasOnlyKeys(value, ['accountCode', 'direction', 'amount'])) {
      invalid(`payload.lines[${sequence}]`);
    }
    const accountCode = value.accountCode;
    const direction = value.direction;
    const amount = value.amount;
    if (
      typeof accountCode !== 'string' ||
      !accountCodePattern.test(accountCode) ||
      (direction !== 'DEBIT' && direction !== 'CREDIT') ||
      !isPlainObject(amount) ||
      !hasOnlyKeys(amount, ['currency', 'minorUnits']) ||
      amount.currency !== currency ||
      typeof amount.minorUnits !== 'string' ||
      !positiveCanonicalIntegerPattern.test(amount.minorUnits)
    ) {
      invalid(`payload.lines[${sequence}]`);
    }
    const amountMinor = BigInt(amount.minorUnits);
    if (amountMinor > maximumPostgresBigInt) invalid(`payload.lines[${sequence}].amount`);
    if (direction === 'DEBIT') debit += amountMinor;
    else credit += amountMinor;
    return Object.freeze<LedgerPostingLineEffect>({
      accountCode,
      direction,
      amountMinor: amount.minorUnits,
    });
  });
  if (debit !== credit) {
    throw new CommandError(422, 'LEDGER_NOT_BALANCED', {
      creditMinor: credit.toString(),
      debitMinor: debit.toString(),
    });
  }
  return Object.freeze({ currency, reason, lines: Object.freeze(parsedLines) });
}

function parseCompensation(command: CommandEnvelope): Readonly<{
  reversesTransactionId: string;
  reason: string;
}> {
  const payload = command.payload;
  if (!hasOnlyKeys(payload, ['reversesTransactionId', 'reason'])) invalid('payload');
  const reversesTransactionId = payload.reversesTransactionId;
  const reason = payload.reason;
  if (
    typeof reversesTransactionId !== 'string' ||
    !transactionIdPattern.test(reversesTransactionId) ||
    reversesTransactionId === command.commandId ||
    typeof reason !== 'string' ||
    !reason.trim() ||
    reason.length > 500
  ) {
    invalid('payload');
  }
  return Object.freeze({ reversesTransactionId, reason });
}

function enforceLedgerRole(context: TrustedCommandContext): void {
  if (!context.roles.some((role) => role === 'OWNER' || role === 'MANAGER')) {
    throw new CommandError(403, 'LEDGER_ROLE_FORBIDDEN');
  }
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function invalid(field: string): never {
  throw new CommandError(422, 'LEDGER_TRANSACTION_INVALID', { field });
}
