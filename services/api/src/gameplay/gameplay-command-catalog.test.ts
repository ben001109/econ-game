import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GAMEPLAY_COMMAND_CATALOG_VERSION,
  gameplayCommandCatalog,
  gameplayCommandTypes,
} from './gameplay-command-catalog.js';

const forbiddenAuthorityFields = [
  'actorId',
  'tenantId',
  'restaurantId',
  'seed',
  'version',
  'money',
  'risk',
  'forecast',
  'flowMetrics',
  'frontServiceDelayTicks',
  'foodQuality',
  'serviceSpeed',
  'preopenSnapshot',
  'menuSnapshot',
  'prices',
  'prepSnapshot',
  'layoutSnapshot',
] as const;

test('the catalog fixes the v1 command order and permits each command exactly once', () => {
  assert.equal(GAMEPLAY_COMMAND_CATALOG_VERSION, 'p0-gameplay-command-catalog/v1');
  assert.deepEqual(
    gameplayCommandCatalog.map((entry) => entry.commandType),
    [
      'INITIALIZE_COMPETITIVE_SAVE',
      'CONFIGURE_PREOPEN_DAY',
      'OPEN_BUSINESS_DAY',
      'ADVANCE_SERVICE_PERIOD',
      'SETTLE_BUSINESS_DAY',
      'REQUEST_DAY_REPLAY',
    ],
  );
  assert.deepEqual(
    gameplayCommandTypes,
    gameplayCommandCatalog.map((entry) => entry.commandType),
  );
  assert.equal(new Set(gameplayCommandCatalog.map((entry) => entry.commandType)).size, 6);
});

test('the data-only catalog and nested contract values are frozen', () => {
  assert.ok(Object.isFrozen(gameplayCommandCatalog));
  for (const command of gameplayCommandCatalog) {
    assert.ok(Object.isFrozen(command));
    assert.ok(Object.isFrozen(command.allowedRoles));
    assert.ok(Object.isFrozen(command.projection));
    assert.ok(Object.isFrozen(command.projection.includes));
    assert.ok(Object.isFrozen(command.projection.job));
    assert.ok(Object.isFrozen(command.clientForbiddenAuthorityFields));
    assert.ok(Object.isFrozen(command.clientNonAuthoritativeInputs));
  }
  assert.equal(Reflect.set(gameplayCommandCatalog as object, '0', {}), false);
});

test('each command carries minimal roles and explicit server-derived projection semantics', () => {
  for (const command of gameplayCommandCatalog) {
    assert.equal(command.projection.source, 'SERVER_DERIVED');
    assert.ok(command.projection.includes.length > 0);
    assert.ok(command.allowedRoles.length > 0);
    assert.ok(command.allowedRoles.every((role) => role === 'OWNER' || role === 'MANAGER'));
  }

  assert.deepEqual(gameplayCommandCatalog[0]?.allowedRoles, ['OWNER']);
  assert.ok(
    gameplayCommandCatalog.slice(1).every((command) => command.allowedRoles.includes('MANAGER')),
  );
  assert.equal(gameplayCommandCatalog[5]?.projection.job.required, true);
  assert.equal(gameplayCommandCatalog[5]?.projection.job.acceptedStatus, 202);
  assert.equal(gameplayCommandCatalog[5]?.projection.job.projection, 'DAY_REPLAY');
});

test('only replay requests require a 202 job projection', () => {
  const jobCommands = gameplayCommandCatalog.filter((command) => command.projection.job.required);
  assert.deepEqual(
    jobCommands.map((command) => command.commandType),
    ['REQUEST_DAY_REPLAY'],
  );
  assert.ok(
    gameplayCommandCatalog
      .filter((command) => !command.projection.job.required)
      .every(
        (command) =>
          command.projection.job.acceptedStatus === 200 &&
          command.projection.job.projection === 'NONE',
      ),
  );
});

test('pre-open configuration is synchronous, server-authoritative, and consumed by opening', () => {
  const configure = gameplayCommandCatalog[1];
  const open = gameplayCommandCatalog[2];

  assert.equal(configure?.commandType, 'CONFIGURE_PREOPEN_DAY');
  assert.deepEqual(configure?.allowedRoles, ['OWNER', 'MANAGER']);
  assert.equal(configure?.projection.job.required, false);
  assert.equal(configure?.projection.job.acceptedStatus, 200);
  assert.equal(configure?.projection.job.projection, 'NONE');
  assert.deepEqual(configure?.projection.includes, ['competitiveSave', 'preopenDaySnapshot']);
  assert.ok(open?.projection.includes.includes('preopenDaySnapshot'));
});

test('every command declares identity, economy, risk, and E02/E04 state non-authoritative', () => {
  for (const command of gameplayCommandCatalog) {
    for (const field of forbiddenAuthorityFields) {
      assert.ok(
        command.clientForbiddenAuthorityFields.includes(field),
        `${command.commandType} must forbid ${field}`,
      );
    }
    assert.deepEqual(command.clientNonAuthoritativeInputs, ['saveId', 'expectedVersion']);
    assert.ok(!command.clientForbiddenAuthorityFields.includes('saveId'));
    assert.ok(!command.clientForbiddenAuthorityFields.includes('expectedVersion'));
  }
});
