import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMAND_ENVELOPE_VERSION,
  CommandError,
  encodeCommandScope,
  hashCommandRequest,
  parseCommandEnvelope,
  type CommandEnvelope,
  type TrustedCommandContext,
} from './command-contract.js';
import {
  CommandDispatcher,
  InMemoryCommandExecutionStore,
  type CommandHandler,
} from './command-dispatcher.js';

const context: TrustedCommandContext = {
  actorId: 'player-1',
  tenantId: 'restaurant-1',
  saveId: 'save-1',
  roles: ['PLAYER'],
  membershipId: 'membership-1',
  branchScope: { kind: 'all' },
  principal: { type: 'web' },
};

function command(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    schemaVersion: COMMAND_ENVELOPE_VERSION,
    commandId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'command-key-1',
    commandType: 'SAVE_TEST_ADVANCE',
    aggregateId: 'save-1',
    expectedVersion: 1,
    payload: { label: 'open-day' },
    ...overrides,
  };
}

function createDispatcher(executions: { value: number }): CommandDispatcher {
  const handler: CommandHandler = {
    commandType: 'SAVE_TEST_ADVANCE',
    async execute({ command, currentVersion }) {
      executions.value += 1;
      return {
        aggregateVersion: currentVersion + 1,
        result: { acceptedLabel: command.payload.label ?? null, executions: executions.value },
      };
    },
  };
  return new CommandDispatcher([handler], new InMemoryCommandExecutionStore());
}

function dispatch(
  dispatcher: CommandDispatcher,
  envelope: unknown,
  trusted: unknown = context,
  target: { saveId: string; commandType: string } = {
    saveId: 'save-1',
    commandType: 'SAVE_TEST_ADVANCE',
  },
) {
  return dispatcher.dispatch({ context: trusted, target, envelope });
}

test('same logical request with a new commandId returns the original idempotent result exactly once', async () => {
  const executions = { value: 0 };
  const dispatcher = createDispatcher(executions);
  const first = command({ payload: { z: 2, a: { y: true, x: 'open-day' } } });
  const retry = command({
    commandId: '22222222-2222-4222-8222-222222222222',
    payload: { a: { x: 'open-day', y: true }, z: 2 },
  });

  const [firstResponse, retryResponse] = await Promise.all([
    dispatch(dispatcher, first),
    dispatch(dispatcher, retry),
  ]);

  assert.equal(executions.value, 1);
  assert.deepEqual(retryResponse, firstResponse);
  assert.equal(firstResponse.body.commandId, first.commandId);
  assert.equal(firstResponse.body.aggregateVersion, 2);
});

test('dispatcher rejects duplicate handler command types during composition', () => {
  const handler: CommandHandler = {
    commandType: 'SAVE_TEST_ADVANCE',
    async execute({ currentVersion }) {
      return { aggregateVersion: currentVersion + 1, result: {} };
    },
  };
  assert.throws(
    () => new CommandDispatcher([handler, handler], new InMemoryCommandExecutionStore()),
    /duplicate command handler: SAVE_TEST_ADVANCE/,
  );
});

test('idempotency key reuse with a different canonical command is a stable 409 conflict', async () => {
  const dispatcher = createDispatcher({ value: 0 });
  await dispatch(dispatcher, command());

  await assert.rejects(
    dispatch(dispatcher, command({ payload: { label: 'different' } })),
    (error) =>
      error instanceof CommandError &&
      error.status === 409 &&
      error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
});

test('D01 CompetitiveSave version one is the baseline and stale writes return 409', async () => {
  const executions = { value: 0 };
  const dispatcher = createDispatcher(executions);
  await dispatch(dispatcher, command());

  await assert.rejects(
    dispatch(
      dispatcher,
      command({
        commandId: '33333333-3333-4333-8333-333333333333',
        idempotencyKey: 'command-key-2',
      }),
    ),
    (error) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'EXPECTED_VERSION_CONFLICT');
      assert.deepEqual(error.details, { actualVersion: 2, expectedVersion: 1 });
      return true;
    },
  );
  assert.equal(executions.value, 1);
});

test('missing or cross-scope trusted context is rejected before a game command runs', async () => {
  const executions = { value: 0 };
  const dispatcher = createDispatcher(executions);

  await assert.rejects(
    dispatch(dispatcher, command(), null),
    (error) =>
      error instanceof CommandError &&
      error.status === 401 &&
      error.code === 'UNTRUSTED_COMMAND_CONTEXT',
  );
  await assert.rejects(
    dispatch(dispatcher, command(), { ...context, saveId: 'other-save' }),
    (error) =>
      error instanceof CommandError &&
      error.status === 422 &&
      error.code === 'COMMAND_SCOPE_MISMATCH',
  );
  assert.equal(executions.value, 0);
});

test('the envelope rejects client context, invalid Money, unknown commands, and unknown versions', async () => {
  assert.throws(
    () => parseCommandEnvelope({ ...command(), actorId: 'spoofed-player' }),
    (error) => error instanceof CommandError && error.code === 'COMMAND_ENVELOPE_INVALID',
  );
  assert.throws(
    () => parseCommandEnvelope(command({ payload: { nested: { tenantId: 'spoofed' } } })),
    (error) => error instanceof CommandError && error.code === 'CLIENT_CONTEXT_FIELD_FORBIDDEN',
  );
  assert.throws(
    () => parseCommandEnvelope(command({ payload: { price: { currency: 'usd', minorUnits: 1 } } })),
    (error) => error instanceof CommandError && error.code === 'MONEY_PAYLOAD_INVALID',
  );

  const dispatcher = createDispatcher({ value: 0 });
  await assert.rejects(
    dispatch(dispatcher, command({ commandType: 'UNKNOWN_COMMAND' }), context, {
      saveId: 'save-1',
      commandType: 'UNKNOWN_COMMAND',
    }),
    (error) =>
      error instanceof CommandError && error.status === 422 && error.code === 'UNKNOWN_COMMAND',
  );
  await assert.rejects(
    dispatch(dispatcher, { ...command(), schemaVersion: 'd02-command/v999' }),
    (error) =>
      error instanceof CommandError &&
      error.status === 422 &&
      error.code === 'UNSUPPORTED_COMMAND_ENVELOPE_VERSION',
  );
});

test('command resource limits fail with a stable 413 before handler mutation', async () => {
  const executions = { value: 0 };
  const dispatcher = createDispatcher(executions);
  let nested: unknown = 'leaf';
  for (let depth = 0; depth < 40; depth += 1) nested = { nested };

  await assert.rejects(
    dispatch(dispatcher, command({ payload: { nested } as CommandEnvelope['payload'] })),
    (error) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.status, 413);
      assert.equal(error.code, 'COMMAND_RESOURCE_LIMIT_EXCEEDED');
      assert.deepEqual(error.toBody(), {
        error: {
          version: 'd02-command-error/v1',
          code: 'COMMAND_RESOURCE_LIMIT_EXCEEDED',
          details: { limit: 'DEPTH' },
        },
      });
      return true;
    },
  );
  assert.equal(executions.value, 0);
});

test('fingerprints ignore commandId, include trusted scope, and use code-unit key ordering', () => {
  const first = command({ payload: { '\u00e9': 2, 'e\u0301': 1 } });
  const reordered = command({
    commandId: '44444444-4444-4444-8444-444444444444',
    payload: { 'e\u0301': 1, '\u00e9': 2 },
  });
  assert.equal(hashCommandRequest(first, context), hashCommandRequest(reordered, context));
  assert.notEqual(
    hashCommandRequest(first, context),
    hashCommandRequest(first, { ...context, actorId: 'player-2' }),
  );
  assert.equal(
    encodeCommandScope(['tenant:a', 'save:b', 'player:c']),
    '["tenant:a","save:b","player:c"]',
  );
});

test('structured scope encoding prevents colon-ID idempotency collisions', async () => {
  const executions = { value: 0 };
  const dispatcher = createDispatcher(executions);
  const firstContext = { ...context, tenantId: 'tenant:one', saveId: 'save', actorId: 'player' };
  const secondContext = { ...context, tenantId: 'tenant', saveId: 'one:save', actorId: 'player' };
  await dispatch(dispatcher, command({ aggregateId: 'save' }), firstContext, {
    saveId: 'save',
    commandType: 'SAVE_TEST_ADVANCE',
  });
  await dispatch(dispatcher, command({ aggregateId: 'one:save' }), secondContext, {
    saveId: 'one:save',
    commandType: 'SAVE_TEST_ADVANCE',
  });
  assert.equal(executions.value, 2);
});

test('dispatcher distinguishes unrestricted from empty branch scope and binds bot interaction idempotency', async () => {
  const executions = { value: 0 };
  const dispatcher = createDispatcher(executions);
  await assert.rejects(
    dispatch(dispatcher, command(), {
      ...context,
      branchScope: { kind: 'restricted', branchIds: [] },
    }),
    (error) =>
      error instanceof CommandError &&
      error.status === 403 &&
      error.code === 'COMMAND_BRANCH_SCOPE_FORBIDDEN',
  );
  const botContext: TrustedCommandContext = {
    ...context,
    principal: { type: 'discord_bot', interactionId: 'interaction-1' },
  };
  await dispatch(dispatcher, command({ idempotencyKey: 'interaction-1' }), botContext);
  await assert.rejects(
    dispatch(dispatcher, command({ idempotencyKey: 'different-key' }), {
      ...botContext,
    }),
    (error) =>
      error instanceof CommandError &&
      error.status === 409 &&
      error.code === 'DISCORD_INTERACTION_IDEMPOTENCY_MISMATCH',
  );
  await assert.rejects(
    dispatch(
      dispatcher,
      command({ idempotencyKey: 'interaction-1', payload: { label: 'different' } }),
      botContext,
    ),
    (error) =>
      error instanceof CommandError &&
      error.status === 409 &&
      error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  assert.equal(executions.value, 1);
});

test('accepted commands require one matching job outbox and memory execution fails closed', async () => {
  const jobId = '20000000-0000-4000-8000-000000000001';
  const eventId = '10000000-0000-4000-8000-000000000001';
  const acceptedResult = (currentVersion: number) =>
    ({
      status: 202,
      aggregateVersion: currentVersion + 1,
      jobId,
      result: { queued: true },
      effects: {
        outbox: [
          {
            kind: 'outbox.job-request/v1',
            eventId,
            eventSequence: 0,
            eventType: 'simulation.versioned-replay.requested',
            eventVersion: 1,
            jobId,
            payload: { jobId },
          },
        ],
      },
    }) as const;
  const validAccepted: CommandHandler = {
    commandType: 'SAVE_TEST_JOB',
    async execute({ currentVersion }) {
      return acceptedResult(currentVersion);
    },
  };
  await assert.rejects(
    dispatch(
      new CommandDispatcher([validAccepted], new InMemoryCommandExecutionStore()),
      command({ commandType: 'SAVE_TEST_JOB' }),
      context,
      { saveId: 'save-1', commandType: 'SAVE_TEST_JOB' },
    ),
    (error) =>
      error instanceof CommandError && error.code === 'COMMAND_PERSISTENCE_REQUIRED',
  );

  const rejected: readonly Readonly<{ handler: CommandHandler; message: RegExp }>[] = [
    {
      handler: {
        commandType: 'SAVE_TEST_JOB',
        async execute({ currentVersion }) {
          return {
            status: 202,
            aggregateVersion: currentVersion + 1,
            jobId: ' ',
            result: { queued: true },
          };
        },
      },
      message: /non-empty jobId/,
    },
    {
      handler: {
        commandType: 'SAVE_TEST_JOB',
        async execute({ currentVersion }) {
          return {
            status: 202,
            aggregateVersion: currentVersion + 1,
            jobId,
            result: { queued: true },
          };
        },
      },
      message: /exactly one job-request outbox/,
    },
    {
      handler: {
        commandType: 'SAVE_TEST_JOB',
        async execute({ currentVersion }) {
          return {
            ...acceptedResult(currentVersion),
            jobId: '20000000-0000-4000-8000-000000000002',
          };
        },
      },
      message: /jobId must match/,
    },
    {
      handler: {
        commandType: 'SAVE_TEST_JOB',
        async execute({ currentVersion }) {
          const accepted = acceptedResult(currentVersion);
          return {
            ...accepted,
            effects: {
              ...accepted.effects,
              ledger: {
                kind: 'ledger.posting/v1',
                transactionId: command().commandId,
                eventId: command().commandId,
                currency: 'TWD',
                reason: 'must not be persisted with a 202',
                lines: [],
              },
            },
          };
        },
      },
      message: /must not include a ledger effect/,
    },
  ];
  for (const candidate of rejected) {
    await assert.rejects(
      dispatch(
        new CommandDispatcher([candidate.handler], new InMemoryCommandExecutionStore()),
        command({ commandType: 'SAVE_TEST_JOB' }),
        context,
        { saveId: 'save-1', commandType: 'SAVE_TEST_JOB' },
      ),
      candidate.message,
    );
  }
});
