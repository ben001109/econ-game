import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  argumentValue,
  isMain,
  runCommand,
  sha256File,
} from './b5-evidence-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '..');
const FIXTURE_ROOT = join(HERE, 'fixtures/b5-remediation');

export function evaluateNewRelicRuntime(metadata, configuredRuntime) {
  const runtimeMatch = /^v?(\d+)(?:\.|$)/u.exec(configuredRuntime.trim());
  const configuredRuntimeMajor = runtimeMatch ? Number(runtimeMatch[1]) : null;
  const nodeEngine = metadata.engines?.node ?? null;
  const verified =
    metadata.version === '14.3.7' &&
    nodeEngine === '>=22' &&
    configuredRuntimeMajor === 20;
  return {
    verified,
    packageVersion: metadata.version ?? null,
    requiredNodeEngine: nodeEngine,
    configuredRuntime: configuredRuntime.trim(),
    configuredRuntimeMajor,
    incompatible: verified,
  };
}

export async function verifyNewRelicRuntime(options = {}) {
  const mode = options.mode ?? 'offline';
  const runtimePath = resolve(options.runtimePath ?? join(REPOSITORY_ROOT, '.nvmrc'));
  const configuredRuntime = await readFile(runtimePath, 'utf8');
  let rawMetadata;
  let metadataSha256;
  let provenance;
  let registryCommand = null;
  let sourceVerified = false;

  if (mode === 'online') {
    const npmCommand = options.npmCommand ?? 'npm';
    registryCommand = runCommand(
      npmCommand,
      ['view', 'newrelic@14.3.7', 'version', 'engines', 'dist.integrity', 'dist.tarball', '--json'],
      { cwd: REPOSITORY_ROOT },
    );
    if (registryCommand.exitCode !== 0) {
      return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verifier: 'scripts/b5-verify-newrelic-runtime.mjs',
        mode,
        status: 'failed-closed',
        verified: false,
        registryCommand,
      };
    }
    rawMetadata = registryCommand.stdout;
    metadataSha256 = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(rawMetadata).digest('hex'));
    provenance = { source: 'live npm registry stdout', registry: 'https://registry.npmjs.org/' };
    sourceVerified = true;
  } else if (mode === 'offline') {
    const fixturePath = resolve(
      options.fixturePath ?? join(FIXTURE_ROOT, 'newrelic-14.3.7-metadata.json'),
    );
    const provenancePath = resolve(
      options.provenancePath ?? join(FIXTURE_ROOT, 'newrelic-14.3.7-provenance.json'),
    );
    rawMetadata = await readFile(fixturePath, 'utf8');
    metadataSha256 = await sha256File(fixturePath);
    provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
    sourceVerified =
      provenance.source === 'npm registry raw stdout' &&
      provenance.registry === 'https://registry.npmjs.org/' &&
      metadataSha256 === provenance.fixtureSha256;
    provenance = { ...provenance, fixturePath, provenancePath };
  } else {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  const metadata = JSON.parse(rawMetadata);
  const evaluation = evaluateNewRelicRuntime(metadata, configuredRuntime);
  const verified = sourceVerified && evaluation.verified;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verifier: 'scripts/b5-verify-newrelic-runtime.mjs',
    mode,
    status: verified ? 'runtime-incompatibility-verified' : 'failed-closed',
    verified,
    sourceVerified,
    metadataSha256,
    provenance,
    runtimePath,
    executingNodeVersion: process.version,
    evaluation,
    registryCommand,
  };
}

async function main() {
  const outputPath = resolve(
    argumentValue(
      '--output',
      join(REPOSITORY_ROOT, 'docs/security/npm-cve-evidence/newrelic-14.3.7-runtime.json'),
    ),
  );
  const mode = argumentValue('--mode', 'offline');
  let evidence;
  try {
    evidence = await verifyNewRelicRuntime({
      mode,
      npmCommand: argumentValue('--npm-command', 'npm'),
      fixturePath: argumentValue('--fixture'),
      provenancePath: argumentValue('--provenance'),
      runtimePath: argumentValue('--runtime'),
    });
  } catch (error) {
    evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verifier: 'scripts/b5-verify-newrelic-runtime.mjs',
      mode,
      status: 'failed-closed',
      verified: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    mode: evidence.mode,
    status: evidence.status,
    verified: evidence.verified,
    metadataSha256: evidence.metadataSha256 ?? null,
    evaluation: evidence.evaluation ?? null,
    output: outputPath,
  }, null, 2)}\n`);
  process.exitCode = evidence.verified === true ? 0 : 1;
}

if (isMain(import.meta.url)) {
  await main();
}
