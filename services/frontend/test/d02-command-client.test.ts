import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  D02_COMMAND_ENVELOPE_VERSION,
  WebCommandError,
  WebD02GameCommandClient,
  WebOperationalCommandRuntime,
} from '../lib/d02-game-command-client.js';

const commandInput = {
  target: { saveId: 'save/one', commandType: 'SAVE_TEST_ADVANCE' },
  expectedVersion: 7,
  idempotencyKey: 'web-action-1',
  payload: { note: 'advance' },
} as const;

test('Web typed command client sends the D02 envelope and bearer credential only', async () => {
  let captured: Readonly<{ url: string; init?: RequestInit }> | undefined;
  const client = new WebD02GameCommandClient({
    apiBaseUrl: 'https://api.example.test/',
    getAccessToken: async () => 'web-token',
    createCommandId: () => '11111111-1111-4111-8111-111111111111',
    fetch: async (url, init) => {
      captured = { url: String(url), init };
      return new Response(
        JSON.stringify({
          commandId: '11111111-1111-4111-8111-111111111111',
          idempotencyKey: commandInput.idempotencyKey,
          commandType: commandInput.target.commandType,
          aggregateId: commandInput.target.saveId,
          aggregateVersion: 8,
          result: { accepted: true },
        }),
        { status: 200 },
      );
    },
  });

  const result = await client.execute(commandInput);
  assert.equal(result.aggregateVersion, 8);
  assert.equal(
    captured?.url,
    'https://api.example.test/saves/save%2Fone/actions/SAVE_TEST_ADVANCE',
  );
  const headers = new Headers(captured?.init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer web-token');
  assert.deepEqual(JSON.parse(String(captured?.init?.body)), {
    schemaVersion: D02_COMMAND_ENVELOPE_VERSION,
    commandId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'web-action-1',
    commandType: 'SAVE_TEST_ADVANCE',
    aggregateId: 'save/one',
    expectedVersion: 7,
    payload: { note: 'advance' },
  });
  assert.equal(String(captured?.init?.body).includes('actorId'), false);
  assert.equal(String(captured?.init?.body).includes('tenantId'), false);
  assert.equal(String(captured?.init?.body).includes('roles'), false);
});

test('missing Web auth configuration and mapping fail closed before fetch', async () => {
  let fetchCalls = 0;
  const client = new WebD02GameCommandClient({
    apiBaseUrl: 'https://api.example.test',
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('must not reach fetch');
    },
  });
  await assert.rejects(client.execute(commandInput), errorCode('WEB_COMMAND_AUTH_NOT_CONFIGURED'));

  const runtime = new WebOperationalCommandRuntime(client, {});
  await assert.rejects(
    runtime.execute('pos.open', { idempotencyKey: 'interaction-1', payload: {} }),
    errorCode('WEB_COMMAND_MAPPING_NOT_CONFIGURED'),
  );
  assert.equal(fetchCalls, 0);
});

test('D02 machine errors remain stable and client identity claims are rejected', async () => {
  const forbidden = new WebD02GameCommandClient({
    apiBaseUrl: 'https://api.example.test',
    getAccessToken: async () => 'web-token',
    fetch: async () => new Response('{}', { status: 200 }),
  });
  await assert.rejects(
    forbidden.execute({ ...commandInput, payload: { nested: { tenantId: 'attacker' } } }),
    errorCode('CLIENT_CONTEXT_FIELD_FORBIDDEN'),
  );

  for (const [status, code] of [
    [401, 'UNTRUSTED_COMMAND_CONTEXT'],
    [403, 'CLOSED_BETA_NOT_ELIGIBLE'],
    [409, 'EXPECTED_VERSION_CONFLICT'],
  ] as const) {
    const client = new WebD02GameCommandClient({
      apiBaseUrl: 'https://api.example.test',
      getAccessToken: async () => 'web-token',
      fetch: async () =>
        new Response(JSON.stringify({ error: { version: 'd02-command-error/v1', code } }), {
          status,
        }),
    });
    await assert.rejects(client.execute(commandInput), (error: unknown) => {
      assert.ok(error instanceof WebCommandError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      return true;
    });
  }
});

test('production Web pages contain no legacy compatibility route references', () => {
  const source = ['pages/pos.tsx', 'pages/kds.tsx']
    .map((path) => readFileSync(join(process.cwd(), path), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /\/(?:bootstrap|orders|menus|restaurants|kds\/tickets)(?:[/'"`?]|$)/);
});

function errorCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof WebCommandError && error.code === code;
}
