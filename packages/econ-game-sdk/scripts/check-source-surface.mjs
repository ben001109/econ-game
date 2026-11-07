#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..');

const expectedD02SdkRoutes = new Set([
  'POST /saves/:saveId/actions/:commandType',
]);

const expectedGameplayRoutes = new Set([
  'POST /bootstrap/actions/INITIALIZE_COMPETITIVE_SAVE',
  'GET /gameplay/active-save',
  'GET /saves/:saveId/gameplay',
  'GET /saves/:saveId/preopen/configuration-choices',
  'GET /saves/:saveId/replay-jobs/latest',
  'GET /saves/:saveId/replay-jobs/:jobId',
]);

const expectedPythonPreviewRoutes = new Set([
  'GET /health',
  'POST /players',
  'GET /players/{player_id}',
]);

const nodeSource = readFileSync(
  resolve(repoRoot, 'services/api/src/commands/command-routes.ts'),
  'utf8',
);
const bootstrapSource = readFileSync(
  resolve(repoRoot, 'services/api/src/gameplay/initialize-competitive-save-routes.ts'),
  'utf8',
);
const gameplayReadSource = readFileSync(
  resolve(repoRoot, 'services/api/src/gameplay/gameplay-read-model.ts'),
  'utf8',
);
const preopenChoicesSource = readFileSync(
  resolve(repoRoot, 'services/api/src/gameplay/preopen-configuration-choices-routes.ts'),
  'utf8',
);
const pythonSource = readFileSync(
  resolve(repoRoot, 'python/services/api/src/econ_api/routes.py'),
  'utf8',
);

const actualNodeRoutes = new Set(
  [...nodeSource.matchAll(/app\.(get|post)\s*(?:<[\s\S]*?>\s*)?\(\s*['\"]([^'\"]+)['\"]/g)].map(
    ([, method, path]) => `${method.toUpperCase()} ${path}`,
  ),
);
const actualPythonPreviewRoutes = new Set(
  [...pythonSource.matchAll(/@router\.(get|post)\(\s*['\"]([^'\"]+)['\"]/g)].map(
    ([, method, path]) => `${method.toUpperCase()} ${path}`,
  ),
);

assertSameRoutes('D02 SDK command', expectedD02SdkRoutes, actualNodeRoutes);
assertGameplayRouteConstants(expectedGameplayRoutes, bootstrapSource, gameplayReadSource, preopenChoicesSource);
assertSameRoutes('Python preview', expectedPythonPreviewRoutes, actualPythonPreviewRoutes);

console.log('SDK source-surface check passed.');

function assertSameRoutes(label, expected, actual) {
  const missing = [...expected].filter((route) => !actual.has(route));
  const unexpected = [...actual].filter((route) => !expected.has(route));
  if (missing.length === 0 && unexpected.length === 0) return;

  const parts = [`${label} route surface changed.`];
  if (missing.length) parts.push(`Missing from source: ${missing.join(', ')}`);
  if (unexpected.length) parts.push(`Not represented in SDK: ${unexpected.join(', ')}`);
  parts.push('Review types, tests, README, and compatibility notes before accepting the change.');
  throw new Error(parts.join('\n'));
}

function assertGameplayRouteConstants(expected, bootstrap, readModel, preopenChoices) {
  const actual = new Set([
    ...[...bootstrap.matchAll(/export const \w+_ROUTE\s*=\s*['\"]([^'\"]+)['\"]/g)].map(
      ([, path]) => `POST ${path}`,
    ),
    ...[...readModel.matchAll(/export const \w+_ROUTE\s*=\s*['\"]([^'\"]+)['\"]/g)].map(
      ([, path]) => `GET ${path}`,
    ),
    ...[...preopenChoices.matchAll(/export const \w+_ROUTE\s*=\s*['\"]([^'\"]+)['\"]/g)].map(
      ([, path]) => `GET ${path}`,
    ),
  ]);
  assertSameRoutes('P0 gameplay SDK', expected, actual);
}
