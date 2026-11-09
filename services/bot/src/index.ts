import { pathToFileURL } from 'node:url';

import { startBot } from './bot-runtime.js';
import { monitoring, registerProcessLogging, Sentry } from './instrumentation.js';
import { logger } from './logger.js';

export { BotStartupError, startBot, type StartBotOptions } from './bot-runtime.js';

function captureBotError(error: unknown, event: string): void {
  logger.error({ error }, `Discord bot ${event} failed`);
  if (!monitoring.sentry) return;
  Sentry.withScope((scope) => {
    scope.setTag('service', 'bot');
    scope.setTag('event', event);
    Sentry.captureException(new Error('BOT_RUNTIME_FAILED'));
  });
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(entrypoint).href);
}

if (isMainModule()) {
  registerProcessLogging(logger);
  void startBot({ onError: captureBotError }).catch((error) => {
    captureBotError(error, 'startup');
    process.exitCode = 1;
  });
}
