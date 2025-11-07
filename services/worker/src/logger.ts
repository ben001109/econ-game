import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino, { Logger, TransportTargetOptions } from 'pino';

type CreateLoggerOptions = {
  name?: string;
  fileBaseName?: string;
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(moduleDir, '..');

const FALSE_STRINGS = new Set(['0', 'false', 'off', 'no']);

const normalizeBool = (value: string | undefined) => {
  if (!value) return false;
  return FALSE_STRINGS.has(value.trim().toLowerCase());
};

const resolveDefaultFileName = (fileBaseName: string) => {
  const suffix = process.env.LOG_FILE_SUFFIX ?? (process.env.NODE_ENV === 'production' ? '' : '-dev');
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
  const name = options.name ?? 'econ-worker';
  const fileBaseName = options.fileBaseName ?? 'worker';

  const logPath = resolveLogPath(resolveDefaultFileName(fileBaseName));
  if (!logPath) {
    return pino({ level, name });
  }

  const targets: TransportTargetOptions[] = [
    { target: 'pino/file', level, options: { destination: 1 } },
    { target: 'pino/file', level, options: { destination: logPath, mkdir: true } },
  ];

  const transport = pino.transport({ targets });
  return pino({ level, name }, transport);
};

export const logger = createLogger();
