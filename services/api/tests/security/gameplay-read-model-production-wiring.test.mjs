import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const production = readFileSync(
  new URL('../../src/production-api-composition.ts', import.meta.url),
  'utf8',
);
const appComposition = readFileSync(
  new URL('../../src/app-composition.ts', import.meta.url),
  'utf8',
);
const integration = readFileSync(
  new URL('../../src/security/production-api-composition.integration.test.ts', import.meta.url),
  'utf8',
);

test('complete production identity composition wires durable bootstrap and read model together', () => {
  assert.match(
    production,
    /new PrismaDurableBootstrapInitializer\(options\.database, createMvpServerBootstrapPlan\)/,
  );
  assert.match(production, /bootstrapInitializer,/);
  assert.match(production, /bootstrapWebIdentityResolver: createBootstrapWebIdentityResolver/);
  assert.match(appComposition, /new PrismaGameplayReadModelRepository\(options\.durableCommandDatabase\)/);
  assert.match(appComposition, /registerGameplayReadModelRoutes\(app,/);
});

test('production integration contract covers no-save discovery followed by bootstrap POST', () => {
  assert.match(integration, /complete production composition jointly exposes no-save discovery and durable bootstrap POST/);
  assert.match(integration, /url: '\/gameplay\/active-save'/);
  assert.match(integration, /url: '\/bootstrap\/actions\/INITIALIZE_COMPETITIVE_SAVE'/);
  assert.match(integration, /state: 'INITIALIZE_REQUIRED'/);
  assert.match(integration, /aggregateVersion: 1/);
});
