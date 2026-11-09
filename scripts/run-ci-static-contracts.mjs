#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

export const STATIC_CONTRACTS = Object.freeze([
  'services/api/tests/schema/d01-persistence.test.mjs',
  'services/api/tests/schema/p0-business-day-persistence-migration.test.mjs',
  'services/api/tests/schema/p0-e03-inventory-market-authority-migration.test.mjs',
  'services/api/tests/security/b2-outbox-dead-letter-migration.test.mjs',
  'services/api/tests/security/d04-rls-claims.test.mjs',
  'services/api/tests/security/d05-privacy-regressions.test.mjs',
  'services/api/tests/security/d05-wipe-batch-migration.test.mjs',
  'services/api/tests/security/d05-wipe-execution-static.test.mjs',
  'services/api/tests/security/d05-wipe-workflow-static.test.mjs',
  'services/api/tests/simulation/d03-s02-migration.test.mjs',
  'services/api/tests/simulation/e05-day-replay-worker-migration.test.mjs',
]);

const result = spawnSync(process.execPath, ['--test', ...STATIC_CONTRACTS], {
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
