import { monitoring, Sentry, registerProcessLogging } from './instrumentation.js';
import { Queue, Worker, JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';

const logger = pino({ name: 'econ-worker' });

registerProcessLogging(logger);

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  // BullMQ requires this to be null when blocking commands are used
  maxRetriesPerRequest: null,
});
const queueName = 'econ-tick';
const queue = new Queue(queueName, { connection });

const intervalMs = parseInt(process.env.TICK_INTERVAL_MS || '5000', 10);

// Optional: Discord bot token presence check (no value logged)
if (!process.env.DISCORD_BOT_TOKEN) {
  logger.warn('[env] DISCORD_BOT_TOKEN not set. Discord bot features are disabled.');
}

async function ensureRepeatingJob() {
  const repeat: JobsOptions['repeat'] = { every: intervalMs };
  await queue.add('tick', {}, { jobId: 'econ:tick', repeat, removeOnComplete: true, removeOnFail: true });
}

// Process economic ticks
const worker = new Worker(
  queueName,
  async (job) => {
    // Placeholder: compute market adjustments and persist results.
    // This is where you would:
    // - read current supply/demand from DB/cache
    // - compute price movements
    // - write a batch of changes (ledger entries, market quotes)
// For now, just log a heartbeat.
    logger.info({ jobName: job.name }, 'processed job');
  },
  { connection }
);

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'job failed');
  if (monitoring.sentry) {
    Sentry.withScope((scope) => {
      scope.setTag('service', 'worker');
      scope.setTag('queue', queueName);
      if (job) {
        scope.setExtra('jobId', job.id);
        scope.setExtra('jobName', job.name);
        scope.setExtra('jobData', job.data);
      }
      Sentry.captureException(err);
    });
  }
});

ensureRepeatingJob()
  .then(() => {
    logger.info({ intervalMs }, 'scheduled tick job');
  })
  .catch((e) => {
    logger.error({ err: e }, 'failed to schedule tick');
    if (monitoring.sentry) {
      Sentry.withScope((scope) => {
        scope.setTag('service', 'worker');
        scope.setTag('queue', queueName);
        scope.setLevel('error');
        Sentry.captureException(e);
      });
    }
    process.exit(1);
  });
