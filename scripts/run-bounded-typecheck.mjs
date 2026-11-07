#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const supportedServices = new Set(['api', 'worker']);
const defaultTimeoutSeconds = 180;
const forceKillDelayMs = 10_000;

function usage() {
  console.error(
    'Usage: node scripts/run-bounded-typecheck.mjs --service <api|worker> [--timeout-seconds <1-600>]\n'
      + '       node scripts/run-bounded-typecheck.mjs --self-test',
  );
}

function parseArguments(arguments_) {
  const result = { service: null, timeoutSeconds: defaultTimeoutSeconds, selfTest: false };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--self-test') {
      result.selfTest = true;
    } else if (argument === '--service') {
      result.service = arguments_[index + 1] ?? null;
      index += 1;
    } else if (argument === '--timeout-seconds') {
      const value = Number(arguments_[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 600) return null;
      result.timeoutSeconds = value;
      index += 1;
    } else {
      return null;
    }
  }

  if (result.selfTest) {
    return result.service === null && arguments_.length === 1 ? result : null;
  }

  return supportedServices.has(result.service) ? result : null;
}

function forwardLines(readable, output) {
  const lines = createInterface({ input: readable, crlfDelay: Infinity });
  lines.on('line', (line) => output.write(`${line}\n`));
  return new Promise((resolvePromise) => lines.once('close', resolvePromise));
}

function stopProcessTree(child, signal) {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child if the process group has already exited.
    }
  }

  child.kill(signal);
}

async function runBoundedCommand({ label, command, arguments_, cwd, timeoutMs, env }) {
  console.log(`[bounded-typecheck] ${label}: timeout=${Math.ceil(timeoutMs / 1000)}s command=${command} ${arguments_.join(' ')}`);

  const child = spawn(command, arguments_, {
    cwd,
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdoutDone = forwardLines(child.stdout, process.stdout);
  const stderrDone = forwardLines(child.stderr, process.stderr);
  let timedOut = false;
  let forceKillTimer;

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    console.error(`[bounded-typecheck] ${label}: exceeded ${Math.ceil(timeoutMs / 1000)}s; terminating process tree.`);
    stopProcessTree(child, 'SIGTERM');
    forceKillTimer = setTimeout(() => {
      console.error(`[bounded-typecheck] ${label}: process tree ignored SIGTERM; forcing termination.`);
      stopProcessTree(child, 'SIGKILL');
    }, forceKillDelayMs);
    forceKillTimer.unref();
  }, timeoutMs);
  timeoutTimer.unref();

  const result = await new Promise((resolvePromise) => {
    child.once('error', (error) => resolvePromise({ error }));
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
  });

  clearTimeout(timeoutTimer);
  clearTimeout(forceKillTimer);
  await Promise.all([stdoutDone, stderrDone]);

  if (timedOut) {
    console.error(`[bounded-typecheck] ${label}: failed (timeout).`);
    return 124;
  }
  if (result.error) {
    console.error(`[bounded-typecheck] ${label}: failed to start (${result.error.code ?? 'unknown'}).`);
    return 1;
  }
  if (result.code !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `exit ${result.code ?? 'unknown'}`;
    console.error(`[bounded-typecheck] ${label}: failed (${reason}).`);
    return 1;
  }

  console.log(`[bounded-typecheck] ${label}: passed.`);
  return 0;
}

async function runSelfTest() {
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' };
  const success = await runBoundedCommand({
    label: 'self-test-success',
    command: process.execPath,
    arguments_: ['-e', "process.stdout.write('line-buffered diagnostic\\n')"],
    cwd: repositoryRoot,
    timeoutMs: 1_000,
    env,
  });
  const timeout = await runBoundedCommand({
    label: 'self-test-timeout',
    command: process.execPath,
    arguments_: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
    cwd: repositoryRoot,
    timeoutMs: 100,
    env,
  });

  if (success !== 0 || timeout !== 124) {
    console.error('[bounded-typecheck] self-test failed.');
    return 1;
  }

  console.log('[bounded-typecheck] self-test passed.');
  return 0;
}

const parsed = parseArguments(process.argv.slice(2));
if (!parsed) {
  usage();
  process.exitCode = 2;
} else if (parsed.selfTest) {
  process.exitCode = await runSelfTest();
} else {
  const exitCode = await runBoundedCommand({
    label: parsed.service,
    command: 'npm',
    arguments_: ['run', 'typecheck', '--', '--pretty', 'false'],
    cwd: resolve(repositoryRoot, 'services', parsed.service),
    timeoutMs: parsed.timeoutSeconds * 1_000,
    env: {
      ...process.env,
      CI: 'true',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      TERM: 'dumb',
      npm_config_color: 'false',
    },
  });
  process.exitCode = exitCode;
}
