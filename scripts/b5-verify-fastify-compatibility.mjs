import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  argumentValue,
  copyTreeExcludingEnv,
  isMain,
  listEnvPathNames,
  runCommand,
  sha256File,
} from './b5-evidence-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '..');
const FIXTURE_ROOT = join(HERE, 'fixtures/b5-remediation/fastify-safe');

export function evaluateFastifyCompilerResult(result) {
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const matches = [...combined.matchAll(/src\/app-composition\.ts\((\d+),(\d+)\): error TS18046: 'error' is of type 'unknown'\./gu)];
  return {
    reproduced: result.exitCode !== 0 && matches.length === 5,
    ts18046Count: matches.length,
    diagnostics: matches.map((match) => ({ line: Number(match[1]), column: Number(match[2]), text: match[0] })),
  };
}

export async function verifyFastifyCompatibility(options = {}) {
  const serviceRoot = resolve(options.serviceRoot ?? join(REPOSITORY_ROOT, 'services/api'));
  const lockFixture = resolve(options.lockFixture ?? join(FIXTURE_ROOT, 'package-lock.json'));
  const provenancePath = resolve(options.provenance ?? join(FIXTURE_ROOT, 'provenance.json'));
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  const fixtureSha256 = await sha256File(lockFixture);
  const fixtureHashValid = fixtureSha256 === provenance.fixtureSha256;
  const fixtureLock = JSON.parse(await readFile(lockFixture, 'utf8'));
  const fixtureIdentity = {
    sha256: fixtureSha256,
    rootDependency: fixtureLock.packages?.['']?.dependencies?.fastify ?? null,
    resolvedFastify: fixtureLock.packages?.['node_modules/fastify']?.version ?? null,
    resolvedFindMyWay: fixtureLock.packages?.['node_modules/find-my-way']?.version ?? null,
  };
  const fixtureVersionsValid =
    fixtureIdentity.rootDependency === provenance.expected.rootDependency &&
    fixtureIdentity.resolvedFastify === provenance.expected.resolvedFastify &&
    fixtureIdentity.resolvedFindMyWay === provenance.expected.resolvedFindMyWay;

  const temporaryParent = await mkdtemp(join(options.tempRoot ?? '/tmp', 'econ-b5-fastify-compat-'));
  const copyRoot = join(temporaryParent, 'services/api');
  await mkdir(dirname(copyRoot), { recursive: true });
  const copied = await copyTreeExcludingEnv(serviceRoot, copyRoot);
  const remainingEnvPaths = await listEnvPathNames(copyRoot);

  await copyFile(lockFixture, join(copyRoot, 'package-lock.json'));
  const packagePath = join(copyRoot, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  packageJson.dependencies.fastify = provenance.expected.rootDependency;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  const installArgs = ['ci', '--ignore-scripts'];
  if (options.offline === true) {
    installArgs.push('--offline');
  }
  const install = runCommand('npm', installArgs, { cwd: copyRoot });
  const build = install.exitCode === 0
    ? runCommand('npm', ['run', 'build'], { cwd: copyRoot })
    : { command: ['npm', 'run', 'build'], exitCode: null, signal: null, stdout: '', stderr: '', spawnError: 'skipped because npm ci failed' };
  const compiler = evaluateFastifyCompilerResult(build);
  const reproduced =
    fixtureHashValid &&
    fixtureVersionsValid &&
    remainingEnvPaths.length === 0 &&
    install.exitCode === 0 &&
    compiler.reproduced;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verifier: 'scripts/b5-verify-fastify-compatibility.mjs',
    status: reproduced ? 'incompatibility-reproduced' : 'failed-closed',
    verified: reproduced,
    sharedTreeModified: false,
    sourceRoot: serviceRoot,
    copyRoot,
    excludedEnvPaths: copied.excludedEnvPaths,
    remainingEnvPaths,
    fixture: {
      lockPath: lockFixture,
      provenancePath,
      hashValid: fixtureHashValid,
      versionsValid: fixtureVersionsValid,
      identity: fixtureIdentity,
    },
    commands: { install, build },
    compiler,
  };
}

async function main() {
  const outputPath = resolve(
    argumentValue(
      '--output',
      join(REPOSITORY_ROOT, 'docs/security/npm-cve-evidence/fastify-5.8.5-compatibility.json'),
    ),
  );
  let evidence;
  try {
    evidence = await verifyFastifyCompatibility({
      serviceRoot: argumentValue('--service-root'),
      lockFixture: argumentValue('--lock-fixture'),
      provenance: argumentValue('--provenance'),
      offline: process.argv.includes('--offline'),
      tempRoot: argumentValue('--temp-root', '/tmp'),
    });
  } catch (error) {
    evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verifier: 'scripts/b5-verify-fastify-compatibility.mjs',
      status: 'failed-closed',
      verified: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    status: evidence.status,
    verified: evidence.verified,
    copyRoot: evidence.copyRoot ?? null,
    lockIdentity: evidence.fixture?.identity ?? null,
    compilerExitCode: evidence.commands?.build?.exitCode ?? null,
    ts18046Count: evidence.compiler?.ts18046Count ?? 0,
    output: outputPath,
  }, null, 2)}\n`);
  process.exitCode = evidence.verified === true ? 0 : 1;
}

if (isMain(import.meta.url)) {
  await main();
}
