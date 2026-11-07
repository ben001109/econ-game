export type RuntimeEnvironmentSource = Readonly<Record<string, string | undefined>>;

export class BotRuntimeConfigurationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'BotRuntimeConfigurationError';
    this.code = code;
  }
}

export type BotRuntimeEnvironment = Readonly<{
  NODE_ENV: string;
  DISCORD_BOT_TOKEN: string;
  GUILD_ID: string;
  API_BASE_URL: string;
  BOT_SERVICE_CREDENTIAL: string;
  NEW_RELIC_APP_NAME: string;
  NEW_RELIC_LICENSE_KEY: string;
  SENTRY_DSN: string;
  SENTRY_ENVIRONMENT: string;
}>;

export function readBotRuntimeEnvironment(source: RuntimeEnvironmentSource): BotRuntimeEnvironment {
  const nodeEnvironment = value(source.NODE_ENV) || 'development';
  const apiBaseUrl = value(source.API_BASE_URL);
  const token = value(source.DISCORD_BOT_TOKEN);
  const serviceCredential = value(source.BOT_SERVICE_CREDENTIAL);

  if (apiBaseUrl) assertApiBaseUrl(apiBaseUrl);
  if (token.length > 4_096) fail('DISCORD_BOT_TOKEN_INVALID');
  if (serviceCredential.length > 4_096 || (serviceCredential && /[\s,]/.test(serviceCredential))) {
    fail('BOT_SERVICE_CREDENTIAL_INVALID');
  }
  if (nodeEnvironment === 'production') {
    if (!token) fail('DISCORD_BOT_TOKEN_REQUIRED');
    if (!apiBaseUrl) fail('API_BASE_URL_REQUIRED');
    if (!serviceCredential) fail('BOT_SERVICE_CREDENTIAL_REQUIRED');
  }

  return Object.freeze({
    NODE_ENV: nodeEnvironment,
    DISCORD_BOT_TOKEN: token,
    GUILD_ID: value(source.GUILD_ID),
    API_BASE_URL: apiBaseUrl,
    BOT_SERVICE_CREDENTIAL: serviceCredential,
    NEW_RELIC_APP_NAME:
      value(source.NEW_RELIC_APP_NAME) || value(source.RELIC_APP_NAME) || 'econ-game-bot',
    NEW_RELIC_LICENSE_KEY: value(source.NEW_RELIC_LICENSE_KEY) || value(source.RELIC_API_KEY),
    SENTRY_DSN: value(source.SENTRY_DSN),
    SENTRY_ENVIRONMENT: value(source.SENTRY_ENVIRONMENT) || nodeEnvironment,
  });
}

function assertApiBaseUrl(input: string): void {
  try {
    const parsed = new URL(input);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      fail('API_BASE_URL_INVALID');
    }
  } catch {
    fail('API_BASE_URL_INVALID');
  }
}

function value(input: string | undefined): string {
  return input?.trim() ?? '';
}

function fail(code: string): never {
  throw new BotRuntimeConfigurationError(code);
}
