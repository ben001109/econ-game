#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const services = ['api', 'worker', 'frontend', 'bot'];
const steps = [
  ['prisma:generate', ['run', 'prisma:generate', '--if-present']],
  ['format', ['run', 'format:check']],
  ['lint', ['run', 'lint', '--if-present']],
  ['typecheck', ['run', 'typecheck']],
  ['test', ['run', 'test', '--if-present']],
  ['build', ['run', 'build', '--if-present']],
];

const arguments_ = process.argv.slice(2);
const execute = arguments_.includes('--execute');
const dryRun = !execute;

if (
  arguments_.some((argument) => argument !== '--dry-run' && argument !== '--execute') ||
  (arguments_.includes('--dry-run') && execute)
) {
  console.error('Usage: node scripts/quality-gate.mjs [--dry-run | --execute]');
  process.exitCode = 2;
} else {
  let failed = false;

  for (const service of services) {
    const workingDirectory = resolve(repositoryRoot, 'services', service);

    for (const [label, npmArguments] of steps) {
      const command = `npm ${npmArguments.join(' ')}`;
      const mode = dryRun ? 'would run' : 'running';
      console.log(`[${service}] ${label}: ${mode} ${command}`);

      if (dryRun) {
        continue;
      }

      const result = spawnSync('npm', npmArguments, {
        cwd: workingDirectory,
        stdio: 'inherit',
        timeout: 300_000,
        killSignal: 'SIGTERM',
      });

      if (result.error || result.status !== 0) {
        failed = true;
        const detail = result.error
          ? result.error.message
          : result.signal
            ? `signal ${result.signal}`
            : `exit ${result.status ?? 'unknown'}`;
        console.error(`[${service}] ${label} failed (${detail}).`);
      }
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
}
