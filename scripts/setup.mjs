#!/usr/bin/env node
// Interactive cross-platform setup script for econ-game
// Run without arguments: `node scripts/setup.mjs`

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const root = resolve(process.cwd());
const servicesDir = join(root, 'services');

let rl = null;

function ensureInterface() {
  if (!rl) {
    rl = createInterface({ input, output });
  }
  return rl;
}

function closeInterface() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`[warn] ${msg}\n`);
}

function fail(msg, code = 1) {
  closeInterface();
  process.stderr.write(`[error] ${msg}\n`);
  process.exit(code);
}

async function askQuestion(prompt, defaultValue = '') {
  if (!process.stdin.isTTY) {
    return defaultValue ?? '';
  }
  const iface = ensureInterface();
  return iface.question(prompt);
}

async function askYesNo(question, defaultYes = true) {
  if (!process.stdin.isTTY) {
    return defaultYes;
  }
  const suffix = defaultYes ? ' [Y/n]: ' : ' [y/N]: ';
  const answer = (await askQuestion(`${question}${suffix}`, '')).trim().toLowerCase();
  if (!answer) {
    return defaultYes;
  }
  if (['y', 'yes', '1'].includes(answer)) {
    return true;
  }
  if (['n', 'no', '0'].includes(answer)) {
    return false;
  }
  warn(`Unknown selection '${answer}'. Using default (${defaultYes ? 'yes' : 'no'}).`);
  return defaultYes;
}

async function askChoice(question, choices, defaultValue) {
  if (!process.stdin.isTTY) {
    return defaultValue;
  }
  log(question);
  choices.forEach((choice, idx) => {
    log(`  ${idx + 1}) ${choice.label}`);
  });
  const defaultIndex = choices.findIndex((choice) => choice.value === defaultValue);
  const fallbackIndex = defaultIndex >= 0 ? defaultIndex : 0;
  const prompt = `Enter choice [${fallbackIndex + 1}]: `;
  const raw = (await askQuestion(prompt, '')).trim().toLowerCase();
  if (!raw) {
    return choices[fallbackIndex].value;
  }
  const numeric = Number.parseInt(raw, 10);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= choices.length) {
    return choices[numeric - 1].value;
  }
  const match = choices.find((choice) => {
    if (choice.value.toLowerCase() === raw) {
      return true;
    }
    if (choice.aliases) {
      return choice.aliases.map((alias) => alias.toLowerCase()).includes(raw);
    }
    return false;
  });
  if (match) {
    return match.value;
  }
  warn(`Unknown selection '${raw}'. Using default.`);
  return choices[fallbackIndex].value;
}

async function commandExists(cmd) {
  // Use OS-native utilities that are real executables; `command -v` is a shell builtin.
  const shell = process.platform === 'win32' ? 'where' : 'sh';
  if (process.platform === 'win32') {
    try {
      await run(shell, [cmd], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  const quoted = cmd.replace(/"/g, '\\"');
  const args = ['-c', `command -v "${quoted}" >/dev/null 2>&1`];
  try {
    await run(shell, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: false, ...opts });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} -> ${code}`))));
  });
}

function requireInRepo() {
  if (!existsSync(servicesDir)) {
    fail('Please run from repo root (missing ./services).');
  }
}

function getNodeMajor() {
  const v = process.versions.node.split('.')[0];
  return Number(v);
}

function readNvmrc() {
  const p = join(root, '.nvmrc');
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8').trim();
  const major = Number(raw.replace(/^v/, ''));
  return Number.isFinite(major) ? major : null;
}

async function ensureDocker() {
  const hasDocker = await commandExists('docker');
  if (!hasDocker) fail('Docker is required. Install Docker Desktop (Win/macOS) or docker engine (Linux).');

  // Check compose subcommand or docker-compose
  let hasCompose = false;
  try {
    await run('docker', ['compose', 'version'], { stdio: 'ignore' });
    hasCompose = true;
  } catch {}
  if (!hasCompose) {
    const hasLegacy = await commandExists('docker-compose');
    if (!hasLegacy) fail('Docker Compose plugin not found. Update Docker to include `docker compose`.');
  }
}

async function dockerCompose(args) {
  // Prefer `docker compose`, fallback to `docker-compose`
  try {
    await run('docker', ['compose', ...args]);
  } catch (e) {
    const hasLegacy = await commandExists('docker-compose');
    if (!hasLegacy) throw e;
    await run('docker-compose', args);
  }
}

async function setupDocker(dev) {
  await ensureDocker();
  if (dev) {
    log('Cleaning previous dev containers (api-dev, worker-dev, frontend-dev, bot-dev)...');
    // Remove only dev service containers; keep DB/aux services intact
    try {
      await dockerCompose(['rm', '-s', '-f', 'api-dev', 'worker-dev', 'frontend-dev', 'bot-dev']);
    } catch (e) {
      // Ignore if nothing to remove
      warn('No existing dev containers to remove or cleanup failed; continuing.');
    }

    log('Starting dev profile containers (api-dev, worker-dev, frontend-dev, bot-dev, dbs)...');
    await dockerCompose(['--profile', 'dev', 'up', '--build', '-d', 'postgres', 'redis', 'api-dev', 'worker-dev', 'frontend-dev', 'bot-dev', 'adminer', 'redis-commander']);
  } else {
    log('Building and starting production-like stack...');
    await dockerCompose(['up', '--build', '-d']);
  }
  log('Docker setup complete.');
}

async function setupLocal({ skipInstall, dbPush, startDb }) {
  const requiredNode = readNvmrc() ?? 20;
  const current = getNodeMajor();
  if (current < requiredNode) {
    warn(`Node ${requiredNode}+ recommended (found ${process.versions.node}).`);
    warn('Use nvm: `nvm use` then rerun if available.');
  }

  if (startDb) {
    const dockerOk = await commandExists('docker');
    if (dockerOk) {
      log('Starting Postgres and Redis via Docker...');
      await ensureDocker();
      await dockerCompose(['up', '-d', 'postgres', 'redis']);
    } else if (process.platform === 'win32') {
      warn('Docker not available on Windows. Please install Postgres/Redis locally.');
      printWindowsDbSetupHelp();
    } else {
      fail('Docker not available. Install Docker or run DB services manually.');
    }
  }

  const pkgs = [
    { name: 'api', dir: join(servicesDir, 'api') },
    { name: 'worker', dir: join(servicesDir, 'worker') },
    { name: 'frontend', dir: join(servicesDir, 'frontend') },
  ];

  for (const p of pkgs) {
    if (!existsSync(join(p.dir, 'package.json'))) continue;
    if (!skipInstall) {
      log(`Installing dependencies for ${p.name}...`);
      // Use npm ci if lock exists, otherwise npm install
      const hasLock = existsSync(join(p.dir, 'package-lock.json'));
      const args = hasLock ? ['ci'] : ['install'];
      await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: p.dir });
    } else {
      log(`Skipping install for ${p.name}`);
    }
  }

  // Prisma generate for API (client used by API service)
  if (existsSync(join(servicesDir, 'api', 'prisma'))) {
    log('Generating Prisma client (api)...');
    await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', 'generate'], { cwd: join(servicesDir, 'api') });

    if (dbPush) {
      log('Pushing Prisma schema to DB (requires reachable Postgres)...');
      await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', 'db', 'push'], { cwd: join(servicesDir, 'api') });
    }
  }

  log('Local setup complete.');
  log('Next steps:');
  log('- API:      cd services/api && npm run dev');
  log('- Worker:   cd services/worker && npm run dev');
  log('- Frontend: cd services/frontend && npm run dev');
}

async function gatherSelections() {
  const state = {
    mode: '',
    dockerDev: true,
    localSkipInstall: false,
    localDbPush: false,
    localStartDb: false,
  };

  const hasDocker = await commandExists('docker');

  if (!process.stdin.isTTY) {
    if (hasDocker) {
      log('Non-interactive mode: auto-selected Docker workflow (dev profile).');
      state.mode = 'docker';
      state.dockerDev = true;
    } else {
      log('Non-interactive mode: auto-selected Local workflow.');
      state.mode = 'local';
    }
    return state;
  }

  const defaultMode = hasDocker ? 'docker' : 'local';
  const mode = await askChoice(
    'Select setup workflow:',
    [
      { value: 'docker', label: 'Docker (Docker Compose stack for services)', aliases: ['d', 'docker'] },
      { value: 'local', label: 'Local (install Node.js dependencies locally)', aliases: ['l', 'local'] },
    ],
    defaultMode,
  );
  state.mode = mode;
  log(`Selected workflow: ${mode}.`);

  if (mode === 'docker') {
    state.dockerDev = await askYesNo('Include developer containers (api-dev, worker-dev, frontend-dev, bot-dev)?', true);
    log(`Docker dev profile: ${state.dockerDev ? 'enabled' : 'disabled'}.`);
  } else {
    state.localSkipInstall = await askYesNo('Skip Node.js package installation (npm install)?', false);
    state.localStartDb = await askYesNo('Start databases after setup?', false);
    state.localDbPush = await askYesNo('Push Prisma schema to DB after setup?', false);
    log(`npm install: ${state.localSkipInstall ? 'skipped' : 'will run'}.`);
    log(`Start local databases: ${state.localStartDb ? 'yes' : 'no'}.`);
    log(`Prisma db push: ${state.localDbPush ? 'yes' : 'no'}.`);
  }

  return state;
}

async function main() {
  requireInRepo();

  if (process.argv.length > 2) {
    fail('This script is interactive. Run without command-line arguments.');
  }

  const selections = await gatherSelections();
  closeInterface();

  if (selections.mode === 'docker') {
    await setupDocker(!!selections.dockerDev);
  } else if (selections.mode === 'local') {
    await setupLocal({
      skipInstall: selections.localSkipInstall,
      dbPush: selections.localDbPush,
      startDb: selections.localStartDb,
    });
  } else {
    fail(`Unknown mode: ${selections.mode}`);
  }
}

main().catch((e) => fail(e.message || String(e)));

function printWindowsDbSetupHelp() {
  log('Windows without Docker: install Postgres and Redis locally.');
  log('Options:');
  log('- Winget (recommended if available):');
  log('    winget install -e --id PostgreSQL.PostgreSQL');
  log('    winget install -e --id tporadowski.Redis-64');
  log('- Chocolatey (alternative):');
  log('    choco install postgresql redis-64');
  log('After install, ensure services are running and reachable:');
  log('- Postgres: localhost:5432 (user=game pass=gamepass db=game)');
  log('- Redis:    localhost:6379');
  log('Then update .env files to use localhost hosts if needed.');
}
