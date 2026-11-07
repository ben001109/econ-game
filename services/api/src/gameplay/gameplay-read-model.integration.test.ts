import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiComposition } from '../app-composition.js';
import { RoleMatrixAuthorizationPolicy } from '../auth/authorization.js';
import type { JwtVerifier } from '../auth/jwt-verifier.js';
import { ClosedBetaService, type ClosedBetaRepository } from '../closed-beta/closed-beta.js';
import { CommandError } from '../commands/command-contract.js';
import type {
  ActiveGameScope,
  IdentityScopeRepository,
  ResolvedBotActorAudit,
} from '../auth/trusted-command-context.js';
import {
  GAMEPLAY_CURRENT_PROJECTION_VERSION,
  GAMEPLAY_REPLAY_JOB_PROJECTION_VERSION,
  type ActiveSaveDiscovery,
  type GameplayReadModelRepository,
  type SafeGameplayProjection,
  type SafeReplayJobProjection,
  type ScopedGameplayProjection,
} from './gameplay-read-model.js';

const replayJobId = '20000000-0000-4000-8000-000000000001';
const hash = 'a'.repeat(64);

const safeProjection: SafeGameplayProjection = Object.freeze({
  schemaVersion: GAMEPLAY_CURRENT_PROJECTION_VERSION,
  save: Object.freeze({
    id: 'save-1',
    aggregateVersion: 4,
    openingScenario: 'DEFAULT_SHOP',
    operatingMode: 'STRATEGY',
    servicePeriodPlan: 'TWO_PERIODS',
    difficultyGroup: 'STANDARD',
    simulationRuleVersion: 'mvp-e01-v1',
  }),
  phase: 'ADVANCE_REQUIRED',
  nextCommand: 'ADVANCE_SERVICE_PERIOD',
  expectedVersion: 4,
  businessDay: Object.freeze({
    businessDay: 1,
    status: 'OPEN',
    simulationRuleVersion: 'mvp-e01-v1',
    completedServicePeriods: 1,
    totalServicePeriods: 2,
    nextPeriodKey: 'DINNER',
  }),
  dayEnd: null,
});

const scope = Object.freeze({
  membershipId: 'membership-1',
  tenantId: 'restaurant-1',
  saveId: 'save-1',
  role: 'OWNER' as const,
});

class FakeIdentityRepository implements IdentityScopeRepository {
  player = { id: 'player-1', clerkUserId: 'clerk-1' };
  discordLinked = true;

  async findPlayerByClerkSubject() {
    return this.player;
  }

  async findPlayerByDiscordId() {
    return this.discordLinked ? this.player : undefined;
  }

  async findActiveGameScope(): Promise<ActiveGameScope | undefined> {
    return undefined;
  }
}

class FakeGameplayReadRepository implements GameplayReadModelRepository {
  current: ScopedGameplayProjection | undefined = Object.freeze({ scope, projection: safeProjection });
  discovery: ActiveSaveDiscovery = Object.freeze({ bootstrapVersion: 1, active: this.current });
  replay: SafeReplayJobProjection | undefined = Object.freeze({
    scope,
    httpStatus: 202,
    projection: Object.freeze({
      schemaVersion: GAMEPLAY_REPLAY_JOB_PROJECTION_VERSION,
      jobId: replayJobId,
      saveId: 'save-1',
      businessDay: 1,
      status: 'QUEUED',
      terminal: false,
    }),
  });
  latestReplay: SafeReplayJobProjection | undefined = this.replay;
  latestReplayError: CommandError | undefined;
  latestReplayReads = 0;

  async discoverActiveSave() {
    return this.discovery;
  }

  async loadCurrentProjection(_playerId: string, saveId: string) {
    return saveId === 'save-1' ? this.current : undefined;
  }

  async loadReplayJob(_playerId: string, saveId: string, jobId: string) {
    return saveId === 'save-1' && jobId === replayJobId ? this.replay : undefined;
  }

  async loadLatestReplayJob(_playerId: string, saveId: string, businessDay: 1) {
    this.latestReplayReads += 1;
    if (this.latestReplayError) throw this.latestReplayError;
    return saveId === 'save-1' && businessDay === 1 ? this.latestReplay : undefined;
  }
}

function createApp(
  repository: FakeGameplayReadRepository,
  audits: ResolvedBotActorAudit[] = [],
  options: Readonly<{ eligible?: boolean; omitBotAuditSink?: boolean }> = {},
) {
  const jwtVerifier: JwtVerifier = {
    async verify() {
      return {
        subject: 'clerk-1',
        issuer: 'test',
        audience: ['api'],
        authorizedParty: 'web',
        expiresAt: 2_000_000_000,
      };
    },
  };
  const closedBetaService =
    options.eligible === undefined
      ? undefined
      : new ClosedBetaService({
          jwtVerifier,
          repository: {
            durability: 'test',
            async isEntranceEligible() {
              return options.eligible!;
            },
          } as unknown as ClosedBetaRepository,
        });
  return createApiComposition({
    identitySecurity: {
      jwtVerifier,
      repository: new FakeIdentityRepository(),
      authorization: new RoleMatrixAuthorizationPolicy({}),
      botServiceCredentialVerifier: {
        async verify(value) {
          return value === 'bot-key' ? { id: 'bot-service', scopes: ['game:command'] } : undefined;
        },
      },
      ...(options.omitBotAuditSink
        ? {}
        : {
            botActorAuditSink: {
              async recordResolvedActor(input: ResolvedBotActorAudit) {
                audits.push(input);
              },
            },
          }),
    },
    testOnlyGameplayReadModelRepository: repository,
    ...(closedBetaService
      ? { testOnlyClosedBetaService: closedBetaService }
      : { testOnlyBypassClosedBetaEligibility: true as const }),
  });
}

const botHeaders = Object.freeze({
  authorization: 'Bot bot-key',
  'x-discord-user-id': 'discord-1',
  'x-discord-interaction-id': 'interaction-1',
  'x-correlation-id': 'correlation-1',
});

function code(response: Readonly<{ json(): unknown }>): string | undefined {
  return (response.json() as { error?: { code?: string } }).error?.code;
}

test('active discovery is authenticated and only exposes safe server-derived phase/version state', async () => {
  const app = createApp(new FakeGameplayReadRepository());
  const unauthorized = await app.inject({ method: 'GET', url: '/gameplay/active-save' });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(code(unauthorized), 'UNTRUSTED_COMMAND_CONTEXT');

  const response = await app.inject({
    method: 'GET',
    url: '/gameplay/active-save',
    headers: { authorization: 'Bearer web-token' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as Record<string, unknown>;
  assert.equal(body.state, 'ACTIVE_SAVE');
  const serialized = JSON.stringify(body);
  for (const privateField of [
    'demandSeed',
    'marketSeed',
    'arrivalTick',
    'patience',
    'inventory',
    'costPool',
    'auditLog',
    'replayPayload',
  ]) {
    assert.equal(serialized.includes(privateField), false);
  }
  await app.close();
});

test('authorized OPEN_REQUIRED read exposes only the pre-open id/hash recovery pin', async () => {
  const repository = new FakeGameplayReadRepository();
  const projection: SafeGameplayProjection = Object.freeze({
    ...safeProjection,
    phase: 'OPEN_REQUIRED',
    nextCommand: 'OPEN_BUSINESS_DAY',
    preopenSnapshot: Object.freeze({ id: 'preopen-1', hash }),
    businessDay: Object.freeze({
      businessDay: 1,
      status: 'PREOPEN',
      simulationRuleVersion: 'mvp-e01-v1',
      completedServicePeriods: 0,
      totalServicePeriods: 2,
      nextPeriodKey: null,
    }),
  });
  repository.current = Object.freeze({ scope, projection });
  repository.discovery = Object.freeze({ bootstrapVersion: 1, active: repository.current });
  const app = createApp(repository);

  const response = await app.inject({
    method: 'GET',
    url: '/gameplay/active-save',
    headers: { authorization: 'Bearer web-token' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as Readonly<{
    activeSave: Readonly<{ preopenSnapshot: unknown }>;
  }>;
  assert.deepEqual(body.activeSave.preopenSnapshot, { id: 'preopen-1', hash });
  const serialized = JSON.stringify(body);
  for (const privateField of [
    'payload',
    'demandSeed',
    'marketSeed',
    'inventory',
    'costPool',
    'accountingEvidence',
  ]) {
    assert.equal(serialized.includes(privateField), false, privateField);
  }
  await app.close();
});

test('no active Web save returns bootstrap eligibility state while Bot cannot bootstrap', async () => {
  const repository = new FakeGameplayReadRepository();
  repository.discovery = Object.freeze({ bootstrapVersion: 3, active: undefined });
  const app = createApp(repository);
  const web = await app.inject({
    method: 'GET',
    url: '/gameplay/active-save',
    headers: { authorization: 'Bearer web-token' },
  });
  assert.equal(web.statusCode, 200);
  assert.deepEqual(web.json(), {
    schemaVersion: 'gameplay.active-save-discovery/v1',
    state: 'INITIALIZE_REQUIRED',
    bootstrap: {
      route: '/bootstrap/actions/INITIALIZE_COMPETITIVE_SAVE',
      aggregateId: 'bootstrap-player:player-1',
      expectedVersion: 3,
    },
    activeSave: null,
  });
  const bot = await app.inject({
    method: 'GET',
    url: '/gameplay/active-save',
    headers: {
      authorization: 'Bot bot-key',
      'x-discord-user-id': 'discord-1',
      'x-discord-interaction-id': 'interaction-1',
      'x-correlation-id': 'correlation-1',
    },
  });
  assert.equal(bot.statusCode, 403);
  assert.equal(code(bot), 'GAMEPLAY_SCOPE_FORBIDDEN');
  await app.close();
});

test('explicit projection is leak-safe for cross-save/revoked scope and Bot records resolved scope', async () => {
  const repository = new FakeGameplayReadRepository();
  const audits: ResolvedBotActorAudit[] = [];
  const app = createApp(repository, audits);
  const missing = await app.inject({
    method: 'GET',
    url: '/saves/save-other/gameplay',
    headers: { authorization: 'Bearer web-token' },
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(code(missing), 'GAMEPLAY_RESOURCE_NOT_FOUND');

  const bot = await app.inject({
    method: 'GET',
    url: '/saves/save-1/gameplay',
    headers: botHeaders,
  });
  assert.equal(bot.statusCode, 200);
  assert.equal((bot.json() as { expectedVersion: number }).expectedVersion, 4);
  assert.equal(audits[0]?.commandType, 'READ_GAMEPLAY_PROJECTION');
  assert.equal(audits[0]?.tenantId, 'restaurant-1');

  repository.current = undefined;
  const revoked = await app.inject({
    method: 'GET',
    url: '/saves/save-1/gameplay',
    headers: { authorization: 'Bearer web-token' },
  });
  assert.equal(revoked.statusCode, 404);
  await app.close();
});

test('D05 ineligible or revoked entrance denies active, current, and replay projections', async () => {
  const app = createApp(new FakeGameplayReadRepository(), [], { eligible: false });
  for (const url of [
    '/gameplay/active-save',
    '/saves/save-1/gameplay',
    '/saves/save-1/replay-jobs/latest?businessDay=1',
    `/saves/save-1/replay-jobs/${replayJobId}`,
  ]) {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer web-token' },
    });
    assert.equal(response.statusCode, 403, url);
    assert.equal(code(response), 'CLOSED_BETA_NOT_ELIGIBLE', url);
  }
  await app.close();
});

test('Bot active/replay reads audit exact server scope and fail closed without audit sink', async () => {
  const audits: ResolvedBotActorAudit[] = [];
  const app = createApp(new FakeGameplayReadRepository(), audits);
  const active = await app.inject({ method: 'GET', url: '/gameplay/active-save', headers: botHeaders });
  const replay = await app.inject({
    method: 'GET',
    url: `/saves/save-1/replay-jobs/${replayJobId}`,
    headers: botHeaders,
  });
  const latestReplay = await app.inject({
    method: 'GET',
    url: '/saves/save-1/replay-jobs/latest?businessDay=1',
    headers: botHeaders,
  });
  assert.equal(active.statusCode, 200);
  assert.equal(replay.statusCode, 202);
  assert.equal(latestReplay.statusCode, 202);
  assert.deepEqual(
    audits.map((entry) => [entry.commandType, entry.tenantId, entry.saveId]),
    [
      ['READ_ACTIVE_GAMEPLAY_SAVE', 'restaurant-1', 'save-1'],
      ['READ_DAY_REPLAY_JOB', 'restaurant-1', 'save-1'],
      ['READ_LATEST_DAY_REPLAY_JOB', 'restaurant-1', 'save-1'],
    ],
  );
  await app.close();

  const failClosed = createApp(new FakeGameplayReadRepository(), [], {
    omitBotAuditSink: true,
  });
  for (const url of [
    '/gameplay/active-save',
    '/saves/save-1/replay-jobs/latest?businessDay=1',
    `/saves/save-1/replay-jobs/${replayJobId}`,
  ]) {
    const response = await failClosed.inject({ method: 'GET', url, headers: botHeaders });
    assert.equal(response.statusCode, 503, url);
    assert.equal(code(response), 'BOT_AUDIT_REQUIRED', url);
  }
  await failClosed.close();
});

test('replay polling returns 202, exact MATCH summary, generic permanent failure, and leak-safe unknown job', async () => {
  const repository = new FakeGameplayReadRepository();
  const app = createApp(repository);
  const request = (jobId = replayJobId) => ({
    method: 'GET' as const,
    url: `/saves/save-1/replay-jobs/${jobId}`,
    headers: { authorization: 'Bearer web-token' },
  });
  const queued = await app.inject(request());
  assert.equal(queued.statusCode, 202);
  assert.equal((queued.json() as { status: string }).status, 'QUEUED');

  repository.replay = Object.freeze({
    scope,
    httpStatus: 200,
    projection: Object.freeze({
      schemaVersion: GAMEPLAY_REPLAY_JOB_PROJECTION_VERSION,
      jobId: replayJobId,
      saveId: 'save-1',
      businessDay: 1,
      status: 'MATCH',
      terminal: true,
      verification: Object.freeze({
        eventCount: 3,
        eventHash: Object.freeze({ expected: hash, computed: hash, match: true }),
        snapshotHash: Object.freeze({ expected: hash, computed: hash, match: true }),
      }),
    }),
  });
  const matched = await app.inject(request());
  assert.equal(matched.statusCode, 200);
  assert.equal((matched.json() as { status: string }).status, 'MATCH');

  repository.replay = Object.freeze({
    scope,
    httpStatus: 200,
    projection: Object.freeze({
      schemaVersion: GAMEPLAY_REPLAY_JOB_PROJECTION_VERSION,
      jobId: replayJobId,
      saveId: 'save-1',
      businessDay: 1,
      status: 'PERMANENT_FAILURE',
      terminal: true,
      failure: Object.freeze({ retryable: false, category: 'PERMANENT' }),
    }),
  });
  const failed = await app.inject(request());
  assert.deepEqual((failed.json() as { failure: unknown }).failure, {
    retryable: false,
    category: 'PERMANENT',
  });
  assert.equal(JSON.stringify(failed.json()).includes('errorDetails'), false);

  const unknown = await app.inject(request('30000000-0000-4000-8000-000000000003'));
  assert.equal(unknown.statusCode, 404);
  await app.close();
});

test('latest replay recovery is read-only, strict, leak-safe, and preserves the polling union', async () => {
  const repository = new FakeGameplayReadRepository();
  const app = createApp(repository);
  const request = (url = '/saves/save-1/replay-jobs/latest?businessDay=1') =>
    app.inject({ method: 'GET', url, headers: { authorization: 'Bearer web-token' } });

  const pending = await request();
  assert.equal(pending.statusCode, 202);
  assert.equal((pending.json() as { status: string }).status, 'QUEUED');
  assert.equal(repository.latestReplayReads, 1);

  repository.latestReplay = Object.freeze({
    scope,
    httpStatus: 200,
    projection: Object.freeze({
      schemaVersion: GAMEPLAY_REPLAY_JOB_PROJECTION_VERSION,
      jobId: replayJobId,
      saveId: 'save-1',
      businessDay: 1,
      status: 'MATCH',
      terminal: true,
      verification: Object.freeze({
        eventCount: 3,
        eventHash: Object.freeze({ expected: hash, computed: hash, match: true }),
        snapshotHash: Object.freeze({ expected: hash, computed: hash, match: true }),
      }),
    }),
  });
  const terminal = await request();
  assert.equal(terminal.statusCode, 200);
  assert.equal((terminal.json() as { status: string }).status, 'MATCH');
  const serialized = JSON.stringify(terminal.json());
  for (const privateField of ['inputPayload', 'sourcePayload', 'errorDetails', 'replayPayload']) {
    assert.equal(serialized.includes(privateField), false, privateField);
  }

  repository.latestReplay = undefined;
  assert.equal((await request()).statusCode, 404);
  assert.equal((await request('/saves/save-other/replay-jobs/latest?businessDay=1')).statusCode, 404);
  for (const url of [
    '/saves/save-1/replay-jobs/latest',
    '/saves/save-1/replay-jobs/latest?businessDay=2',
    '/saves/save-1/replay-jobs/latest?businessDay=1&extra=true',
    '/saves/%20/replay-jobs/latest?businessDay=1',
  ]) {
    assert.equal((await request(url)).statusCode, 404, url);
  }

  repository.latestReplayError = new CommandError(409, 'DAY_REPLAY_JOB_SELECTION_REQUIRED');
  const ambiguous = await request();
  assert.equal(ambiguous.statusCode, 409);
  assert.equal(code(ambiguous), 'DAY_REPLAY_JOB_SELECTION_REQUIRED');
  await app.close();
});
