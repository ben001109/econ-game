export type RuntimeEnvironmentSource = Readonly<Record<string, string | undefined>>;

export class WorkerRuntimeConfigurationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'WorkerRuntimeConfigurationError';
    this.code = code;
  }
}

export type WorkerRuntimeEnvironment = Readonly<{
  DATABASE_URL: string;
  D03_POLL_MS: number;
  D03_LEASE_SECONDS: number;
  D03_WORKER_ID: string;
}>;

export function readWorkerRuntimeEnvironment(
  source: RuntimeEnvironmentSource,
  processId: number,
): WorkerRuntimeEnvironment {
  const databaseUrl = value(source.DATABASE_URL);
  if (!databaseUrl) fail('DATABASE_URL_REQUIRED');
  assertConnectionUrl(databaseUrl);
  const workerId = value(source.D03_WORKER_ID) || `simulation-worker:${processId}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(workerId)) fail('D03_WORKER_ID_INVALID');

  return Object.freeze({
    DATABASE_URL: databaseUrl,
    D03_POLL_MS: boundedInteger(source.D03_POLL_MS, 1_000, 50, 60_000),
    D03_LEASE_SECONDS: boundedInteger(source.D03_LEASE_SECONDS, 60, 5, 900),
    D03_WORKER_ID: workerId,
  });
}

function boundedInteger(
  input: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (input === undefined) return fallback;
  const raw = input.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) fail('D03_INTEGER_CONFIGURATION_INVALID');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('D03_INTEGER_CONFIGURATION_OUT_OF_RANGE');
  }
  return parsed;
}

function assertConnectionUrl(input: string): void {
  if (input.length > 16_384 || /[\r\n\0]/.test(input)) fail('DATABASE_URL_INVALID');
  try {
    const parsed = new URL(input);
    if (!parsed.protocol || !parsed.hostname) fail('DATABASE_URL_INVALID');
  } catch {
    fail('DATABASE_URL_INVALID');
  }
}

function value(input: string | undefined): string {
  return input?.trim() ?? '';
}

function fail(code: string): never {
  throw new WorkerRuntimeConfigurationError(code);
}
