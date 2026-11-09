import assert from 'node:assert/strict';
import test from 'node:test';

import {
  membershipRoles,
  mergeCommandRoleMatrices,
  RoleMatrixAuthorizationPolicy,
} from '../auth/authorization.js';
import { gameplayCommandCatalog } from './gameplay-command-catalog.js';
import {
  gameplaySaveScopedCommandAuthorizationPolicy,
  gameplaySaveScopedCommandRoleMatrix,
} from './gameplay-command-authorization-policy.js';

test('save-scoped gameplay authorization is derived exactly from the catalog and excludes bootstrap', () => {
  const saveScopedCatalog = gameplayCommandCatalog.filter(
    (entry) => entry.commandType !== 'INITIALIZE_COMPETITIVE_SAVE',
  );
  assert.deepEqual(
    Object.keys(gameplaySaveScopedCommandRoleMatrix),
    saveScopedCatalog.map((entry) => entry.commandType),
  );
  assert.equal(
    Object.hasOwn(gameplaySaveScopedCommandRoleMatrix, 'INITIALIZE_COMPETITIVE_SAVE'),
    false,
  );

  for (const entry of saveScopedCatalog) {
    for (const role of membershipRoles) {
      assert.equal(
        gameplaySaveScopedCommandAuthorizationPolicy.isAllowed(entry.commandType, role),
        entry.allowedRoles.includes(role),
        `${entry.commandType} ${role}`,
      );
    }
  }
  assert.equal(
    gameplaySaveScopedCommandAuthorizationPolicy.isAllowed('INITIALIZE_COMPETITIVE_SAVE', 'OWNER'),
    false,
  );
  assert.equal(
    gameplaySaveScopedCommandAuthorizationPolicy.isAllowed('UNKNOWN_GAMEPLAY_COMMAND', 'OWNER'),
    false,
  );
});

test('gameplay policy composes with ledger policy without replacing either surface', () => {
  const policy = new RoleMatrixAuthorizationPolicy(
    mergeCommandRoleMatrices(
      { POST_LEDGER_TRANSACTION: ['OWNER', 'MANAGER'] },
      gameplaySaveScopedCommandRoleMatrix,
    ),
  );

  assert.equal(policy.isAllowed('POST_LEDGER_TRANSACTION', 'OWNER'), true);
  assert.equal(policy.isAllowed('POST_LEDGER_TRANSACTION', 'VIEWER'), false);
  assert.equal(policy.isAllowed('CONFIGURE_PREOPEN_DAY', 'OWNER'), true);
  assert.equal(policy.isAllowed('CONFIGURE_PREOPEN_DAY', 'MANAGER'), true);
  assert.equal(policy.isAllowed('CONFIGURE_PREOPEN_DAY', 'CASHIER'), false);
  assert.equal(policy.isAllowed('INITIALIZE_COMPETITIVE_SAVE', 'OWNER'), false);
});

test('composed policies reject overlapping command ownership', () => {
  assert.throws(
    () =>
      mergeCommandRoleMatrices(
        { OPEN_BUSINESS_DAY: ['OWNER'] },
        gameplaySaveScopedCommandRoleMatrix,
      ),
    /duplicate command authorization policy: OPEN_BUSINESS_DAY/,
  );
});
