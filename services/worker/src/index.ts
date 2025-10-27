import './instrumentation.js';
import { Queue, Worker, JobsOptions } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  // BullMQ requires this to be null when blocking commands are used
  maxRetriesPerRequest: null,
});
const queueName = 'econ-tick';
const queue = new Queue(queueName, { connection });

const intervalMs = parseInt(process.env.TICK_INTERVAL_MS || '5000', 10);

// Optional: Discord bot token presence check (no value logged)
if (!process.env.DISCORD_BOT_TOKEN) {
  // eslint-disable-next-line no-console
  console.warn('[env] DISCORD_BOT_TOKEN not set. Discord bot features are disabled.');
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
    // eslint-disable-next-line no-console
    console.log(`[econ-worker] processed job ${job.name} @ ${new Date().toISOString()}`);
  },
  { connection }
);

worker.on('failed', (job, err) => {
  // eslint-disable-next-line no-console
  console.error(`[econ-worker] job failed ${job?.id}:`, err);
});

ensureRepeatingJob()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`[econ-worker] scheduled tick every ${intervalMs}ms`);
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[econ-worker] failed to schedule tick', e);
    process.exit(1);
  });
