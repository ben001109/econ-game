import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  BotCommandError,
  BotD02GameCommandClient,
  D02_COMMAND_ENVELOPE_VERSION,
} from '../dist/test-only/d02-game-command-client.js';
import { startConnectedBot } from '../dist/test-only/startup-policy.js';
import {
  BotRuntimeConfigurationError,
  readBotRuntimeEnvironment,
} from '../dist/test-only/runtime-env.js';

const botInput = {
  discordUserId: 'discord-user-1',
  interactionId: 'discord-interaction-1',
  target: { saveId: 'save-one', commandType: 'SAVE_TEST_ADVANCE' },
  expectedVersion: 3,
  payload: { note: 'advance' },
};

test('Bot D04 principal request preserves interaction idempotency without client identity scope', async () => {
  let captured;
  const client = new BotD02GameCommandClient({
    apiBaseUrl: 'https://api.example.test',
    serviceCredential: 'service-credential',
    createCommandId: () => '22222222-2222-4222-8222-222222222222',
    fetch: async (url, init) => {
      captured = { url: String(url), init };
      return new Response(
        JSON.stringify({
          commandId: '22222222-2222-4222-8222-222222222222',
          idempotencyKey: botInput.interactionId,
          commandType: botInput.target.commandType,
          aggregateId: botInput.target.saveId,
          aggregateVersion: 4,
          result: { accepted: true },
        }),
        { status: 200 },
      );
    },
  });

  await client.execute(botInput);
  const headers = new Headers(captured.init.headers);
  assert.equal(headers.get('authorization'), 'Bot service-credential');
  assert.equal(headers.get('x-discord-user-id'), botInput.discordUserId);
  assert.equal(headers.get('x-discord-interaction-id'), botInput.interactionId);
  assert.equal(headers.get('x-correlation-id'), botInput.interactionId);
  const envelope = JSON.parse(captured.init.body);
  assert.equal(envelope.schemaVersion, D02_COMMAND_ENVELOPE_VERSION);
  assert.equal(envelope.idempotencyKey, botInput.interactionId);
  assert.equal(envelope.aggregateId, botInput.target.saveId);
  for (const forbidden of ['actor', 'actorId', 'tenant', 'tenantId', 'roles', 'permissions']) {
    assert.equal(Object.hasOwn(envelope, forbidden), false);
  }
});

test('Bot surfaces stable unlinked and unauthorized D04 failures', async () => {
  for (const [status, code] of [
    [401, 'UNTRUSTED_COMMAND_CONTEXT'],
    [403, 'DISCORD_IDENTITY_LINK_REQUIRED'],
    [403, 'COMMAND_SCOPE_FORBIDDEN'],
  ]) {
    const client = new BotD02GameCommandClient({
      apiBaseUrl: 'https://api.example.test',
      serviceCredential: 'service-credential',
      fetch: async () =>
        new Response(JSON.stringify({ error: { version: 'd02-command-error/v1', code } }), {
          status,
        }),
    });
    await assert.rejects(client.execute(botInput), (error) => {
      assert.ok(error instanceof BotCommandError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      return true;
    });
  }
});

test('Bot rejects client-supplied tenant, actor, or role claims before transport', async () => {
  let fetchCalls = 0;
  const client = new BotD02GameCommandClient({
    apiBaseUrl: 'https://api.example.test',
    serviceCredential: 'service-credential',
    fetch: async () => {
      fetchCalls += 1;
      return new Response('{}');
    },
  });
  for (const payload of [
    { tenantId: 'attacker' },
    { nested: { actorId: 'attacker' } },
    { roles: ['OWNER'] },
  ]) {
    await assert.rejects(
      client.execute({ ...botInput, payload }),
      (error) =>
        error instanceof BotCommandError && error.code === 'CLIENT_CONTEXT_FIELD_FORBIDDEN',
    );
  }
  assert.equal(fetchCalls, 0);
});

test('missing Bot principal configuration fails closed before transport', async () => {
  let fetchCalls = 0;
  const client = new BotD02GameCommandClient({
    apiBaseUrl: 'https://api.example.test',
    fetch: async () => {
      fetchCalls += 1;
      return new Response('{}');
    },
  });
  await assert.rejects(
    client.execute(botInput),
    (error) => error instanceof BotCommandError && error.code === 'BOT_PRINCIPAL_NOT_CONFIGURED',
  );
  assert.equal(fetchCalls, 0);
});

test('normal Bot start logs in without command cleanup or process exit', async () => {
  let loginToken;
  let handlersInstalled = false;
  const client = {
    async login(token) {
      loginToken = token;
      return token;
    },
  };
  const started = await startConnectedBot(client, 'test-discord-token', () => {
    handlersInstalled = true;
  });
  assert.equal(started, client);
  assert.equal(loginToken, 'test-discord-token');
  assert.equal(handlersInstalled, true);
  await assert.rejects(
    startConnectedBot(client, '', () => {
      throw new Error('handlers must not install without a token');
    }),
    (error) => error.code === 'DISCORD_BOT_TOKEN_NOT_CONFIGURED',
  );

  const source = ['src/index.ts', 'src/bot-runtime.ts', 'src/startup-policy.ts']
    .map((path) => readFileSync(join(process.cwd(), path), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /commands\.set\(\s*\[\s*\]\s*\)/);
  assert.doesNotMatch(source, /process\.exit\s*\(/);
});

test('production Bot commands contain no legacy compatibility route references', () => {
  const source = ['src/commands/ops.ts', 'src/commands/pos.ts', 'src/commands/kds.ts']
    .map((path) => readFileSync(join(process.cwd(), path), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /\/(?:bootstrap|orders|menus|restaurants|kds\/tickets)(?:[/'"`?]|$)/);
});

test('production Bot runtime requires server-owned credentials and a bounded API URL', () => {
  assert.throws(
    () => readBotRuntimeEnvironment({ NODE_ENV: 'production' }),
    (error) =>
      error instanceof BotRuntimeConfigurationError && error.code === 'DISCORD_BOT_TOKEN_REQUIRED',
  );
  assert.throws(
    () =>
      readBotRuntimeEnvironment({
        NODE_ENV: 'production',
        DISCORD_BOT_TOKEN: 'test-marker',
        API_BASE_URL: 'https://user:password@api.example.test',
        BOT_SERVICE_CREDENTIAL: 'service-marker',
      }),
    (error) =>
      error instanceof BotRuntimeConfigurationError &&
      error.code === 'API_BASE_URL_INVALID' &&
      !error.message.includes('password'),
  );
  const result = readBotRuntimeEnvironment({
    NODE_ENV: 'production',
    DISCORD_BOT_TOKEN: 'test-marker',
    API_BASE_URL: 'https://api.example.test',
    BOT_SERVICE_CREDENTIAL: 'service-marker',
  });
  assert.equal(result.NODE_ENV, 'production');
});
