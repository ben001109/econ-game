import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  copyTreeExcludingEnv,
  listEnvPathNames,
  sha256File,
  shouldExcludeEnvPath,
} from './b5-evidence-utils.mjs';
import { evaluateFastifyCompilerResult } from './b5-verify-fastify-compatibility.mjs';
import { evaluateNewRelicRuntime } from './b5-verify-newrelic-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '..');
const FIXTURE_ROOT = join(HERE, 'fixtures/b5-remediation');
const EVIDENCE_ROOT = join(REPOSITORY_ROOT, 'docs/security/npm-cve-evidence');

async function json(pathname) {
  return JSON.parse(await readFile(pathname, 'utf8'));
}

test('frontend copier excludes every .env* basename at any depth without opening it', async () => {
  const fixture = await json(join(FIXTURE_ROOT, 'env-path-cases.json'));
  for (const item of fixture.cases) {
    assert.equal(shouldExcludeEnvPath(item.path), item.excluded, item.path);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'econ-b5-env-rule-test-'));
  const sourceRoot = join(temporaryRoot, 'source');
  const targetRoot = join(temporaryRoot, 'target');
  await mkdir(sourceRoot, { recursive: true });
  for (const item of fixture.cases) {
    const pathname = join(sourceRoot, item.path);
    await mkdir(dirname(pathname), { recursive: true });
    await writeFile(pathname, item.excluded ? 'fixture-secret-must-not-be-copied' : 'ordinary fixture', 'utf8');
  }

  const result = await copyTreeExcludingEnv(sourceRoot, targetRoot);
  assert.deepEqual(
    [...result.excludedEnvPaths].sort(),
    fixture.cases.filter((item) => item.excluded).map((item) => item.path).sort(),
  );
  assert.deepEqual(await listEnvPathNames(targetRoot), []);
  for (const item of fixture.cases.filter((entry) => !entry.excluded)) {
    await access(join(targetRoot, item.path));
  }
});

test('frontend generated evidence is only marked successful after all no-env commands pass', async () => {
  const evidence = await json(join(EVIDENCE_ROOT, 'frontend-no-env-build.json'));
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.noEnvBuildEvidence, true);
  assert.match(evidence.copyRoot, /^\/tmp\//u);
  assert.deepEqual(evidence.remainingEnvPaths, []);
  assert.deepEqual(evidence.commands.map((item) => item.exitCode), [0, 0, 0, 0]);
  assert.ok(evidence.excludedEnvPaths.every((pathname) => shouldExcludeEnvPath(pathname)));
});

test('Fastify lock fixture identity is npm-generated, hashed, and resolves 5.8.5', async () => {
  const fixturePath = join(FIXTURE_ROOT, 'fastify-safe/package-lock.json');
  const provenance = await json(join(FIXTURE_ROOT, 'fastify-safe/provenance.json'));
  const lock = await json(fixturePath);
  assert.equal(await sha256File(fixturePath), provenance.fixtureSha256);
  assert.equal(lock.packages[''].dependencies.fastify, provenance.expected.rootDependency);
  assert.equal(lock.packages['node_modules/fastify'].version, provenance.expected.resolvedFastify);
  assert.equal(
    lock.packages['node_modules/find-my-way'].version,
    provenance.expected.resolvedFindMyWay,
  );
});

test('Fastify generated evidence contains the actual five TS18046 diagnostics', async () => {
  const evidence = await json(join(EVIDENCE_ROOT, 'fastify-5.8.5-compatibility.json'));
  assert.equal(evidence.status, 'incompatibility-reproduced');
  assert.equal(evidence.verified, true);
  assert.match(evidence.copyRoot, /^\/tmp\//u);
  assert.equal(evidence.fixture.identity.resolvedFastify, '5.8.5');
  assert.equal(evidence.commands.install.exitCode, 0);
  assert.notEqual(evidence.commands.build.exitCode, 0);
  const evaluated = evaluateFastifyCompilerResult(evidence.commands.build);
  assert.equal(evaluated.reproduced, true);
  assert.equal(evaluated.ts18046Count, 5);

  const incompleteOutput = {
    ...evidence.commands.build,
    stdout: evaluated.diagnostics.slice(0, 4).map((item) => item.text).join('\n'),
    stderr: '',
  };
  assert.equal(evaluateFastifyCompilerResult(incompleteOutput).reproduced, false);
});

test('New Relic registry fixture has matching provenance and proves the Node 20 mismatch', async () => {
  const metadataPath = join(FIXTURE_ROOT, 'newrelic-14.3.7-metadata.json');
  const provenance = await json(join(FIXTURE_ROOT, 'newrelic-14.3.7-provenance.json'));
  const metadata = await json(metadataPath);
  assert.equal(await sha256File(metadataPath), provenance.fixtureSha256);
  assert.equal(provenance.source, 'npm registry raw stdout');
  assert.deepEqual(evaluateNewRelicRuntime(metadata, '20'), {
    verified: true,
    packageVersion: '14.3.7',
    requiredNodeEngine: '>=22',
    configuredRuntime: '20',
    configuredRuntimeMajor: 20,
    incompatible: true,
  });

  const evidence = await json(join(EVIDENCE_ROOT, 'newrelic-14.3.7-runtime.json'));
  assert.equal(evidence.status, 'runtime-incompatibility-verified');
  assert.equal(evidence.verified, true);
  assert.equal(evidence.sourceVerified, true);
  assert.equal(evidence.metadataSha256, provenance.fixtureSha256);
});

test('New Relic online verifier fails closed when registry execution is unavailable', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'econ-b5-newrelic-network-test-'));
  const outputPath = join(temporaryRoot, 'failed-closed.json');
  const result = spawnSync(
    process.execPath,
    [
      join(HERE, 'b5-verify-newrelic-runtime.mjs'),
      '--mode',
      'online',
      '--npm-command',
      join(temporaryRoot, 'missing-npm'),
      '--output',
      outputPath,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  const evidence = await json(outputPath);
  assert.equal(evidence.status, 'failed-closed');
  assert.equal(evidence.verified, false);
  assert.notEqual(evidence.registryCommand.spawnError, null);
});

test('remediation plan links rerunnable artifacts and keeps both blocked upgrades unresolved', async () => {
  const plan = await json(join(REPOSITORY_ROOT, 'docs/security/npm-cve-remediation-plan.json'));
  for (const artifact of plan.validationArtifacts) {
    const generated = await json(join(REPOSITORY_ROOT, artifact.artifact));
    assert.equal(generated.status, artifact.status, artifact.subject);
  }
  const frontend = plan.validationArtifacts.find((item) => item.subject.startsWith('frontend'));
  assert.equal(frontend.noEnvBuildEvidence, true);
  assert.equal(
    await sha256File(join(REPOSITORY_ROOT, frontend.exclusionFixture)),
    frontend.exclusionFixtureSha256,
  );

  const fastify = plan.remainingAdvisories.find((item) => item.packages.includes('fastify'));
  assert.equal(fastify.unresolved, true);
  assert.equal(fastify.evidence, 'docs/security/npm-cve-evidence/fastify-5.8.5-compatibility.json');

  const newRelic = plan.remainingAdvisories.find((item) => item.packages.includes('newrelic'));
  assert.equal(newRelic.unresolved, true);
  assert.equal(newRelic.evidence, 'docs/security/npm-cve-evidence/newrelic-14.3.7-runtime.json');
});
