import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino, { Logger, TransportTargetOptions } from 'pino';

type CreateLoggerOptions = {
  name?: string;
  fileBaseName?: string;
};

export const LOGGER_REDACTION = Object.freeze({
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers.x-correlation-id',
    'request.headers.authorization',
    'request.headers.cookie',
    'request.headers.x-correlation-id',
    'headers.authorization',
    'headers.cookie',
    'headers.x-correlation-id',
    'req.body.token',
    'request.body.token',
    'body.token',
    '*.token',
    '*.challengeToken',
    '*.discordOAuthProof',
    '*.reauthenticationProof',
    'password',
    'secret',
    'credential',
    'apiKey',
    'accessToken',
    'refreshToken',
    'databaseUrl',
    'dsn',
    'DATABASE_URL',
    'DISCORD_BOT_TOKEN',
    'BOT_SERVICE_CREDENTIAL',
    'NEW_RELIC_LICENSE_KEY',
    'SENTRY_DSN',
    '*.password',
    '*.secret',
    '*.credential',
    '*.apiKey',
    '*.accessToken',
    '*.refreshToken',
    '*.databaseUrl',
    '*.dsn',
    '*.DATABASE_URL',
    '*.DISCORD_BOT_TOKEN',
    '*.BOT_SERVICE_CREDENTIAL',
    '*.NEW_RELIC_LICENSE_KEY',
    '*.SENTRY_DSN',
  ],
  censor: '[REDACTED]',
});

export function safeErrorSerializer(value: unknown): Readonly<Record<string, string>> {
  const record =
    typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : {};
  const type =
    value instanceof Error
      ? value.name
      : typeof record.name === 'string' && record.name
        ? record.name
        : 'Error';
  const code =
    typeof record.code === 'string' && /^[A-Z0-9_:-]{1,128}$/i.test(record.code)
      ? record.code
      : undefined;
  return Object.freeze({ type, ...(code ? { code } : {}) });
}

const ERROR_SERIALIZERS = Object.freeze({
  err: safeErrorSerializer,
  error: safeErrorSerializer,
  warning: safeErrorSerializer,
});

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(moduleDir, '..');

const FALSE_STRINGS = new Set(['0', 'false', 'off', 'no']);

const normalizeBool = (value: string | undefined) => {
  if (!value) return false;
  return FALSE_STRINGS.has(value.trim().toLowerCase());
};

const resolveDefaultFileName = (fileBaseName: string) => {
  const suffix =
    process.env.LOG_FILE_SUFFIX ?? (process.env.NODE_ENV === 'production' ? '' : '-dev');
  return `${fileBaseName}${suffix}.log`;
};

const resolveLogPath = (defaultFileName: string): string | null => {
  if (normalizeBool(process.env.LOG_TO_FILE)) {
    return null;
  }

  const explicitFile = process.env.LOG_FILE?.trim();
  if (explicitFile) {
    return path.isAbsolute(explicitFile) ? explicitFile : path.resolve(serviceRoot, explicitFile);
  }

  const dirSetting = process.env.LOG_DIR?.trim() || '../../logs';
  const baseDir = path.isAbsolute(dirSetting) ? dirSetting : path.resolve(serviceRoot, dirSetting);
  return path.join(baseDir, defaultFileName);
};

export const createLogger = (options: CreateLoggerOptions = {}): Logger => {
  const level = process.env.LOG_LEVEL ?? 'info';
  const name = options.name ?? 'econ-api';
  const fileBaseName = options.fileBaseName ?? 'api';

  const logPath = resolveLogPath(resolveDefaultFileName(fileBaseName));
  if (!logPath) {
    return pino({ level, name, redact: LOGGER_REDACTION, serializers: ERROR_SERIALIZERS });
  }

  const targets: TransportTargetOptions[] = [
    { target: 'pino/file', level, options: { destination: 1 } },
    { target: 'pino/file', level, options: { destination: logPath, mkdir: true } },
  ];

  const transport = pino.transport({ targets });
  return pino({ level, name, redact: LOGGER_REDACTION, serializers: ERROR_SERIALIZERS }, transport);
};

export const logger = createLogger();
