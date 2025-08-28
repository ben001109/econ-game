#!/usr/bin/env node
// Cross-platform setup script for econ-game
// Usage examples:
//   node scripts/setup.mjs --docker
//   node scripts/setup.mjs --docker --dev
//   node scripts/setup.mjs --local
//   node scripts/setup.mjs --local --db-push
//   node scripts/setup.mjs --local --start-db

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const servicesDir = join(root, 'services');

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`[warn] ${msg}\n`);
}

function fail(msg, code = 1) {
  process.stderr.write(`[error] ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { mode: null, dev: false, dbPush: false, startDb: false, skipInstall: false, verbose: false, installDb: false };
  for (const a of argv.slice(2)) {
    if (a === '--docker') args.mode = 'docker';
    else if (a === '--local') args.mode = 'local';
    else if (a === '--dev') args.dev = true;
    else if (a === '--db-push') args.dbPush = true;
    else if (a === '--start-db') args.startDb = true;
    else if (a === '--install-db') args.installDb = true;
    else if (a === '--skip-install') args.skipInstall = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a.startsWith('--mode=')) args.mode = a.split('=')[1];
    else if (a === '-m') {
      // next item is the mode (not implemented for brevity)
    }
  }
  return args;
}

async function commandExists(cmd) {
  const shell = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [cmd] : ['-v', cmd];
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
    log('Starting dev profile containers (api-dev, worker-dev, frontend-dev, dbs)...');
    await dockerCompose(['--profile', 'dev', 'up', '--build', '-d', 'postgres', 'redis', 'api-dev', 'worker-dev', 'frontend-dev', 'adminer', 'redis-commander']);
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

function printHelp() {
  log(`econ-game setup

Options:
  --docker            Build and start Docker stack
  --docker --dev      Use dev profile (hot reload api/worker/frontend)
  --local             Install Node deps and generate Prisma
  --local --start-db  Start Postgres+Redis with Docker (for local dev)
  --local --db-push   Run Prisma db push (DB must be reachable)
  --install-db        (Windows) Attempt to guide DB installation
  --skip-install      Skip npm install steps (local mode)
  --verbose           Reserved (no-op)

Examples:
  node scripts/setup.mjs --docker
  node scripts/setup.mjs --docker --dev
  node scripts/setup.mjs --local --start-db
  node scripts/setup.mjs --local --db-push
`);
}

async function main() {
  requireInRepo();
  const args = parseArgs(process.argv);
  if (args.installDb && process.platform === 'win32') {
    printWindowsDbSetupHelp();
    return;
  }
  // Auto-pick mode if not provided: prefer Docker dev if available
  if (!args.mode) {
    const hasDocker = await commandExists('docker');
    if (hasDocker) {
      log('No mode specified. Detected Docker; using --docker --dev.');
      args.mode = 'docker';
      args.dev = true;
    } else {
      log('No mode specified. Docker not found; using --local.');
      args.mode = 'local';
    }
  }

  if (args.mode === 'docker') {
    await setupDocker(!!args.dev);
  } else if (args.mode === 'local') {
    await setupLocal({ skipInstall: args.skipInstall, dbPush: args.dbPush, startDb: args.startDb });
  } else {
    fail(`Unknown mode: ${args.mode}`);
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
