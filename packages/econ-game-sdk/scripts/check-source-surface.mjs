#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..');

const expectedNodeRoutes = new Set([
  'GET /health',
  'GET /restaurants',
  'POST /bootstrap',
  'GET /menus',
  'POST /orders',
  'POST /orders/:id/items',
  'POST /orders/:id/payments',
  'GET /orders/:id',
  'GET /kds/tickets',
  'POST /kds/tickets/:id/start',
  'POST /kds/tickets/:id/serve',
]);

const expectedPythonPreviewRoutes = new Set([
  'GET /health',
  'POST /players',
  'GET /players/{player_id}',
]);

const nodeSource = readFileSync(resolve(repoRoot, 'services/api/src/index.ts'), 'utf8');
const pythonSource = readFileSync(resolve(repoRoot, 'python/services/api/src/econ_api/routes.py'), 'utf8');

const actualNodeRoutes = new Set(
  [...nodeSource.matchAll(/app\.(get|post)\s*(?:<[\s\S]*?>\s*)?\(\s*['\"]([^'\"]+)['\"]/g)].map(
    ([, method, path]) => `${method.toUpperCase()} ${path}`
  )
);
const actualPythonPreviewRoutes = new Set(
  [...pythonSource.matchAll(/@router\.(get|post)\(\s*['\"]([^'\"]+)['\"]/g)].map(
    ([, method, path]) => `${method.toUpperCase()} ${path}`
  )
);

assertSameRoutes('Node/Fastify', expectedNodeRoutes, actualNodeRoutes);
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
