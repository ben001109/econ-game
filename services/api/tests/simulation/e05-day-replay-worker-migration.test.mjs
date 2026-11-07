import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const migrationRoot = `${repositoryRoot}/services/api/prisma/migrations/20260818000400_e05_day_replay_worker`;
const migration = readFileSync(`${migrationRoot}/migration.sql`, 'utf8');
const rollback = readFileSync(`${migrationRoot}/rollback.sql`, 'utf8');
const worker = readFileSync(`${repositoryRoot}/services/worker/src/simulation-platform.ts`, 'utf8');
const source = readFileSync(`${repositoryRoot}/services/worker/src/day-replay-evidence.ts`, 'utf8');
const apiHandler = readFileSync(
  `${repositoryRoot}/services/api/src/gameplay/request-day-replay-command.ts`,
  'utf8',
);
const apiReleaseEvidence = readFileSync(
  `${repositoryRoot}/services/api/src/domains/release-evidence/release-evidence.ts`,
  'utf8',
);
const sharedPackage = JSON.parse(
  readFileSync(`${repositoryRoot}/packages/econ-game-release-evidence/package.json`, 'utf8'),
);
const sharedImplementation = readFileSync(
  `${repositoryRoot}/packages/econ-game-release-evidence/index.js`,
  'utf8',
);
const apiPackage = JSON.parse(readFileSync(`${repositoryRoot}/services/api/package.json`, 'utf8'));
const workerPackage = JSON.parse(
  readFileSync(`${repositoryRoot}/services/worker/package.json`, 'utf8'),
);
const apiNpmLock = readFileSync(`${repositoryRoot}/services/api/package-lock.json`, 'utf8');
const workerNpmLock = readFileSync(`${repositoryRoot}/services/worker/package-lock.json`, 'utf8');
const apiBunLock = readFileSync(`${repositoryRoot}/services/api/bun.lock`, 'utf8');
const workerBunLock = readFileSync(`${repositoryRoot}/services/worker/bun.lock`, 'utf8');
const apiDockerfile = readFileSync(`${repositoryRoot}/services/api/Dockerfile`, 'utf8');
const workerDockerfile = readFileSync(`${repositoryRoot}/services/worker/Dockerfile`, 'utf8');
const compose = readFileSync(`${repositoryRoot}/docker-compose.yml`, 'utf8');
const ci = readFileSync(`${repositoryRoot}/.github/workflows/ci.yml`, 'utf8');

test('migration provisions the exact immutable E05 Day replay rule artifact', () => {
  for (const identity of [
    'RULE:DAY_REPLAY_EVIDENCE:mvp-release-evidence-v1',
    'E05_DAY_REPLAY_SHA256_V1',
    'p0-day-replay-locator/v1',
    'e05-day-replay-verification/v1',
    'ce780a297faaf2a925870e62e0db9b8daffb7b79ec8f5045547b993ef4d8925b',
  ]) {
    assert.match(migration, new RegExp(identity.replaceAll(/[./]/g, '\\$&')));
  }
  assert.match(migration, /ON CONFLICT \("artifactKind", "artifactKey", "version"\) DO NOTHING/);
  assert.match(migration, /artifact was not provisioned exactly/);
});

test('forward migration fails closed on artifact, job, or execution history conflicts', () => {
  assert.match(migration, /conflicting DAY_REPLAY_EVIDENCE artifact already exists/);
  assert.match(migration, /conflicting versioned replay execution history exists/);
  assert.match(migration, /conflicting simulation job history exists/);
  assert.match(migration, /"inputPayload"#>>'\{rule,key\}'/);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE|TRUNCATE)\b/im);
});

test('rollback retains all artifact, job, execution, event, and snapshot evidence', () => {
  assert.match(rollback, /SimulationJob references DAY_REPLAY_EVIDENCE/);
  assert.match(rollback, /VersionedReplayExecution references DAY_REPLAY_EVIDENCE/);
  assert.match(rollback, /retained immutable evidence/);
  assert.doesNotMatch(rollback, /\b(?:DELETE|UPDATE|TRUNCATE)\b/i);
  assert.doesNotMatch(rollback, /DROP\s+(?:TRIGGER|TABLE|FUNCTION|TYPE)/i);
  assert.doesNotMatch(rollback, /ReplayEvent"\s*;|DayEndSnapshot"\s*;/);
});

test('worker evidence access is service-scoped and excludes retired saves', () => {
  assert.match(source, /snapshot\."restaurantId" = \$1/);
  assert.match(source, /snapshot\."saveId" = \$2/);
  assert.match(source, /snapshot\."businessDay" = \$3/);
  assert.match(source, /snapshot\."id" = \$4/);
  assert.match(source, /day\."status" = 'SETTLED'/);
  assert.match(source, /save\."retiredAt" IS NULL/);
  assert.match(source, /event\."restaurantId" = \$1/);
  assert.match(source, /ORDER BY event\."sequence" ASC/);
  assert.doesNotMatch(source, /playerId|tenantId|clerkUserId/);
});

test('worker accepts only exact DAY_REPLAY mapping and registers the E05 processor', () => {
  assert.match(worker, /input\.jobKind !== 'VERSIONED_REPLAY'/);
  assert.match(worker, /input\.payload\.replayKind !== 'DAY_REPLAY'/);
  assert.match(worker, /DAY_REPLAY_EVIDENCE_PROCESSOR_ID\]: createDayReplayEvidenceVerification/);
  assert.match(worker, /DAY_REPLAY_LOCATOR_TAMPERED/);
  assert.match(worker, /DAY_REPLAY_SOURCE_CORRUPT/);
  assert.match(worker, /const status =[\s\S]*?'MISMATCH'/);
});

test('API request comment truthfully describes locator-only worker resolution', () => {
  assert.match(apiHandler, /carries immutable locators and evidence hashes/);
  assert.match(apiHandler, /worker resolves those scoped records/);
  assert.doesNotMatch(apiHandler, /worker is not implemented|pending worker/i);
});

test('API and worker consume one authoritative runtime E05 hashing package', async () => {
  assert.match(apiReleaseEvidence, /from '@econ-game\/release-evidence'/);
  assert.match(source, /from '@econ-game\/release-evidence'/);
  assert.doesNotMatch(apiReleaseEvidence, /createHash|function sha256|DAY_END_FIXED_FIELDS/);
  assert.doesNotMatch(source, /createHash|function sha256|dayEndFixedFields/);
  assert.equal(sharedPackage.name, '@econ-game/release-evidence');
  assert.equal(sharedPackage.exports['.'].import, './index.js');
  assert.match(sharedImplementation, /export function hashReleaseEvidenceEvents/);
  assert.match(sharedImplementation, /export function hashReleaseEvidenceSnapshot/);
  const shared = await import(
    new URL('../../../../packages/econ-game-release-evidence/index.js', import.meta.url)
  );
  assert.equal(shared.RELEASE_EVIDENCE_VERSION, 'mvp-release-evidence-v1');
  assert.equal(
    shared.hashReleaseEvidenceEvents([
      {
        sequence: 0,
        simulationRuleVersion: 'simulation-rule/v1',
        type: 'OPEN_DAY',
        payload: { gameId: 'game-1', dayIndex: 1 },
      },
      {
        sequence: 1,
        simulationRuleVersion: 'simulation-rule/v1',
        type: 'DAY_END_SETTLED',
        payload: { cashAfterMinor: '13400' },
      },
    ]),
    'f83ad03e07924d5c127692901b597b7e9c3ef06849196aafef0e44c38f51215d',
  );
});

test('npm, Bun, Docker, Compose, and CI preserve the local package production path', () => {
  const dependency = 'file:../../packages/econ-game-release-evidence';
  assert.equal(apiPackage.dependencies['@econ-game/release-evidence'], dependency);
  assert.equal(workerPackage.dependencies['@econ-game/release-evidence'], dependency);
  for (const lock of [apiNpmLock, workerNpmLock, apiBunLock, workerBunLock]) {
    assert.match(lock, /@econ-game\/release-evidence/);
    assert.match(lock, /\.\.\/\.\.\/packages\/econ-game-release-evidence/);
  }
  for (const dockerfile of [apiDockerfile, workerDockerfile]) {
    assert.match(dockerfile, /WORKDIR \/workspace\/services\/(?:api|worker)/);
    assert.match(
      dockerfile,
      /COPY packages\/econ-game-release-evidence \/workspace\/packages\/econ-game-release-evidence/,
    );
    assert.match(dockerfile, /CMD \["node", "dist\/index\.js"\]/);
  }
  assert.match(compose, /api:[\s\S]*?context: \.[\s\S]*?dockerfile: services\/api\/Dockerfile/);
  assert.match(
    compose,
    /worker:[\s\S]*?context: \.[\s\S]*?dockerfile: services\/worker\/Dockerfile/,
  );
  assert.match(ci, /service: api\s+context: \.\s+dockerfile: services\/api\/Dockerfile/);
  assert.match(ci, /service: worker\s+context: \.\s+dockerfile: services\/worker\/Dockerfile/);
});

test('static inspection makes no PostgreSQL runtime claim', () => {
  assert.doesNotMatch(import.meta.url, /postgres/i);
});
