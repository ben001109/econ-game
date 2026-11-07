import { monitoring, Sentry, registerProcessLogging } from './instrumentation.js';

import { env } from './env.js';
import { logger } from './logger.js';
import {
  isTransientSimulationInfrastructureError,
  PostgresSimulationPlatform,
  type SimulationDatabase,
} from './simulation-platform.js';

registerProcessLogging(logger);

const pollMilliseconds = env.D03_POLL_MS;
const leaseSeconds = env.D03_LEASE_SECONDS;
const workerId = env.D03_WORKER_ID;
const prismaModule = (await import('@prisma/client')) as unknown as Readonly<{
  PrismaClient: new (
    options?: unknown,
  ) => SimulationDatabase & Readonly<{ $disconnect(): Promise<void> }>;
}>;
const database = new prismaModule.PrismaClient({
  datasources: { db: { url: env.DATABASE_URL } },
});
const platform = new PostgresSimulationPlatform(database);
let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping = true;
  });
}

logger.info({ workerId, pollMilliseconds, leaseSeconds }, 'durable simulation worker started');

try {
  let consecutiveInfrastructureFailures = 0;
  while (!stopping) {
    try {
      const ingested = await platform.ingestNextOutbox();
      const processed = await platform.runOnce(workerId, leaseSeconds);
      consecutiveInfrastructureFailures = 0;
      if (!ingested && !processed) await delay(pollMilliseconds);
    } catch (error) {
      if (!isTransientSimulationInfrastructureError(error)) throw error;
      consecutiveInfrastructureFailures += 1;
      const retryMilliseconds = Math.min(
        30_000,
        pollMilliseconds * 2 ** Math.min(consecutiveInfrastructureFailures - 1, 8),
      );
      logger.error(
        { err: error, retryMilliseconds, consecutiveInfrastructureFailures },
        'transient simulation database failure; retrying without consuming the event',
      );
      if (monitoring.sentry) Sentry.captureException(new Error('WORKER_TRANSIENT_FAILURE'));
      await delay(retryMilliseconds);
    }
  }
} catch (error) {
  logger.fatal({ err: error }, 'durable simulation worker stopped unexpectedly');
  if (monitoring.sentry) {
    Sentry.withScope((scope) => {
      scope.setTag('service', 'worker');
      scope.setTag('worker', 'durable-simulation');
      Sentry.captureException(new Error('WORKER_RUNTIME_FAILED'));
    });
  }
  process.exitCode = 1;
} finally {
  await database.$disconnect();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
