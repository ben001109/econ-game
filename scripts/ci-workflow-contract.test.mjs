import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const staticContracts = readFileSync(new URL('./run-ci-static-contracts.mjs', import.meta.url), 'utf8');

function jobBlock(id) {
  const start = `  ${id}:\n`;
  const startIndex = workflow.indexOf(start);
  assert.notEqual(startIndex, -1, `CI job ${id} must exist`);

  const remainder = workflow.slice(startIndex);
  const nextJob = remainder.slice(start.length).match(/\n  [A-Za-z0-9_-]+:\n/);
  return nextJob ? remainder.slice(0, start.length + nextJob.index) : remainder;
}

function exactRunner(job, stepName) {
  const escapedName = stepName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = job.match(
    new RegExp(
      `^      - name: ${escapedName}\\n(?:^        (?!- name:).+\\n)*?^        run: ([^\\n]+)$`,
      'm',
    ),
  );
  assert.ok(match, `step ${stepName} must have a single-line run command`);
  return match[1];
}

test('CI runs the root supply-chain policy and checked static migration inventory', () => {
  const supplyChain = jobBlock('supply-chain-security');
  const migrationSafety = jobBlock('migration-safety');

  assert.equal(
    exactRunner(supplyChain, 'Test supply-chain checker policy'),
    'node --test scripts/check-supply-chain.test.mjs',
  );
  assert.equal(
    exactRunner(supplyChain, 'Verify locks, advisories, actions, images, Bun, and bootstrap policy'),
    'node scripts/check-supply-chain.mjs --online',
  );
  assert.equal(
    exactRunner(migrationSafety, 'Reject schema push commands'),
    'node scripts/check-migration-safety.mjs',
  );
  assert.equal(
    exactRunner(migrationSafety, 'Run persistence and migration static contracts'),
    'node scripts/run-ci-static-contracts.mjs',
  );
});

test('the explicit static migration inventory covers every current node static contract', () => {
  const expected = [
    'services/api/tests/schema/d01-persistence.test.mjs',
    'services/api/tests/security/b2-outbox-dead-letter-migration.test.mjs',
    'services/api/tests/security/d04-rls-claims.test.mjs',
    'services/api/tests/security/d05-privacy-regressions.test.mjs',
    'services/api/tests/security/d05-wipe-batch-migration.test.mjs',
    'services/api/tests/security/d05-wipe-execution-static.test.mjs',
    'services/api/tests/security/d05-wipe-workflow-static.test.mjs',
    'services/api/tests/simulation/d03-s02-migration.test.mjs',
  ];

  for (const path of expected) assert.match(staticContracts, new RegExp(`'${path}'`));
  assert.match(staticContracts, /process\.execPath, \['--test', \.\.\.STATIC_CONTRACTS\]/);
});

test('service quality has no silent skips and always runs the Worker runtime environment contract', () => {
  const quality = jobBlock('service-quality');

  assert.doesNotMatch(workflow, /--if-present/);
  assert.equal(exactRunner(quality, 'Generate Prisma Client'), 'npm run prisma:generate');
  assert.match(quality, /if: matrix\.service == 'api'/);
  assert.equal(exactRunner(quality, 'Unit and invariant tests'), 'npm run test');
  assert.equal(
    exactRunner(quality, 'Worker runtime environment contract'),
    './node_modules/.bin/tsx --test src/runtime-env.test.ts',
  );
  assert.match(quality, /if: matrix\.service == 'worker'/);
});

test('Docker build remains gated on the security, migration, service, and SDK jobs', () => {
  const docker = jobBlock('docker-build');
  assert.match(
    docker,
    /needs: \[supply-chain-security, migration-safety, service-quality, sdk-quality\]/,
  );
});
