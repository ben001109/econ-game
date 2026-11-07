import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';

import type { TrustedPlayerIdentity } from '../auth/trusted-command-context.js';
import { CommandError } from '../commands/command-contract.js';
import { MVP_OPENING_VERSIONS } from '../domains/opening-scenario/registry.js';
import type { PreopenConfigurationChoicesAuthority } from './preopen-configuration-choices.js';
import {
  PREOPEN_CONFIGURATION_CHOICES_ROUTE,
  registerPreopenConfigurationChoicesRoutes,
} from './preopen-configuration-choices-routes.js';
import type {
  PreopenConfigurationChoicesRepository,
  PreopenConfigurationChoicesScope,
  ScopedPreopenConfigurationChoicesAuthority,
} from './prisma-preopen-configuration-choices-repository.js';

const scope: PreopenConfigurationChoicesScope = Object.freeze({
  playerId: 'player-1',
  membershipId: 'membership-1',
  tenantId: 'restaurant-1',
  saveId: 'save-1',
  role: 'OWNER',
});

function authority(scenario: 'DEFAULT_SMALL_SHOP' | 'EMPTY_PREMISES' = 'DEFAULT_SMALL_SHOP') {
  return Object.freeze<PreopenConfigurationChoicesAuthority>({
    save: Object.freeze({
      id: 'save-1',
      expectedVersion: 1,
      phase: 'CONFIGURE_REQUIRED',
      scenario,
      operatingMode: 'STRATEGY',
      servicePeriodPlan: 'TWO_PERIODS',
      simulationRuleVersion: MVP_OPENING_VERSIONS.simulationRuleVersion,
      settlementCurrency: 'TWD',
    }),
  });
}

class FakeRepository implements PreopenConfigurationChoicesRepository {
  scopeResult: PreopenConfigurationChoicesScope | undefined = scope;
  authorityResult: ScopedPreopenConfigurationChoicesAuthority | undefined = Object.freeze({
    scope,
    authority: authority(),
  });
  calls: string[] = [];

  async resolveScope(playerId: string, saveId: string) {
    this.calls.push(`scope:${playerId}:${saveId}`);
    return this.scopeResult;
  }

  async loadAuthority(resolved: PreopenConfigurationChoicesScope) {
    this.calls.push(`authority:${resolved.saveId}`);
    return this.authorityResult;
  }
}

type RouteHandler = (request: any, reply: any) => Promise<unknown>;

function register(
  repository: FakeRepository | undefined,
  identity: TrustedPlayerIdentity,
  events: string[],
  eligible: (playerId: string, tenantId: string) => Promise<void> = async () => {
    events.push('eligible');
  },
) {
  let path = '';
  let handler: RouteHandler | undefined;
  const app = {
    get(route: string, callback: RouteHandler) {
      path = route;
      handler = callback;
    },
  } as unknown as FastifyInstance;
  registerPreopenConfigurationChoicesRoutes(app, {
    resolveIdentity: async () => identity,
    repository,
    assertScopeAllowed: eligible,
  });
  assert.equal(path, PREOPEN_CONFIGURATION_CHOICES_ROUTE);
  return async (saveId = 'save-1') => {
    let statusCode = 0;
    let body: unknown;
    const reply = {
      status(code: number) {
        statusCode = code;
        return {
          send(value: unknown) {
            body = value;
            return value;
          },
        };
      },
    };
    await handler!({ params: { saveId } }, reply);
    return { statusCode, body };
  };
}

function webIdentity(
  events: string[],
  audit: (input: Readonly<Record<string, unknown>>) => Promise<void> = async () => {
    events.push('audit');
  },
): TrustedPlayerIdentity {
  return Object.freeze({
    playerId: 'player-1',
    principal: Object.freeze({ type: 'web' as const }),
    recordScopeResolution: audit,
  });
}

function botIdentity(events: string[]): TrustedPlayerIdentity {
  return Object.freeze({
    playerId: 'player-1',
    principal: Object.freeze({ type: 'discord_bot' as const, interactionId: 'interaction-1' }),
    async recordScopeResolution() {
      events.push('bot-audit');
    },
  });
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}

test('Web OWNER read is ordered scope then D05 then audit then authority and returns redacted choices', async () => {
  const events: string[] = [];
  const repository = new FakeRepository();
  const originalScope = repository.resolveScope.bind(repository);
  const originalAuthority = repository.loadAuthority.bind(repository);
  repository.resolveScope = async (...args) => {
    events.push('scope');
    return originalScope(...args);
  };
  repository.loadAuthority = async (...args) => {
    events.push('authority');
    return originalAuthority(...args);
  };
  const invoke = register(repository, webIdentity(events), events);
  const response = await invoke();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(events, ['scope', 'eligible', 'audit', 'authority']);
  const serialized = JSON.stringify(response.body).toLowerCase();
  for (const forbidden of [
    'playerid',
    'membershipid',
    'tenantid',
    'restaurantid',
    'seed',
    'preopensnapshothash',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal((response.body as { save: { expectedVersion: number } }).save.expectedVersion, 1);
});

test('Bot is explicitly forbidden before scope resolution or audit', async () => {
  const events: string[] = [];
  const repository = new FakeRepository();
  const invoke = register(repository, botIdentity(events), events);
  const response = await invoke();
  assert.equal(response.statusCode, 403);
  assert.equal(errorCode(response.body), 'PREOPEN_CONFIGURATION_CHOICES_WEB_ONLY');
  assert.deepEqual(repository.calls, []);
  assert.deepEqual(events, []);
});

test('scope misses and D05 revocation are non-leaky 404 responses', async () => {
  const events: string[] = [];
  const missing = new FakeRepository();
  missing.scopeResult = undefined;
  let response = await register(missing, webIdentity(events), events)();
  assert.equal(response.statusCode, 404);
  assert.equal(errorCode(response.body), 'GAMEPLAY_RESOURCE_NOT_FOUND');

  const revoked = new FakeRepository();
  response = await register(revoked, webIdentity(events), events, async () => {
    throw new CommandError(403, 'CLOSED_BETA_NOT_ELIGIBLE');
  })();
  assert.equal(response.statusCode, 404);
  assert.equal(errorCode(response.body), 'GAMEPLAY_RESOURCE_NOT_FOUND');
  assert.deepEqual(revoked.calls, ['scope:player-1:save-1']);
});

test('audit failure and unavailable dependencies fail closed with 503 before authority read', async () => {
  const events: string[] = [];
  const repository = new FakeRepository();
  let response = await register(
    repository,
    webIdentity(events, async () => {
      throw new Error('audit offline');
    }),
    events,
  )();
  assert.equal(response.statusCode, 503);
  assert.equal(errorCode(response.body), 'PREOPEN_CONFIGURATION_CHOICES_UNAVAILABLE');
  assert.deepEqual(repository.calls, ['scope:player-1:save-1']);

  response = await register(undefined, webIdentity(events), events)();
  assert.equal(response.statusCode, 503);
});

test('phase and EMPTY equipment conflicts are exposed only after scoped audit', async () => {
  const events: string[] = [];
  const phase = new FakeRepository();
  phase.loadAuthority = async () => {
    throw new CommandError(409, 'PREOPEN_CONFIGURATION_PHASE_UNAVAILABLE');
  };
  let response = await register(phase, webIdentity(events), events)();
  assert.equal(response.statusCode, 409);
  assert.equal(errorCode(response.body), 'PREOPEN_CONFIGURATION_PHASE_UNAVAILABLE');
  assert.deepEqual(events, ['eligible', 'audit']);

  events.length = 0;
  const empty = new FakeRepository();
  empty.authorityResult = Object.freeze({ scope, authority: authority('EMPTY_PREMISES') });
  response = await register(empty, webIdentity(events), events)();
  assert.equal(response.statusCode, 409);
  assert.equal(errorCode(response.body), 'PREOPEN_EQUIPMENT_INSTALLATION_REQUIRED');
  assert.deepEqual(events, ['eligible', 'audit']);
});

test('invalid save ids and post-audit membership disappearance remain non-leaky', async () => {
  const events: string[] = [];
  const repository = new FakeRepository();
  let response = await register(repository, webIdentity(events), events)('../other');
  assert.equal(response.statusCode, 404);
  assert.deepEqual(repository.calls, []);

  repository.authorityResult = undefined;
  response = await register(repository, webIdentity(events), events)();
  assert.equal(response.statusCode, 404);
});

test('default API composition wires the durable repository without a test-only gate', async () => {
  const source = await readFile(new URL('../app-composition.ts', import.meta.url), 'utf8');
  assert.match(source, /registerPreopenConfigurationChoicesRoutes\(app,/);
  assert.match(
    source,
    /new PrismaPreopenConfigurationChoicesRepository\(options\.durableCommandDatabase\)/,
  );
  assert.match(source, /options\.testOnlyPreopenConfigurationChoicesRepository \?\?/);
});
