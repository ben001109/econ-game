export const D02_COMMAND_ENVELOPE_VERSION = 'd02-command/v1' as const;

export type D02CommandValue =
  | null
  | boolean
  | number
  | string
  | readonly D02CommandValue[]
  | Readonly<{ [key: string]: D02CommandValue }>;

export type D02CommandTarget = Readonly<{
  saveId: string;
  commandType: string;
}>;

export type D02CommandInput = Readonly<{
  target: D02CommandTarget;
  expectedVersion: number;
  idempotencyKey: string;
  payload: Readonly<Record<string, D02CommandValue>>;
}>;

export type D02CommandSuccess = Readonly<{
  commandId: string;
  idempotencyKey: string;
  commandType: string;
  aggregateId: string;
  aggregateVersion: number;
  result: D02CommandValue;
  jobId?: string;
}>;

export class WebCommandError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, status?: number) {
    super(code);
    this.name = 'WebCommandError';
    this.code = code;
    this.status = status;
  }
}

export type WebD02CommandClientOptions = Readonly<{
  apiBaseUrl?: string;
  getAccessToken?: () => Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
  createCommandId?: () => string;
}>;

/**
 * Browser-side D02 transport. Actor, tenant, membership, role, and branch scope
 * are intentionally absent: the API derives them from the bearer credential.
 */
export class WebD02GameCommandClient {
  constructor(private readonly options: WebD02CommandClientOptions) {}

  async execute(input: D02CommandInput): Promise<D02CommandSuccess> {
    const baseUrl = validApiBaseUrl(this.options.apiBaseUrl);
    if (!baseUrl || !this.options.getAccessToken) {
      throw new WebCommandError('WEB_COMMAND_AUTH_NOT_CONFIGURED');
    }

    const token = (await this.options.getAccessToken())?.trim();
    if (!token || /[\s,]/.test(token)) {
      throw new WebCommandError('WEB_COMMAND_AUTH_UNAVAILABLE');
    }
    assertCommandInput(input);

    const commandId = (this.options.createCommandId ?? (() => crypto.randomUUID()))();
    const envelope = {
      schemaVersion: D02_COMMAND_ENVELOPE_VERSION,
      commandId,
      idempotencyKey: input.idempotencyKey,
      commandType: input.target.commandType,
      aggregateId: input.target.saveId,
      expectedVersion: input.expectedVersion,
      payload: input.payload,
    } as const;
    const fetchImplementation = this.options.fetch ?? globalThis.fetch.bind(globalThis);
    const path = `/saves/${encodeURIComponent(input.target.saveId)}/actions/${encodeURIComponent(input.target.commandType)}`;

    let response: Response;
    try {
      response = await fetchImplementation(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(envelope),
      });
    } catch {
      throw new WebCommandError('WEB_COMMAND_TRANSPORT_FAILED');
    }

    const body = await decodeJson(response);
    if (!response.ok) {
      throw new WebCommandError(readD02ErrorCode(body) ?? 'WEB_COMMAND_FAILED', response.status);
    }
    if (!isD02Success(body, input)) {
      throw new WebCommandError('WEB_COMMAND_RESPONSE_INVALID', response.status);
    }
    return body;
  }
}

export type WebOperationalCommandMapping = Readonly<{
  target: D02CommandTarget;
  expectedVersion: () => Promise<number>;
}>;

/** Approved mappings must come from the product contract; this adapter never invents them. */
export class WebOperationalCommandRuntime {
  constructor(
    private readonly client: WebD02GameCommandClient,
    private readonly mappings: Readonly<Record<string, WebOperationalCommandMapping>>,
  ) {}

  async execute(
    operation: string,
    input: Readonly<{
      idempotencyKey: string;
      payload: Readonly<Record<string, D02CommandValue>>;
    }>,
  ): Promise<D02CommandSuccess> {
    const mapping = this.mappings[operation];
    if (!mapping) throw new WebCommandError('WEB_COMMAND_MAPPING_NOT_CONFIGURED');
    return this.client.execute({
      target: mapping.target,
      expectedVersion: await mapping.expectedVersion(),
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
    });
  }
}

// O01/O02 evidence does not yet define browser token acquisition or gameplay
// command mappings. Production therefore has no compatibility or anonymous fallback.
export const productionWebCommandRuntime = new WebOperationalCommandRuntime(
  new WebD02GameCommandClient({ apiBaseUrl: process.env.NEXT_PUBLIC_API_URL }),
  Object.freeze({}),
);

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

function assertCommandInput(input: D02CommandInput): void {
  if (
    !input.target.saveId.trim() ||
    !/^[A-Z][A-Z0-9_]{1,99}$/.test(input.target.commandType) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    !input.idempotencyKey.trim()
  ) {
    throw new WebCommandError('WEB_COMMAND_INPUT_INVALID');
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
      throw new WebCommandError('CLIENT_CONTEXT_FIELD_FORBIDDEN');
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

function isD02Success(value: unknown, input: D02CommandInput): value is D02CommandSuccess {
  const record = asRecord(value);
  return (
    typeof record?.commandId === 'string' &&
    record.idempotencyKey === input.idempotencyKey &&
    record.commandType === input.target.commandType &&
    record.aggregateId === input.target.saveId &&
    typeof record.aggregateVersion === 'number' &&
    Number.isSafeInteger(record.aggregateVersion) &&
    Object.hasOwn(record, 'result')
  );
}
