import { createHash } from 'node:crypto';

import {
  assertJsonWithinResourceLimits,
  JsonResourceLimitError,
} from '../security/json-resource-limits.js';

export const COMMAND_ENVELOPE_VERSION = 'd02-command/v1' as const;
export const COMMAND_ERROR_ENVELOPE_VERSION = 'd02-command-error/v1' as const;

export type CanonicalCommandValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalCommandValue[]
  | Readonly<{ [key: string]: CanonicalCommandValue }>;

export type CommandEnvelope = Readonly<{
  schemaVersion: typeof COMMAND_ENVELOPE_VERSION;
  commandId: string;
  idempotencyKey: string;
  commandType: string;
  aggregateId: string;
  expectedVersion: number;
  payload: Readonly<Record<string, CanonicalCommandValue>>;
}>;

export type TrustedCommandContext = Readonly<{
  actorId: string;
  tenantId: string;
  saveId: string;
  roles: readonly string[];
  membershipId: string;
  branchScope:
    | Readonly<{ kind: 'all' }>
    | Readonly<{ kind: 'restricted'; branchIds: readonly string[] }>;
  principal: Readonly<{ type: 'web' }> | Readonly<{ type: 'discord_bot'; interactionId: string }>;
}>;

export type CommandErrorBody = Readonly<{
  error: Readonly<{
    version: typeof COMMAND_ERROR_ENVELOPE_VERSION;
    code: string;
    details?: Readonly<Record<string, CanonicalCommandValue>>;
  }>;
}>;

export class CommandError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Readonly<Record<string, CanonicalCommandValue>>;

  constructor(
    status: number,
    code: string,
    details?: Readonly<Record<string, CanonicalCommandValue>>,
  ) {
    super(code);
    this.name = 'CommandError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): CommandErrorBody {
    return {
      error: {
        version: COMMAND_ERROR_ENVELOPE_VERSION,
        code: this.code,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const isCommandError = (value: unknown): value is CommandError =>
  value instanceof CommandError;

const forbiddenClientContextKeys = new Set([
  'actor',
  'actorId',
  'playerId',
  'tenant',
  'tenantId',
  'restaurantId',
  'saveId',
  'scope',
  'roles',
  'permissions',
]);

const canonicalIntegerPattern = /^(?:0|-?[1-9]\d*)$/;

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).every((key) => keys.includes(key)) &&
    Object.keys(value).length === keys.length
  );
}

function isBoundedNonEmptyString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateCanonicalValue(
  value: unknown,
  path: string,
): asserts value is CanonicalCommandValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CommandError(422, 'COMMAND_ENVELOPE_INVALID', { field: path });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateCanonicalValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || !isPlainObject(value)) {
    throw new CommandError(422, 'COMMAND_ENVELOPE_INVALID', { field: path });
  }

  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (forbiddenClientContextKeys.has(key)) {
      throw new CommandError(422, 'CLIENT_CONTEXT_FIELD_FORBIDDEN', { field: `${path}.${key}` });
    }
    validateCanonicalValue(nested, `${path}.${key}`);
  }

  const hasCurrency = Object.hasOwn(record, 'currency');
  const hasMinorUnits = Object.hasOwn(record, 'minorUnits');
  if (hasCurrency || hasMinorUnits) {
    if (
      Object.keys(record).length !== 2 ||
      typeof record.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(record.currency) ||
      typeof record.minorUnits !== 'string' ||
      !canonicalIntegerPattern.test(record.minorUnits)
    ) {
      throw new CommandError(422, 'MONEY_PAYLOAD_INVALID', { field: path });
    }
  }
}

export function parseCommandEnvelope(input: unknown): CommandEnvelope {
  if (typeof input !== 'object' || input === null || !isPlainObject(input)) {
    throw new CommandError(422, 'COMMAND_ENVELOPE_INVALID');
  }
  if (
    !hasOnlyKeys(input, [
      'schemaVersion',
      'commandId',
      'idempotencyKey',
      'commandType',
      'aggregateId',
      'expectedVersion',
      'payload',
    ])
  ) {
    throw new CommandError(422, 'COMMAND_ENVELOPE_INVALID');
  }
  if (input.schemaVersion !== COMMAND_ENVELOPE_VERSION) {
    throw new CommandError(
      422,
      typeof input.schemaVersion === 'string'
        ? 'UNSUPPORTED_COMMAND_ENVELOPE_VERSION'
        : 'COMMAND_ENVELOPE_INVALID',
    );
  }
  if (
    typeof input.commandId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.commandId,
    ) ||
    !isBoundedNonEmptyString(input.idempotencyKey, 200) ||
    typeof input.commandType !== 'string' ||
    !/^[A-Z][A-Z0-9_]{1,99}$/.test(input.commandType) ||
    !isBoundedNonEmptyString(input.aggregateId, 200) ||
    !isNonNegativeSafeInteger(input.expectedVersion) ||
    typeof input.payload !== 'object' ||
    input.payload === null ||
    !isPlainObject(input.payload) ||
    Object.keys(input.payload).some((key) => key.length === 0)
  ) {
    throw new CommandError(422, 'COMMAND_ENVELOPE_INVALID');
  }

  try {
    assertJsonWithinResourceLimits(input);
  } catch (error) {
    if (error instanceof JsonResourceLimitError) {
      throw new CommandError(413, 'COMMAND_RESOURCE_LIMIT_EXCEEDED', {
        limit: error.kind,
      });
    }
    throw error;
  }
  validateCanonicalValue(input.payload, 'payload');
  return Object.freeze({
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    commandType: input.commandType,
    aggregateId: input.aggregateId,
    expectedVersion: input.expectedVersion,
    schemaVersion: COMMAND_ENVELOPE_VERSION,
    payload: input.payload as Readonly<Record<string, CanonicalCommandValue>>,
  });
}

/** D04 supplies this value after authentication and membership resolution. */
export function parseTrustedCommandContext(input: unknown): TrustedCommandContext {
  if (typeof input !== 'object' || input === null || !isPlainObject(input)) {
    throw new CommandError(401, 'UNTRUSTED_COMMAND_CONTEXT');
  }
  if (
    !hasOnlyKeys(input, [
      'actorId',
      'tenantId',
      'saveId',
      'roles',
      'membershipId',
      'branchScope',
      'principal',
    ]) ||
    !isBoundedNonEmptyString(input.actorId, 200) ||
    !isBoundedNonEmptyString(input.tenantId, 200) ||
    !isBoundedNonEmptyString(input.saveId, 200) ||
    !isBoundedNonEmptyString(input.membershipId, 200) ||
    !Array.isArray(input.roles) ||
    input.roles.length > 100 ||
    input.roles.some((role) => !isBoundedNonEmptyString(role, 100)) ||
    !isTrustedBranchScope(input.branchScope) ||
    !isTrustedPrincipal(input.principal)
  ) {
    throw new CommandError(401, 'UNTRUSTED_COMMAND_CONTEXT');
  }
  return Object.freeze({
    actorId: input.actorId,
    tenantId: input.tenantId,
    saveId: input.saveId,
    roles: Object.freeze([...input.roles]),
    membershipId: input.membershipId,
    branchScope:
      input.branchScope.kind === 'all'
        ? Object.freeze({ kind: 'all' })
        : Object.freeze({
            kind: 'restricted',
            branchIds: Object.freeze([...input.branchScope.branchIds]),
          }),
    principal:
      input.principal.type === 'web'
        ? Object.freeze({ type: 'web' })
        : Object.freeze({
            type: 'discord_bot',
            interactionId: input.principal.interactionId,
          }),
  });
}

function isTrustedBranchScope(value: unknown): value is TrustedCommandContext['branchScope'] {
  if (typeof value !== 'object' || value === null || !isPlainObject(value)) return false;
  if (value.kind === 'all') return hasOnlyKeys(value, ['kind']);
  return (
    value.kind === 'restricted' &&
    hasOnlyKeys(value, ['kind', 'branchIds']) &&
    Array.isArray(value.branchIds) &&
    value.branchIds.length <= 1_000 &&
    value.branchIds.every((branchId) => isBoundedNonEmptyString(branchId, 200)) &&
    new Set(value.branchIds).size === value.branchIds.length
  );
}

function isTrustedPrincipal(value: unknown): value is TrustedCommandContext['principal'] {
  if (typeof value !== 'object' || value === null || !isPlainObject(value)) return false;
  if (value.type === 'web') return hasOnlyKeys(value, ['type']);
  return (
    value.type === 'discord_bot' &&
    hasOnlyKeys(value, ['type', 'interactionId']) &&
    isBoundedNonEmptyString(value.interactionId, 200)
  );
}

export function canonicalizeCommandRequest(envelope: CommandEnvelope): string {
  return canonicalizeValue({
    schemaVersion: envelope.schemaVersion,
    commandType: envelope.commandType,
    aggregateId: envelope.aggregateId,
    expectedVersion: envelope.expectedVersion,
    payload: envelope.payload,
  });
}

export function hashCommandRequest(
  envelope: CommandEnvelope,
  trustedScope?: Readonly<{ actorId: string; tenantId: string; saveId: string }>,
): string {
  const canonicalRequest = trustedScope
    ? canonicalizeValue({
        request: canonicalizeCommandRequest(envelope),
        trustedScope,
      })
    : canonicalizeCommandRequest(envelope);
  return createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');
}

export function encodeCommandScope(parts: readonly string[]): string {
  return canonicalizeValue([...parts]);
}

function canonicalizeValue(value: CanonicalCommandValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeValue).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalizeValue(nested)}`)
    .join(',')}}`;
}
