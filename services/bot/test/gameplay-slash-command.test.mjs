import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { executeGameplaySlashCommand } from '../dist/test-only/gameplay-runtime.js';

const statusDisplay = Object.freeze({
  kind: 'status',
  phase: 'OPEN_REQUIRED',
  nextAction: 'OPEN_BUSINESS_DAY',
  aggregateVersion: 4,
  businessDay: null,
});

test('game slash definition is registered with the exact post-bootstrap surface', () => {
  const definition = readFileSync(join(process.cwd(), 'src/commands/game.ts'), 'utf8');
  const registry = readFileSync(join(process.cwd(), 'src/commands/index.ts'), 'utf8');

  for (const name of ['status', 'open', 'advance', 'settle', 'replay', 'replay-status']) {
    assert.match(definition, new RegExp(`setName\\('${name}'\\)`));
  }
  assert.match(definition, /setName\('owner-assignment'\)/);
  assert.match(definition, /setName\('job-id'\)/);
  assert.match(registry, /import \* as game from '\.\/game\.js';/);
  assert.match(registry, /\[ping, ops, game\]/);
  assert.doesNotMatch(registry, /import \* as (?:pos|kds) from /);
  assert.doesNotMatch(definition, /setName\('(bootstrap|configure|wipe|link|pos|kds)'\)/);
});

test('game slash adapter always acknowledges ephemerally and delegates only the allowlisted input', async () => {
  const calls = [];
  const runtime = {
    async status(interaction) {
      calls.push(['status', interaction]);
      return statusDisplay;
    },
    async open(interaction) {
      calls.push(['open', interaction]);
      return statusDisplay;
    },
    async advance(interaction, ownerAssignment) {
      calls.push(['advance', interaction, ownerAssignment]);
      return statusDisplay;
    },
    async settle(interaction) {
      calls.push(['settle', interaction]);
      return statusDisplay;
    },
    async replay(interaction) {
      calls.push(['replay', interaction]);
      return replayDisplay();
    },
    async replayStatus(interaction, jobId) {
      calls.push(['replay-status', interaction, jobId]);
      return replayDisplay(jobId);
    },
  };

  const cases = [
    ['status', {}, ['status']],
    ['open', {}, ['open']],
    ['advance', { 'owner-assignment': 'FRONT' }, ['advance', undefined, 'FRONT']],
    ['settle', {}, ['settle']],
    ['replay', {}, ['replay']],
    ['replay-status', { 'job-id': 'job_42' }, ['replay-status', undefined, 'job_42']],
  ];

  for (const [subcommand, values, expected] of cases) {
    const interaction = slashInteraction(subcommand, values);
    await executeGameplaySlashCommand(interaction, () => runtime);
    assert.deepEqual(interaction.deferred, [{ ephemeral: true }]);
    assert.equal(interaction.edited.length, 1);
    assert.match(interaction.edited[0], /^(Game status:|Replay:)/);

    const call = calls.at(-1);
    assert.equal(call[0], expected[0]);
    assert.deepEqual(call[1], {
      discordUserId: 'discord_user_1',
      interactionId: 'interaction_1',
      correlationId: 'interaction_1',
    });
    if (expected[0] === 'advance') assert.equal(call[2], expected[2]);
    if (expected[0] === 'replay-status') assert.equal(call[2], expected[2]);
    assert.doesNotMatch(JSON.stringify(call), /saveId|expectedVersion|businessDay|authorization|scope/i);
  }
});

test('game slash adapter rejects unknown subcommands, options, malformed identifiers, and unsafe values', async () => {
  let calls = 0;
  const runtime = {
    async status() {
      calls += 1;
      return statusDisplay;
    },
    async open() {
      calls += 1;
      return statusDisplay;
    },
    async advance() {
      calls += 1;
      return statusDisplay;
    },
    async settle() {
      calls += 1;
      return statusDisplay;
    },
    async replay() {
      calls += 1;
      return replayDisplay();
    },
    async replayStatus() {
      calls += 1;
      return replayDisplay();
    },
  };

  const invalid = [
    slashInteraction('bootstrap', {}),
    slashInteraction('status', { injected: 'value' }),
    slashInteraction('advance', { 'owner-assignment': 'OWNER' }),
    slashInteraction('replay-status', { 'job-id': 'not valid' }),
    slashInteraction('status', {}, { id: 'bad id' }),
    slashInteraction('status', {}, { userId: '' }),
  ];
  for (const interaction of invalid) {
    await executeGameplaySlashCommand(interaction, () => runtime);
    assert.deepEqual(interaction.deferred, [{ ephemeral: true }]);
    assert.deepEqual(interaction.edited, ['Game command failed (BOT_GAMEPLAY_COMMAND_FAILED).']);
  }
  assert.equal(calls, 0);
});

test('game slash adapter never renders thrown credentials or arbitrary failure payloads', async () => {
  const interaction = slashInteraction('status', {});
  await executeGameplaySlashCommand(interaction, () => ({
    async status() {
      throw new Error('Bearer private-token BOT_SERVICE_CREDENTIAL=secret');
    },
  }));
  assert.deepEqual(interaction.deferred, [{ ephemeral: true }]);
  assert.deepEqual(interaction.edited, ['Game command failed (BOT_GAMEPLAY_COMMAND_FAILED).']);
  assert.doesNotMatch(interaction.edited.join('\n'), /private-token|credential|secret/i);
});

function slashInteraction(subcommand, values, overrides = {}) {
  const options = Object.entries(values).map(([name]) => ({ name }));
  const deferred = [];
  const edited = [];
  return {
    id: overrides.id ?? 'interaction_1',
    user: { id: overrides.userId ?? 'discord_user_1' },
    options: {
      data: [{ name: subcommand, options }],
      getSubcommand() {
        return subcommand;
      },
      getString(name) {
        return Object.hasOwn(values, name) ? values[name] : null;
      },
    },
    deferred,
    edited,
    async deferReply(value) {
      deferred.push(value);
    },
    async editReply(value) {
      edited.push(value);
    },
  };
}

function replayDisplay(jobId = 'job_1') {
  return {
    kind: 'replay',
    jobId,
    status: 'RUNNING',
    terminal: false,
  };
}
