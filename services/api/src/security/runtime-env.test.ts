import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiComposition, RUNTIME_ERROR_ENVELOPE_VERSION } from '../app-composition.js';
import { readApiRuntimeEnvironment, RuntimeConfigurationError } from '../runtime-env.js';

const productionBase = Object.freeze({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://db-user:test-marker@database.internal/game',
  REDIS_URL: 'rediss://cache.internal:6380/0',
});

test('production API runtime rejects missing and partial required configuration with stable codes', () => {
  assert.throws(
    () => readApiRuntimeEnvironment({ NODE_ENV: 'production' }),
    (error) => error instanceof RuntimeConfigurationError && error.code === 'DATABASE_URL_REQUIRED',
  );
  assert.throws(
    () =>
      readApiRuntimeEnvironment({
        ...productionBase,
        CLERK_ISSUER: 'https://identity.example.test',
      }),
    (error) =>
      error instanceof RuntimeConfigurationError &&
      error.code === 'CLERK_CONFIGURATION_PARTIAL' &&
      !error.message.includes('identity.example.test'),
  );
});

test('production API runtime accepts complete bounded configuration', () => {
  const result = readApiRuntimeEnvironment({
    ...productionBase,
    CLERK_ISSUER: 'https://identity.example.test',
    CLERK_JWKS_URL: 'https://identity.example.test/.well-known/jwks.json',
    CLERK_AUDIENCES: 'econ-api',
    CLERK_AUTHORIZED_PARTIES: 'https://game.example.test',
    BOT_SERVICE_CREDENTIAL_SHA256: 'a'.repeat(64),
    BOT_SERVICE_PRINCIPAL_ID: 'bot:primary',
    BOT_SERVICE_SCOPES: 'game:command',
  });
  assert.equal(result.NODE_ENV, 'production');
  assert.equal(result.PORT, 4000);
});

test('unexpected API errors return a stable envelope without the error message', async () => {
  const app = createApiComposition();
  const marker = 'must-not-leave-server';
  app.get('/b3-error-probe', async () => {
    throw new Error(marker);
  });
  const response = await app.inject({ method: 'GET', url: '/b3-error-probe' });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    error: {
      version: RUNTIME_ERROR_ENVELOPE_VERSION,
      code: 'INTERNAL_SERVER_ERROR',
    },
  });
  assert.equal(response.body.includes(marker), false);
  await app.close();
});

test('client errors preserve only the allowed status through the Fastify error boundary', async () => {
  const app = createApiComposition();
  app.get('/b8-client-error-probe', async () => {
    throw Object.assign(new Error('must-not-leave-server'), { statusCode: 422 });
  });
  const response = await app.inject({ method: 'GET', url: '/b8-client-error-probe' });
  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.json(), {
    error: {
      version: RUNTIME_ERROR_ENVELOPE_VERSION,
      code: 'REQUEST_REJECTED',
    },
  });
  assert.equal(response.body.includes('must-not-leave-server'), false);
  await app.close();
});
