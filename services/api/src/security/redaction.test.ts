import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';

import { LOGGER_REDACTION, safeErrorSerializer } from '../logger.js';
import { redactTelemetryValue, safeTelemetryRoute } from './redaction.js';

test('redacts credentials, cookies, identity PII, proofs, and nested invite tokens', () => {
  const raw = {
    authorization: 'Bearer raw-jwt',
    cookie: 'session=raw-cookie',
    databaseUrl: 'postgresql://user:raw-database-password@database.internal/game',
    nested: {
      token: 'raw-invite-token',
      credential: 'raw-service-credential',
      challengeToken: 'raw-link-token',
      discordOAuthProof: 'raw-proof',
      clerkUserId: 'user-pii',
      safe: 'correlation-id',
    },
  };
  const output = redactTelemetryValue(raw);
  const serialized = JSON.stringify(output);
  for (const secret of [
    'raw-jwt',
    'raw-cookie',
    'raw-database-password',
    'raw-invite-token',
    'raw-service-credential',
    'raw-link-token',
    'raw-proof',
    'user-pii',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes('correlation-id'), true);
});

test('structured logger redacts authorization, cookies, client correlation, and invite tokens', () => {
  let output = '';
  const destination = {
    write(chunk: string) {
      output += chunk;
      return true;
    },
  };
  const logger = pino({ redact: LOGGER_REDACTION }, destination);
  logger.error({
    req: {
      headers: {
        authorization: 'Bearer raw-jwt',
        cookie: 'session=raw-cookie',
        'x-correlation-id': 'attacker-controlled-correlation',
      },
      body: { token: 'raw-invite-token' },
    },
  });
  assert.equal(output.includes('raw-jwt'), false);
  assert.equal(output.includes('raw-cookie'), false);
  assert.equal(output.includes('raw-invite-token'), false);
  assert.equal(output.includes('attacker-controlled-correlation'), false);
  assert.equal((output.match(/\[REDACTED\]/g) ?? []).length, 4);
});

test('structured logger removes secret-bearing error messages and configuration fields', () => {
  const marker = 'must-not-appear';
  const serializedError = safeErrorSerializer(
    Object.assign(new Error(`database rejected ${marker}`), { code: 'CONNECTION_REFUSED' }),
  );
  assert.deepEqual(serializedError, { type: 'Error', code: 'CONNECTION_REFUSED' });

  let output = '';
  const destination = {
    write(chunk: string) {
      output += chunk;
      return true;
    },
  };
  const logger = pino({ redact: LOGGER_REDACTION }, destination);
  logger.error({
    DATABASE_URL: `postgresql://user:${marker}@database.internal/game`,
    nested: { BOT_SERVICE_CREDENTIAL: marker },
  });
  assert.equal(output.includes(marker), false);
  assert.equal((output.match(/\[REDACTED\]/g) ?? []).length, 2);
});

test('telemetry fallback routes remove query strings that may carry credentials', () => {
  assert.equal(
    safeTelemetryRoute(undefined, '/closed-beta/redeem?token=secret'),
    '/closed-beta/redeem',
  );
  assert.equal(
    safeTelemetryRoute('/closed-beta/invites/redeem', '/closed-beta/invites/redeem?token=secret'),
    '/closed-beta/invites/redeem',
  );
});
