import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMAND_ENVELOPE_VERSION, EconGameApiError, GameCommandClient } from '../dist/index.js';

const envelope = {
  schemaVersion: COMMAND_ENVELOPE_VERSION,
  commandId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'open-day-1',
  commandType: 'SAVE_TEST_ADVANCE',
  aggregateId: 'save/1',
  expectedVersion: 3,
  payload: { note: 'open day' },
};

test('game command client calls the resource action path without accepting actor scope', async () => {
  let received;
  const client = new GameCommandClient({
    baseUrl: 'https://api.example.test',
    fetch: async (url, init) => {
      received = { url, init };
      return new Response(
        JSON.stringify({
          commandId: envelope.commandId,
          idempotencyKey: envelope.idempotencyKey,
          commandType: envelope.commandType,
          aggregateId: envelope.aggregateId,
          aggregateVersion: 4,
          result: { accepted: true },
        }),
        { status: 200 },
      );
    },
  });

  const response = await client.executeSaveAction('save/1', 'SAVE_TEST_ADVANCE', envelope);
  assert.equal(response.aggregateVersion, 4);
  assert.equal(received.url, 'https://api.example.test/saves/save%2F1/actions/SAVE_TEST_ADVANCE');
  assert.equal(received.init.body, JSON.stringify(envelope));
});

test('game command client rejects a body that tries to target another resource', () => {
  const client = new GameCommandClient({ baseUrl: 'https://api.example.test' });
  assert.throws(
    () =>
      client.executeSaveAction('save/1', 'SAVE_TEST_ADVANCE', {
        ...envelope,
        aggregateId: 'save/2',
      }),
    /target must match/,
  );
});

test('SDK accepts only exact 202 command receipts and rejects every own jobId on 200', async () => {
  const accepted = new GameCommandClient({
    baseUrl: 'https://api.example.test',
    fetch: async () =>
      new Response(JSON.stringify({
        commandId: envelope.commandId,
        idempotencyKey: envelope.idempotencyKey,
        commandType: envelope.commandType,
        aggregateId: envelope.aggregateId,
        aggregateVersion: 4,
        result: {},
        jobId: 'job-1',
      }), {
        status: 202,
      }),
  });
  assert.equal(
    (await accepted.executeSaveAction('save/1', 'SAVE_TEST_ADVANCE', envelope)).jobId,
    'job-1',
  );

  const malformed = new GameCommandClient({
    baseUrl: 'https://api.example.test',
    fetch: async () =>
      new Response(JSON.stringify({ aggregateVersion: 4, result: {} }), { status: 202 }),
  });
  await assert.rejects(
    malformed.executeSaveAction('save/1', 'SAVE_TEST_ADVANCE', envelope),
    /(unknown or missing fields|non-empty jobId)/,
  );

  const nonStringJobId = new GameCommandClient({
    baseUrl: 'https://api.example.test',
    fetch: async () =>
      new Response(JSON.stringify({
        commandId: envelope.commandId,
        idempotencyKey: envelope.idempotencyKey,
        commandType: envelope.commandType,
        aggregateId: envelope.aggregateId,
        aggregateVersion: 4,
        result: {},
        jobId: 9,
      }), { status: 202 }),
  });
  await assert.rejects(
    nonStringJobId.executeSaveAction('save/1', 'SAVE_TEST_ADVANCE', envelope),
    /non-empty jobId/,
  );

  const completedWithOwnJobId = new GameCommandClient({
    baseUrl: 'https://api.example.test',
    fetch: async () => new Response(JSON.stringify({ ...completedReceipt(), jobId: null }), { status: 200 }),
  });
  await assert.rejects(
    completedWithOwnJobId.executeSaveAction('save/1', 'SAVE_TEST_ADVANCE', envelope),
    /unknown or missing fields/,
  );
});

test('SDK rejects incomplete completed command receipts', async () => {
  const client = new GameCommandClient({
    baseUrl: 'https://api.example.test',
    fetch: async () => new Response(JSON.stringify({ commandId: envelope.commandId, result: {} }), { status: 200 }),
  });
  await assert.rejects(
    client.executeSaveAction('save/1', 'SAVE_TEST_ADVANCE', envelope),
    /unknown or missing fields/,
  );
});

for (const [status, code] of [
  [401, 'UNTRUSTED_COMMAND_CONTEXT'],
  [409, 'EXPECTED_VERSION_CONFLICT'],
  [422, 'COMMAND_SCOPE_MISMATCH'],
]) {
  test(`SDK reads D02 ${status} machine-readable error codes`, async () => {
    const client = new GameCommandClient({
      baseUrl: 'https://api.example.test',
      fetch: async () =>
        new Response(JSON.stringify({ error: { version: 'd02-command-error/v1', code } }), {
          status,
          statusText: 'Command failed',
        }),
    });
    await assert.rejects(
      client.executeSaveAction('save/1', 'SAVE_TEST_ADVANCE', envelope),
      (error) => {
        assert.ok(error instanceof EconGameApiError);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        assert.equal(error.errorVersion, 'd02-command-error/v1');
        return true;
      },
    );
  });
}

function completedReceipt() {
  return {
    commandId: envelope.commandId,
    idempotencyKey: envelope.idempotencyKey,
    commandType: envelope.commandType,
    aggregateId: envelope.aggregateId,
    aggregateVersion: 4,
    result: {},
  };
}
