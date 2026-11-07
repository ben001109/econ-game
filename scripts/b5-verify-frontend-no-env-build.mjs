import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  argumentValue,
  copyTreeExcludingEnv,
  isMain,
  listEnvPathNames,
  runCommand,
} from './b5-evidence-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '..');

export async function verifyFrontendNoEnvBuild(options = {}) {
  const serviceRoot = resolve(options.serviceRoot ?? join(REPOSITORY_ROOT, 'services/frontend'));
  const temporaryParent = await mkdtemp(join(options.tempRoot ?? '/tmp', 'econ-b5-frontend-no-env-'));
  const copyRoot = join(temporaryParent, 'services/frontend');
  await mkdir(dirname(copyRoot), { recursive: true });

  const copied = await copyTreeExcludingEnv(serviceRoot, copyRoot);
  const remainingEnvPaths = await listEnvPathNames(copyRoot);
  const commandSpecifications = [
    ['npm', ['ci', '--ignore-scripts']],
    ['npm', ['run', 'typecheck']],
    ['npm', ['test']],
    ['npm', ['run', 'build']],
  ];
  const commands = [];

  if (remainingEnvPaths.length === 0) {
    for (const [command, args] of commandSpecifications) {
      const result = runCommand(command, args, { cwd: copyRoot });
      commands.push(result);
      if (result.exitCode !== 0) {
        break;
      }
    }
  }

  const allCommandsCompleted = commands.length === commandSpecifications.length;
  const allCommandsPassed = allCommandsCompleted && commands.every((result) => result.exitCode === 0);
  const noEnvBuildEvidence = remainingEnvPaths.length === 0 && allCommandsPassed;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verifier: 'scripts/b5-verify-frontend-no-env-build.mjs',
    status: noEnvBuildEvidence ? 'passed' : 'failed',
    noEnvBuildEvidence,
    exclusionRule: 'exclude every file or directory whose basename starts with .env at any depth',
    sourceRoot: serviceRoot,
    copyRoot,
    excludedEnvPaths: copied.excludedEnvPaths,
    excludedBuildPaths: copied.excludedBuildPaths,
    remainingEnvPaths,
    commands,
  };
}

async function main() {
  const outputPath = resolve(
    argumentValue(
      '--output',
      join(REPOSITORY_ROOT, 'docs/security/npm-cve-evidence/frontend-no-env-build.json'),
    ),
  );
  let evidence;
  try {
    evidence = await verifyFrontendNoEnvBuild({
      serviceRoot: argumentValue('--service-root'),
      tempRoot: argumentValue('--temp-root', '/tmp'),
    });
  } catch (error) {
    evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verifier: 'scripts/b5-verify-frontend-no-env-build.mjs',
      status: 'failed',
      noEnvBuildEvidence: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    status: evidence.status,
    noEnvBuildEvidence: evidence.noEnvBuildEvidence,
    copyRoot: evidence.copyRoot ?? null,
    excludedEnvPaths: evidence.excludedEnvPaths ?? [],
    commandExitCodes: evidence.commands?.map((item) => item.exitCode) ?? [],
    output: outputPath,
  }, null, 2)}\n`);
  process.exitCode = evidence.noEnvBuildEvidence === true ? 0 : 1;
}

if (isMain(import.meta.url)) {
  await main();
}
