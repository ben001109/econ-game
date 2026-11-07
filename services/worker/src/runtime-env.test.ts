import assert from 'node:assert/strict';
import test from 'node:test';

import { readWorkerRuntimeEnvironment, WorkerRuntimeConfigurationError } from './runtime-env.js';

test('worker requires a durable database and rejects unbounded runtime values', () => {
  assert.throws(
    () => readWorkerRuntimeEnvironment({}, 42),
    (error) =>
      error instanceof WorkerRuntimeConfigurationError && error.code === 'DATABASE_URL_REQUIRED',
  );
  assert.throws(
    () =>
      readWorkerRuntimeEnvironment(
        {
          DATABASE_URL: 'postgresql://db-user:test-marker@database.internal/game',
          D03_POLL_MS: '1',
        },
        42,
      ),
    (error) =>
      error instanceof WorkerRuntimeConfigurationError &&
      error.code === 'D03_INTEGER_CONFIGURATION_OUT_OF_RANGE',
  );
});

test('worker derives only a bounded non-secret runtime identity', () => {
  const result = readWorkerRuntimeEnvironment(
    { DATABASE_URL: 'postgresql://db-user:test-marker@database.internal/game' },
    42,
  );
  assert.equal(result.D03_WORKER_ID, 'simulation-worker:42');
  assert.equal(result.D03_POLL_MS, 1_000);
  assert.equal(result.D03_LEASE_SECONDS, 60);
});
