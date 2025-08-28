import 'dotenv/config';
import { Queue, Worker, JobsOptions } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
const queueName = 'econ-tick';
const queue = new Queue(queueName, { connection });

const intervalMs = parseInt(process.env.TICK_INTERVAL_MS || '5000', 10);

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
