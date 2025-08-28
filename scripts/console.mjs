#!/usr/bin/env node
// Human-friendly control console for econ-game
// No external deps; uses readline + child_process

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(process.cwd());
const services = {
  dev: ['api-dev', 'worker-dev', 'frontend-dev', 'bot-dev'],
  aux: ['adminer', 'redis-commander'],
  db: ['postgres', 'redis'],
  prod: ['api', 'worker', 'frontend', 'bot'],
};

function sh(cmd, args, opts = {}) {
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: false, ...opts });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolveP() : reject(new Error(`${cmd} ${args.join(' ')} -> ${code}`))));
  });
}

async function dockerCompose(args) {
  try {
    await sh('docker', ['compose', ...args]);
  } catch (e) {
    throw e;
  }
}

function rlPrompt(query) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(query, (ans) => { rl.close(); res(ans); }));
}

async function confirm(msg) {
  const ans = (await rlPrompt(`${msg} [y/N] `)).trim().toLowerCase();
  return ans === 'y' || ans === 'yes';
}

function splitFlags(s) {
  if (!s) return [];
  return s.trim().split(/\s+/);
}

function printIndexed(list) {
  list.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
}

function pickByIndex(list, input, deflt) {
  const sel = input.trim();
  if (!sel) return deflt;
  const idx = sel
    .split(/\s+/)
    .map((x) => Number(x) - 1)
    .filter((i) => Number.isInteger(i) && i >= 0 && i < list.length);
  if (!idx.length) return deflt;
  return idx.map((i) => list[i]);
}

async function waitForPostgres() {
  console.log('[console] Ensuring postgres is up to run SQL...');
  await dockerCompose(['up', '-d', 'postgres']);
  for (let i = 0; i < 20; i++) {
    try {
      await dockerCompose(['exec', '-T', 'postgres', 'pg_isready', '-U', 'game', '-d', 'game']);
      console.log('[console] Postgres is ready.');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.log('[console] Postgres not ready; proceeding anyway (SQL may fail).');
}

async function startDev() {
  // Choose dev apps
  console.log('Select dev apps to start (empty = all dev apps):');
  printIndexed(services.dev);
  const devSel = await rlPrompt('Indices: ');
  const chosenDev = pickByIndex(services.dev, devSel, services.dev);

  // Include DB/Aux
  const includeDb = await confirm('Start DB services (postgres, redis)?');
  const includeAux = await confirm('Start tools (adminer, redis-commander)?');

  // Clean, Build, Pull, Recreate flags
  const clean = await confirm('Clean previous dev containers first?');
  if (clean) {
    try { await dockerCompose(['rm', '-s', '-f', ...chosenDev]); } catch {}
  }
  const withBuild = await confirm('Build before start?');
  const withPull = await confirm('Pull images before start?');
  const recreateAns = (await rlPrompt('Recreate containers? [none/no/force] (default: none): ')).trim().toLowerCase();

  const flags = ['--profile', 'dev', 'up', '-d'];
  if (withBuild) flags.push('--build');
  if (withPull) flags.push('--pull', 'always');
  if (recreateAns === 'no') flags.push('--no-recreate');
  if (recreateAns === 'force') flags.push('--force-recreate');

  // Extra compose flags
  const extra = await rlPrompt('Extra docker compose flags (optional): ');
  const extraFlags = splitFlags(extra);

  const svcList = [];
  if (includeDb) svcList.push(...services.db);
  svcList.push(...chosenDev);
  if (includeAux) svcList.push(...services.aux);

  console.log(`[console] Starting: docker compose ${[...flags, ...extraFlags, ...svcList].join(' ')}`);
  await dockerCompose([...flags, ...extraFlags, ...svcList]);

  if (await confirm('Open URLs (Frontend/API/Adminer/Redis UI)?')) await openUrls();
  if (await confirm('Tail logs now?')) await tailLogs();
}

async function stopDev() {
  // Purge path
  const purge = await confirm('Purge ALL (down -v) and remove data volumes?');
  if (purge) {
    await purgeAll();
    return;
  }

  // Choose dev apps to stop
  console.log('Select dev apps to stop (empty = all dev apps):');
  printIndexed(services.dev);
  const devSel = await rlPrompt('Indices: ');
  const chosenDev = pickByIndex(services.dev, devSel, services.dev);

  const alsoDb = await confirm('Also stop DB and tools (postgres/redis/adminer/redis-commander)?');
  const dropSchema = await confirm("Drop Postgres schema 'dev' as well?");

  console.log(`[console] Removing dev containers: ${chosenDev.join(' ')}`);
  try { await dockerCompose(['rm', '-s', '-f', ...chosenDev]); } catch {}

  if (dropSchema) {
    await waitForPostgres();
    try {
      await dockerCompose(['exec', '-T', 'postgres', 'psql', '-U', 'game', '-d', 'game', '-c', "DROP SCHEMA IF EXISTS dev CASCADE;"]);
    } catch {
      console.log('[console] Failed to drop schema dev (it may not exist).');
    }
  }

  if (alsoDb) {
    try { await dockerCompose(['rm', '-s', '-f', ...services.db, ...services.aux]); } catch {}
  }
}

async function dropDevSchema() {
  console.log('[console] Ensuring postgres is up...');
  await dockerCompose(['up', '-d', 'postgres']);
  console.log('[console] Dropping schema "dev" (if exists)...');
  try {
    await dockerCompose(['exec', '-T', 'postgres', 'psql', '-U', 'game', '-d', 'game', '-c', "DROP SCHEMA IF EXISTS dev CASCADE;"]);
  } catch {
    console.log('[console] Failed to drop schema (it may not exist).');
  }
}

async function purgeAll() {
  const yes = await confirm('Purge ALL (down -v) and remove data volumes?');
  if (!yes) return;
  const rmi = (await rlPrompt('Also remove images? (none/local/all) [none]: ')).trim();
  const args = ['down', '-v', '--remove-orphans'];
  if (rmi === 'local' || rmi === 'all') args.push('--rmi', rmi);
  await dockerCompose(args);
}

async function startProd() {
  await dockerCompose(['--profile', 'prod', 'up', '-d', ...services.db, ...services.prod, ...services.aux]);
}

async function stopProd() {
  await dockerCompose(['rm', '-s', '-f', ...services.prod]);
}

async function status() {
  await dockerCompose(['ps']);
}

async function tailLogs() {
  const opts = [...services.dev, ...services.prod, ...services.db, ...services.aux];
  console.log('Select services to tail (space separated indices):');
  opts.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  const sel = (await rlPrompt('Enter indices (e.g., 1 2 5), empty for dev apps: ')).trim();
  let chosen = services.dev;
  if (sel) {
    const idx = sel.split(/\s+/).map((x) => Number(x) - 1).filter((i) => i >= 0 && i < opts.length);
    chosen = idx.map((i) => opts[i]);
  }
  console.log(`[console] Tailing: ${chosen.join(' ')}`);
  try {
    await dockerCompose(['logs', '-f', ...chosen]);
  } catch {}
}

async function restartServices() {
  const all = [...services.dev, ...services.prod];
  all.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  const sel = (await rlPrompt('Restart which (indices, empty for dev apps): ')).trim();
  let chosen = services.dev;
  if (sel) {
    const idx = sel.split(/\s+/).map((x) => Number(x) - 1).filter((i) => i >= 0 && i < all.length);
    chosen = idx.map((i) => all[i]);
  }
  await dockerCompose(['restart', ...chosen]);
}

async function buildService() {
  const all = [...services.prod, ...services.dev];
  all.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  const sel = (await rlPrompt('Build which (indices, empty for all prod+dev): ')).trim();
  let chosen = all;
  if (sel) {
    const idx = sel.split(/\s+/).map((x) => Number(x) - 1).filter((i) => i >= 0 && i < all.length);
    chosen = idx.map((i) => all[i]);
  }
  await dockerCompose(['build', ...chosen]);
}

async function execShell() {
  const all = [...services.dev, ...services.prod, ...services.db, ...services.aux];
  all.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  const i = Number((await rlPrompt('Exec shell into which (index): ')).trim()) - 1;
  if (isNaN(i) || i < 0 || i >= all.length) return;
  const svc = all[i];
  const shell = await rlPrompt('Shell [sh/bash]: ');
  const chosen = shell.trim() || 'sh';
  await dockerCompose(['exec', '-it', svc, chosen]);
}

async function openUrls() {
  const urls = [
    { name: 'Frontend', url: 'http://localhost:3000' },
    { name: 'API Docs', url: 'http://localhost:4000/docs' },
    { name: 'Adminer', url: 'http://localhost:8080' },
    { name: 'Redis Commander', url: 'http://localhost:8081' },
  ];
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  for (const u of urls) {
    console.log(`[console] Opening: ${u.name} -> ${u.url}`);
    if (opener === 'cmd') await sh(opener, ['/c', 'start', u.url]);
    else await sh(opener, [u.url]);
  }
}

async function printMenu() {
  console.log('\n=== Econ Game Console ===');
  console.log('1) Start Dev');
  console.log('2) Stop Dev (with optional schema drop/purge)');
  console.log('3) Drop Dev DB Schema');
  console.log('4) Purge All (down -v)');
  console.log('5) Status (compose ps)');
  console.log('6) Tail Logs');
  console.log('7) Restart Services');
  console.log('8) Build Services');
  console.log('9) Exec Shell in Container');
  console.log('10) Open URLs (Frontend/API/Adminer/Redis UI)');
  console.log('11) Start Prod');
  console.log('12) Stop Prod');
  console.log('0) Quit');
}

async function main() {
  if (!existsSync(join(root, 'docker-compose.yml'))) {
    console.error('[console] Please run from repo root (missing docker-compose.yml).');
    process.exit(1);
  }
  for (;;) {
    await printMenu();
    const ans = (await rlPrompt('Select: ')).trim();
    try {
      if (ans === '1') await startDev();
      else if (ans === '2') await stopDev();
      else if (ans === '3') await dropDevSchema();
      else if (ans === '4') await purgeAll();
      else if (ans === '5') await status();
      else if (ans === '6') await tailLogs();
      else if (ans === '7') await restartServices();
      else if (ans === '8') await buildService();
      else if (ans === '9') await execShell();
      else if (ans === '10') await openUrls();
      else if (ans === '11') await startProd();
      else if (ans === '12') await stopProd();
      else if (ans === '0') break;
    } catch (e) {
      console.error('[console] Error:', e.message || e);
    }
  }
}

main();
