import { randomUUID } from 'node:crypto';

export const D02_COMMAND_ENVELOPE_VERSION = 'd02-command/v1' as const;

export type D02CommandValue =
  | null
  | boolean
  | number
  | string
  | readonly D02CommandValue[]
  | Readonly<{ [key: string]: D02CommandValue }>;

export type BotD02CommandInput = Readonly<{
  discordUserId: string;
  interactionId: string;
  correlationId?: string;
  target: Readonly<{ saveId: string; commandType: string }>;
  expectedVersion: number;
  payload: Readonly<Record<string, D02CommandValue>>;
}>;

export type BotD02CommandSuccess = Readonly<{
  commandId: string;
  idempotencyKey: string;
  commandType: string;
  aggregateId: string;
  aggregateVersion: number;
  result: D02CommandValue;
  jobId?: string;
}>;

export class BotCommandError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, status?: number) {
    super(code);
    this.name = 'BotCommandError';
    this.code = code;
    this.status = status;
  }
}

export type BotD02CommandClientOptions = Readonly<{
  apiBaseUrl?: string;
  serviceCredential?: string;
  fetch?: typeof globalThis.fetch;
  createCommandId?: () => string;
}>;

/**
 * D04 Bot principal transport. The Discord user and interaction are audit
 * evidence only; the server resolves the linked player, tenant, role, and scope.
 */
export class BotD02GameCommandClient {
  constructor(private readonly options: BotD02CommandClientOptions) {}

  async execute(input: BotD02CommandInput): Promise<BotD02CommandSuccess> {
    const baseUrl = validApiBaseUrl(this.options.apiBaseUrl);
    const credential = this.options.serviceCredential?.trim();
    if (!baseUrl || !credential || credential.length > 4_096 || /[\s,]/.test(credential)) {
      throw new BotCommandError('BOT_PRINCIPAL_NOT_CONFIGURED');
    }
    assertInput(input);

    const commandId = (this.options.createCommandId ?? randomUUID)();
    const envelope = {
      schemaVersion: D02_COMMAND_ENVELOPE_VERSION,
      commandId,
      idempotencyKey: input.interactionId,
      commandType: input.target.commandType,
      aggregateId: input.target.saveId,
      expectedVersion: input.expectedVersion,
      payload: input.payload,
    } as const;
    const path = `/saves/${encodeURIComponent(input.target.saveId)}/actions/${encodeURIComponent(input.target.commandType)}`;
    const fetchImplementation = this.options.fetch ?? globalThis.fetch.bind(globalThis);

    let response: Response;
    try {
      response = await fetchImplementation(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bot ${credential}`,
          'content-type': 'application/json',
          'x-correlation-id': input.correlationId ?? input.interactionId,
          'x-discord-interaction-id': input.interactionId,
          'x-discord-user-id': input.discordUserId,
        },
        body: JSON.stringify(envelope),
      });
    } catch {
      throw new BotCommandError('BOT_COMMAND_TRANSPORT_FAILED');
    }

    const body = await decodeJson(response);
    if (!response.ok) {
      throw new BotCommandError(readD02ErrorCode(body) ?? 'BOT_COMMAND_FAILED', response.status);
    }
    if (!isD02Success(body, input)) {
      throw new BotCommandError('BOT_COMMAND_RESPONSE_INVALID', response.status);
    }
    return body;
  }
}

const forbiddenContextKeys = new Set([
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

function assertInput(input: BotD02CommandInput): void {
  if (
    !input.discordUserId.trim() ||
    input.discordUserId.length > 500 ||
    !input.interactionId.trim() ||
    input.interactionId.length > 200 ||
    (input.correlationId !== undefined &&
      (!input.correlationId.trim() || input.correlationId.length > 500)) ||
    !input.target.saveId.trim() ||
    !/^[A-Z][A-Z0-9_]{1,99}$/.test(input.target.commandType) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    throw new BotCommandError('BOT_COMMAND_INPUT_INVALID');
  }
  rejectClientContext(input.payload);
}

function rejectClientContext(value: D02CommandValue): void {
  if (Array.isArray(value)) {
    value.forEach(rejectClientContext);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenContextKeys.has(key)) {
      throw new BotCommandError('CLIENT_CONTEXT_FIELD_FORBIDDEN');
    }
    rejectClientContext(nested);
  }
}

function validApiBaseUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return undefined;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

async function decodeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function readD02ErrorCode(value: unknown): string | undefined {
  const error = asRecord(asRecord(value)?.error);
  return typeof error?.code === 'string' ? error.code : undefined;
}

function isD02Success(value: unknown, input: BotD02CommandInput): value is BotD02CommandSuccess {
  const record = asRecord(value);
  return (
    typeof record?.commandId === 'string' &&
    record.idempotencyKey === input.interactionId &&
    record.commandType === input.target.commandType &&
    record.aggregateId === input.target.saveId &&
    typeof record.aggregateVersion === 'number' &&
    Number.isSafeInteger(record.aggregateVersion) &&
    Object.hasOwn(record, 'result')
  );
}
