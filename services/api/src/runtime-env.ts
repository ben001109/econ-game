export type RuntimeEnvironmentSource = Readonly<Record<string, string | undefined>>;

export class RuntimeConfigurationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'RuntimeConfigurationError';
    this.code = code;
  }
}

export type ApiRuntimeEnvironment = Readonly<{
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL: string;
  REDIS_URL: string;
  NEW_RELIC_APP_NAME: string;
  NEW_RELIC_LICENSE_KEY: string;
  SENTRY_DSN: string;
  SENTRY_ENVIRONMENT: string;
  CLERK_ISSUER: string;
  CLERK_JWKS_URL: string;
  CLERK_AUDIENCES: string;
  CLERK_AUTHORIZED_PARTIES: string;
  BOT_SERVICE_CREDENTIAL_SHA256: string;
  BOT_SERVICE_PRINCIPAL_ID: string;
  BOT_SERVICE_SCOPES: string;
}>;

export function readApiRuntimeEnvironment(source: RuntimeEnvironmentSource): ApiRuntimeEnvironment {
  const nodeEnvironment = value(source.NODE_ENV) || 'development';
  const production = nodeEnvironment === 'production';
  const databaseUrl = value(source.DATABASE_URL);
  const redisUrl = value(source.REDIS_URL) || (production ? '' : 'redis://localhost:6379');

  if (production && !databaseUrl) fail('DATABASE_URL_REQUIRED');
  if (production && !redisUrl) fail('REDIS_URL_REQUIRED');
  if (databaseUrl) assertConnectionUrl(databaseUrl, 'DATABASE_URL_INVALID');
  if (redisUrl) assertRedisUrl(redisUrl);

  const clerk = [
    value(source.CLERK_ISSUER),
    value(source.CLERK_JWKS_URL),
    value(source.CLERK_AUDIENCES),
    value(source.CLERK_AUTHORIZED_PARTIES),
  ] as const;
  assertAllOrNone(clerk, 'CLERK_CONFIGURATION_PARTIAL');
  if (clerk.every(Boolean)) assertClerkConfiguration(clerk);

  const botService = [
    value(source.BOT_SERVICE_CREDENTIAL_SHA256),
    value(source.BOT_SERVICE_PRINCIPAL_ID),
    value(source.BOT_SERVICE_SCOPES),
  ] as const;
  assertAllOrNone(botService, 'BOT_SERVICE_CONFIGURATION_PARTIAL');
  if (
    botService.every(Boolean) &&
    (!/^[0-9a-f]{64}$/.test(botService[0]) ||
      !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(botService[1]) ||
      !commaSeparated(botService[2]).includes('game:command'))
  ) {
    fail('BOT_SERVICE_CONFIGURATION_INVALID');
  }

  return Object.freeze({
    NODE_ENV: nodeEnvironment,
    PORT: boundedPort(source.PORT),
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    NEW_RELIC_APP_NAME:
      value(source.NEW_RELIC_APP_NAME) || value(source.RELIC_APP_NAME) || 'econ-game-api',
    NEW_RELIC_LICENSE_KEY: value(source.NEW_RELIC_LICENSE_KEY) || value(source.RELIC_API_KEY),
    SENTRY_DSN: value(source.SENTRY_DSN),
    SENTRY_ENVIRONMENT: value(source.SENTRY_ENVIRONMENT) || nodeEnvironment,
    CLERK_ISSUER: clerk[0],
    CLERK_JWKS_URL: clerk[1],
    CLERK_AUDIENCES: clerk[2],
    CLERK_AUTHORIZED_PARTIES: clerk[3],
    BOT_SERVICE_CREDENTIAL_SHA256: botService[0],
    BOT_SERVICE_PRINCIPAL_ID: botService[1],
    BOT_SERVICE_SCOPES: botService[2],
  });
}

function value(input: string | undefined): string {
  return input?.trim() ?? '';
}

function boundedPort(input: string | undefined): number {
  const raw = value(input) || '4000';
  if (!/^[1-9]\d{0,4}$/.test(raw)) fail('PORT_INVALID');
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > 65_535) fail('PORT_INVALID');
  return port;
}

function assertConnectionUrl(input: string, code: string): void {
  if (input.length > 16_384 || /[\r\n\0]/.test(input)) fail(code);
  try {
    const parsed = new URL(input);
    if (!parsed.protocol || !parsed.hostname) fail(code);
  } catch {
    fail(code);
  }
}

function assertRedisUrl(input: string): void {
  assertConnectionUrl(input, 'REDIS_URL_INVALID');
  const parsed = new URL(input);
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) fail('REDIS_URL_INVALID');
}

function assertClerkConfiguration(values: readonly [string, string, string, string]): void {
  try {
    const issuer = new URL(values[0]);
    const jwks = new URL(values[1]);
    if (
      issuer.protocol !== 'https:' ||
      jwks.protocol !== 'https:' ||
      issuer.origin !== jwks.origin ||
      issuer.username ||
      issuer.password ||
      jwks.username ||
      jwks.password ||
      jwks.search ||
      jwks.hash ||
      commaSeparated(values[2]).length === 0 ||
      commaSeparated(values[3]).length === 0
    ) {
      fail('CLERK_CONFIGURATION_INVALID');
    }
  } catch {
    fail('CLERK_CONFIGURATION_INVALID');
  }
}

function commaSeparated(input: string): readonly string[] {
  const entries = input.split(',').map((entry) => entry.trim());
  return entries.some((entry) => !entry || entry.length > 2_000)
    ? Object.freeze([])
    : Object.freeze([...new Set(entries)]);
}

function assertAllOrNone(values: readonly string[], code: string): void {
  const configured = values.filter(Boolean).length;
  if (configured !== 0 && configured !== values.length) fail(code);
}

function fail(code: string): never {
  throw new RuntimeConfigurationError(code);
}
