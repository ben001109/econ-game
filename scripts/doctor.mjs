#!/usr/bin/env node
// Doctor: check OS, Node, Docker, and DB/Redis availability

import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function log(msg) { process.stdout.write(msg + '\n'); }
function warn(msg) { process.stderr.write('[warn] ' + msg + '\n'); }

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore', shell: false, ...opts });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(true) : resolve(false)));
  });
}

async function exists(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [cmd] : ['-v', cmd];
  try { return await run(probe, args); } catch { return false; }
}

function getRequiredNode() {
  const p = join(process.cwd(), '.nvmrc');
  if (!existsSync(p)) return 20;
  const raw = readFileSync(p, 'utf8').trim();
  const major = Number(raw.replace(/^v/, ''));
  return Number.isFinite(major) ? major : 20;
}

function checkPort(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const to = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.once('connect', () => { clearTimeout(to); s.end(); resolve(true); });
    s.once('error', () => { clearTimeout(to); resolve(false); });
  });
}

async function main() {
  log('== econ-game doctor ==');
  log(`OS: ${process.platform}`);
  log(`Node: ${process.version}`);

  const requiredNode = getRequiredNode();
  const currentMajor = Number(process.versions.node.split('.')[0]);
  if (currentMajor < requiredNode) warn(`Node ${requiredNode}+ recommended.`);

  const hasDocker = await exists('docker');
  const hasCompose = hasDocker && (await run('docker', ['compose', 'version']));
  const hasDockerComposeLegacy = await exists('docker-compose');
  log(`Docker: ${hasDocker ? 'yes' : 'no'}`);
  log(`Docker compose: ${hasCompose || hasDockerComposeLegacy ? 'yes' : 'no'}`);

  if (process.platform === 'win32') {
    const hasWinget = await exists('winget');
    const hasChoco = await exists('choco');
    log(`winget: ${hasWinget ? 'yes' : 'no'}`);
    log(`choco: ${hasChoco ? 'yes' : 'no'}`);
  }

  const pgLocal = await checkPort('127.0.0.1', 5432);
  const redisLocal = await checkPort('127.0.0.1', 6379);
  log(`Postgres @ localhost:5432 reachable: ${pgLocal ? 'yes' : 'no'}`);
  log(`Redis    @ localhost:6379 reachable: ${redisLocal ? 'yes' : 'no'}`);

  if (!hasDocker && (!pgLocal || !redisLocal)) {
    warn('No Docker detected and local DB/Redis not reachable.');
    if (process.platform === 'win32') {
      log('Install via winget:');
      log('  winget install -e --id PostgreSQL.PostgreSQL');
      log('  winget install -e --id tporadowski.Redis-64');
    } else if (process.platform === 'darwin') {
      log('Install via Homebrew:');
      log('  brew install postgresql@16 redis');
      log('  brew services start postgresql@16');
      log('  brew services start redis');
    } else {
      log('Install via your distro package manager (apt/yum/pacman).');
    }
  }

  log('Doctor check complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });

