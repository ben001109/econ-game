import { EconGameHttpClient, encodePathSegment, type EconGameClientOptions } from './core.js';

export const COMMAND_ENVELOPE_VERSION = 'd02-command/v1' as const;

export type CommandValue =
  | null
  | boolean
  | number
  | string
  | readonly CommandValue[]
  | Readonly<{ [key: string]: CommandValue }>;

/** Client input deliberately has no actor, tenant, save, role, or permission fields. */
export type GameCommandEnvelope = Readonly<{
  schemaVersion: typeof COMMAND_ENVELOPE_VERSION;
  commandId: string;
  idempotencyKey: string;
  commandType: string;
  aggregateId: string;
  expectedVersion: number;
  payload: Readonly<Record<string, CommandValue>>;
}>;

type GameCommandSuccessBase<T extends CommandValue = CommandValue> = Readonly<{
  commandId: string;
  idempotencyKey: string;
  commandType: string;
  aggregateId: string;
  aggregateVersion: number;
  result: T;
}>;

export type GameCommandCompleted<T extends CommandValue = CommandValue> =
  GameCommandSuccessBase<T> & Readonly<{ jobId?: never }>;

export type GameCommandAccepted<T extends CommandValue = CommandValue> =
  GameCommandSuccessBase<T> & Readonly<{ jobId: string }>;

export type GameCommandSuccess<T extends CommandValue = CommandValue> =
  | GameCommandCompleted<T>
  | GameCommandAccepted<T>;

/**
 * Shared Web/Discord transport for the D02 resource-action boundary. D04 still
 * supplies authentication and actor scope server-side; this client cannot do so.
 */
export class GameCommandClient extends EconGameHttpClient {
  executeSaveAction<T extends CommandValue = CommandValue>(
    saveId: string,
    commandType: string,
    envelope: GameCommandEnvelope,
  ): Promise<GameCommandSuccess<T>> {
    if (!saveId.trim() || !commandType.trim()) {
      throw new TypeError('saveId and commandType must be non-empty.');
    }
    if (envelope.commandType !== commandType || envelope.aggregateId !== saveId) {
      throw new TypeError('command target must match the server-derived save resource path.');
    }
    return this.requestWithStatus<unknown>({
      method: 'POST',
      path: `/saves/${encodePathSegment(saveId)}/actions/${encodePathSegment(commandType)}`,
      body: envelope,
    }).then((response) => validateGameCommandSuccess(response.status, response.body));
  }
}

export const createGameCommandClient = (options: EconGameClientOptions): GameCommandClient =>
  new GameCommandClient(options);

export function validateGameCommandSuccess<T extends CommandValue = CommandValue>(
  status: number,
  body: unknown,
): GameCommandSuccess<T> {
  const record = exactRecord(body, status === 202 ? acceptedKeys : completedKeys, 'command response');
  if (
    !nonEmptyString(record.commandId) ||
    !nonEmptyString(record.idempotencyKey) ||
    !nonEmptyString(record.commandType) ||
    !nonEmptyString(record.aggregateId) ||
    !nonNegativeSafeInteger(record.aggregateVersion) ||
    !isCommandValue(record.result)
  ) {
    throw new TypeError('command response has an invalid completed receipt shape.');
  }
  if (status === 200) return record as GameCommandCompleted<T>;
  if (status !== 202 || !nonEmptyString(record.jobId)) {
    throw new TypeError('202 command responses must include a non-empty jobId.');
  }
  return record as GameCommandAccepted<T>;
}

const completedKeys = Object.freeze([
  'aggregateId',
  'aggregateVersion',
  'commandId',
  'commandType',
  'idempotencyKey',
  'result',
]);
const acceptedKeys = Object.freeze([...completedKeys, 'jobId']);

function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has unknown or missing fields.`);
  }
  return record;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCommandValue(value: unknown): value is CommandValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isCommandValue);
  if (typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every(isCommandValue);
}
