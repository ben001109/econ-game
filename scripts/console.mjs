#!/usr/bin/env node
// Human-friendly control console for econ-game
// No external deps; uses readline + child_process

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const root = resolve(process.cwd());
const CONFIG_PATH = join(root, '.econ-console.json');
const services = {
  dev: ['api-dev', 'worker-dev', 'frontend-dev', 'bot-dev'],
  aux: ['adminer', 'redis-commander'],
  db: ['postgres', 'redis'],
  prod: ['api', 'worker', 'frontend', 'bot'],
};

// --- i18n ---------------------------------------------------------------
const I18N = {
  en: {
    menu_header: '=== Econ Game Console ===',
    menu_1: 'Start Dev',
    menu_2: 'Stop Dev',
    menu_3: 'Drop Dev DB Schema',
    menu_4: 'Purge Dev Only (remove dev containers + drop dev schema)',
    menu_5: 'Full Purge (ALL, down -v)',
    menu_6: 'Status (compose ps)',
    menu_7: 'Tail Logs',
    menu_8: 'Restart Services',
    menu_9: 'Build Services',
    menu_10: 'Exec Shell in Container',
    menu_11: 'Open URLs (Frontend/API/Adminer/Redis UI)',
    menu_12: 'Start Prod',
    menu_13: 'Stop Prod',
    menu_14: 'Change Language',
    select: 'Select: ',
    clean_first: 'Clean previous dev containers first?',
    start_db: 'Start DB services (postgres, redis)?',
    start_tools: 'Start tools (adminer, redis-commander)?',
    build_before: 'Build before start?',
    pull_before: 'Pull images before start?',
    recreate_question: 'Recreate containers? [none/no/force] (default: none): ',
    extra_flags: 'Extra docker compose flags (optional): ',
    select_dev_start: 'Select dev apps to start (empty = all dev apps):',
    select_dev_stop: 'Select dev apps to stop (empty = all dev apps):',
    indices: 'Indices: ',
    include_db_stop: 'Also stop DB and tools (postgres/redis/adminer/redis-commander)?',
    drop_schema_question: "Drop Postgres schema 'dev' as well?",
    drop_anon_vols: "Remove dev containers' anonymous volumes (-v)?",
    ensuring_pg: 'Ensuring postgres is up to run SQL...',
    pg_ready: 'Postgres is ready.',
    pg_not_ready: 'Postgres not ready; proceeding anyway (SQL may fail).',
    starting_cmd_prefix: 'Starting: docker compose ',
    removing_dev: 'Removing dev containers: ',
    failed_drop_schema: 'Failed to drop schema dev (it may not exist).',
    dev_purge_complete: 'Dev purge complete.',
    opening: 'Opening',
    purge_all_confirm: 'Purge ALL (down -v) and remove data volumes?',
    remove_images_question: 'Also remove images? (none/local/all) [none]: ',
    purge_dev_only_intro: 'Purge Dev Only: remove dev containers + drop dev schema (keeps named volumes).',
    proceed_question: 'Proceed?',
    exec_which: 'Exec shell into which (index): ',
    shell_prompt: 'Shell [sh/bash]: ',
    tail_select: 'Select services to tail (space separated indices):',
    tail_enter: 'Enter indices (e.g., 1 2 5), empty for dev apps: ',
    tailing: 'Tailing: ',
    error_prefix: 'Error:',
    lang_prompt: 'Choose language: [1] English, [2] 繁體中文 (default based on locale): ',
    lang_changed: 'Language changed to',
  },
  zh: {
    menu_header: '=== 經濟遊戲 控制台 ===',
    menu_1: '啟動開發服務',
    menu_2: '停止開發服務',
    menu_3: '丟棄 Dev 資料表 (schema=dev)',
    menu_4: '只清開發（移除 dev 容器 + 丟棄 dev schema）',
    menu_5: '真全清（全部 down -v）',
    menu_6: '查看狀態 (compose ps)',
    menu_7: '追蹤日誌',
    menu_8: '重啟服務',
    menu_9: '重建映像 (build)',
    menu_10: '進入容器 Shell',
    menu_11: '開啟網址（前端/API/Adminer/Redis UI）',
    menu_12: '啟動正式服務',
    menu_13: '停止正式服務',
    menu_14: '切換語言',
    select: '請選擇：',
    clean_first: '啟動前先清除舊的 dev 容器？',
    start_db: '要一併啟動資料庫服務（postgres、redis）嗎？',
    start_tools: '要一併啟動工具（adminer、redis-commander）嗎？',
    build_before: '啟動前要先 build 嗎？',
    pull_before: '啟動前要先 pull 映像嗎？',
    recreate_question: '要重建容器嗎？[none/no/force]（預設：none）：',
    extra_flags: '額外 docker compose 旗標（可留空）：',
    select_dev_start: '選擇要啟動的 dev 服務（空白＝全部）：',
    select_dev_stop: '選擇要停止的 dev 服務（空白＝全部）：',
    indices: '輸入編號：',
    include_db_stop: '是否同時停止 DB/工具（postgres/redis/adminer/redis-commander）？',
    drop_schema_question: '同時丟棄 Postgres 的 dev schema？',
    drop_anon_vols: '是否一併移除 dev 容器的匿名 volumes（-v）？',
    ensuring_pg: '正在確保 Postgres 可用，準備執行 SQL…',
    pg_ready: 'Postgres 已就緒。',
    pg_not_ready: 'Postgres 尚未就緒，仍繼續（SQL 可能會失敗）。',
    starting_cmd_prefix: '啟動：docker compose ',
    removing_dev: '移除 dev 容器：',
    failed_drop_schema: '丟棄 dev schema 失敗（可能不存在）。',
    dev_purge_complete: '開發環境清理完成。',
    opening: '開啟',
    purge_all_confirm: '真全清（down -v）並刪除資料卷？',
    remove_images_question: '同時刪除映像？（none/local/all）[none]：',
    purge_dev_only_intro: '只清開發：移除 dev 容器 + 丟棄 dev schema（保留命名卷）。',
    proceed_question: '是否繼續？',
    exec_which: '要進入哪一個容器（輸入編號）：',
    shell_prompt: '使用 Shell（sh/bash）：',
    tail_select: '選擇要追蹤的服務（以空白分隔）：',
    tail_enter: '輸入編號（例如 1 2 5），空白＝dev 服務：',
    tailing: '追蹤：',
    error_prefix: '錯誤：',
    lang_prompt: '選擇語言：[1] English, [2] 繁體中文（依環境預設）：',
    lang_changed: '語言已切換為',
  },
};

function detectDefaultLang() {
  const envLang = process.env.ECON_LANG || process.env.LANG || '';
  return /zh/i.test(envLang) ? 'zh' : 'en';
}

function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      if (raw && (raw.lang === 'en' || raw.lang === 'zh')) return raw;
    } catch {}
  }
  return { lang: detectDefaultLang() };
}

function saveConfig(cfg) {
  try { writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch {}
}

let CONFIG = loadConfig();
let LANG = CONFIG.lang;
function t(key) {
  const pack = I18N[LANG] || I18N.en;
  return pack[key] || I18N.en[key] || key;
}

async function changeLanguage() {
  const ans = (await rlPrompt(t('lang_prompt'))).trim();
  let chosen = LANG;
  if (ans === '1') chosen = 'en';
  else if (ans === '2' || ans === '') chosen = 'zh';
  LANG = chosen;
  CONFIG.lang = LANG;
  saveConfig(CONFIG);
  console.log(t('lang_changed'), LANG);
}

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
  return (
    ans === 'y' ||
    ans === 'yes' ||
    ans === '1' ||
    ans === 'true' ||
    ans === 'ok' ||
    ans === '是' ||
    ans === '好'
  );
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
  console.log('[console]', t('ensuring_pg'));
  await dockerCompose(['up', '-d', 'postgres']);
  for (let i = 0; i < 20; i++) {
    try {
      await dockerCompose(['exec', '-T', 'postgres', 'pg_isready', '-U', 'game', '-d', 'game']);
      console.log('[console]', t('pg_ready'));
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.log('[console]', t('pg_not_ready'));
}

async function startDev() {
  // Choose dev apps
  console.log(t('select_dev_start'));
  printIndexed(services.dev);
  const devSel = await rlPrompt(t('indices'));
  const chosenDev = pickByIndex(services.dev, devSel, services.dev);

  // Include DB/Aux
  const includeDb = await confirm(t('start_db'));
  const includeAux = await confirm(t('start_tools'));

  // Clean, Build, Pull, Recreate flags
  const clean = await confirm(t('clean_first'));
  if (clean) {
    try { await dockerCompose(['rm', '-s', '-f', ...chosenDev]); } catch {}
  }
  const withBuild = await confirm(t('build_before'));
  const withPull = await confirm(t('pull_before'));
  const recreateAns = (await rlPrompt(t('recreate_question'))).trim().toLowerCase();

  const flags = ['--profile', 'dev', 'up', '-d'];
  if (withBuild) flags.push('--build');
  if (withPull) flags.push('--pull', 'always');
  if (recreateAns === 'no') flags.push('--no-recreate');
  if (recreateAns === 'force') flags.push('--force-recreate');

  // Extra compose flags
  const extra = await rlPrompt(t('extra_flags'));
  const extraFlags = splitFlags(extra);

  const svcList = [];
  if (includeDb) svcList.push(...services.db);
  svcList.push(...chosenDev);
  if (includeAux) svcList.push(...services.aux);

  console.log('[console]', t('starting_cmd_prefix') + [...flags, ...extraFlags, ...svcList].join(' '));
  await dockerCompose([...flags, ...extraFlags, ...svcList]);

  if (await confirm(t('menu_11'))) await openUrls();
  if (await confirm(t('menu_7'))) await tailLogs();
}

async function stopDev() {
  // Choose dev apps to stop
  console.log(t('select_dev_stop'));
  printIndexed(services.dev);
  const devSel = await rlPrompt(t('indices'));
  const chosenDev = pickByIndex(services.dev, devSel, services.dev);

  const alsoDb = await confirm(t('include_db_stop'));
  const dropSchema = await confirm(t('drop_schema_question'));
  const dropAnonVolumes = await confirm(t('drop_anon_vols'));

  console.log('[console]', t('removing_dev') + chosenDev.join(' '));
  try {
    const args = ['rm', '-s', '-f'];
    if (dropAnonVolumes) args.push('-v');
    await dockerCompose([...args, ...chosenDev]);
  } catch {}

  if (dropSchema) {
    await waitForPostgres();
    try {
      await dockerCompose(['exec', '-T', 'postgres', 'psql', '-U', 'game', '-d', 'game', '-c', "DROP SCHEMA IF EXISTS dev CASCADE;"]);
    } catch {
      console.log('[console]', t('failed_drop_schema'));
    }
  }

  if (alsoDb) {
    try { await dockerCompose(['rm', '-s', '-f', ...services.db, ...services.aux]); } catch {}
  }
}

async function dropDevSchema() {
  console.log('[console]', t('ensuring_pg'));
  await dockerCompose(['up', '-d', 'postgres']);
  console.log('[console] Dropping schema "dev" (if exists)...');
  try {
    await dockerCompose(['exec', '-T', 'postgres', 'psql', '-U', 'game', '-d', 'game', '-c', "DROP SCHEMA IF EXISTS dev CASCADE;"]);
  } catch {
    console.log('[console]', t('failed_drop_schema'));
  }
}

async function purgeAll() {
  const yes = await confirm(t('purge_all_confirm'));
  if (!yes) return;
  const rmi = (await rlPrompt(t('remove_images_question'))).trim();
  const args = ['down', '-v', '--remove-orphans'];
  if (rmi === 'local' || rmi === 'all') args.push('--rmi', rmi);
  await dockerCompose(args);
}

async function purgeDevOnly() {
  console.log('[console]', t('purge_dev_only_intro'));
  const yes = await confirm(t('proceed_question'));
  if (!yes) return;
  try {
    await dockerCompose(['rm', '-s', '-f', '-v', ...services.dev]);
  } catch {}
  await waitForPostgres();
  try {
    await dockerCompose(['exec', '-T', 'postgres', 'psql', '-U', 'game', '-d', 'game', '-c', "DROP SCHEMA IF EXISTS dev CASCADE;"]);
  } catch {
    console.log('[console]', t('failed_drop_schema'));
  }
  console.log('[console]', t('dev_purge_complete'));
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
  console.log(t('tail_select'));
  opts.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  const sel = (await rlPrompt(t('tail_enter'))).trim();
  let chosen = services.dev;
  if (sel) {
    const idx = sel.split(/\s+/).map((x) => Number(x) - 1).filter((i) => i >= 0 && i < opts.length);
    chosen = idx.map((i) => opts[i]);
  }
  console.log('[console]', t('tailing') + chosen.join(' '));
  try {
    await dockerCompose(['logs', '-f', ...chosen]);
  } catch {}
}

async function restartServices() {
  const all = [...services.dev, ...services.prod];
  all.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  const sel = (await rlPrompt(LANG === 'zh' ? '要重啟哪些服務（輸入編號，空白＝dev）：' : 'Restart which (indices, empty for dev apps): ')).trim();
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
  const sel = (await rlPrompt(LANG === 'zh' ? '要 build 哪些服務（輸入編號，空白＝全部）：' : 'Build which (indices, empty for all prod+dev): ')).trim();
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
  const i = Number((await rlPrompt(t('exec_which'))).trim()) - 1;
  if (isNaN(i) || i < 0 || i >= all.length) return;
  const svc = all[i];
  const shell = await rlPrompt(t('shell_prompt'));
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
    console.log(`[console] ${t('opening')}: ${u.name} -> ${u.url}`);
    if (opener === 'cmd') await sh(opener, ['/c', 'start', u.url]);
    else await sh(opener, [u.url]);
  }
}

async function printMenu() {
  console.log(`\n${t('menu_header')}`);
  console.log(`1) ${t('menu_1')}`);
  console.log(`2) ${t('menu_2')}`);
  console.log(`3) ${t('menu_3')}`);
  console.log(`4) ${t('menu_4')}`);
  console.log(`5) ${t('menu_5')}`);
  console.log(`6) ${t('menu_6')}`);
  console.log(`7) ${t('menu_7')}`);
  console.log(`8) ${t('menu_8')}`);
  console.log(`9) ${t('menu_9')}`);
  console.log(`10) ${t('menu_10')}`);
  console.log(`11) ${t('menu_11')}`);
  console.log(`12) ${t('menu_12')}`);
  console.log(`13) ${t('menu_13')}`);
  console.log(`14) ${t('menu_14')}`);
  console.log('0) Quit');
}

async function main() {
  if (!existsSync(join(root, 'docker-compose.yml'))) {
    console.error('[console] Please run from repo root (missing docker-compose.yml).');
    process.exit(1);
  }
  for (;;) {
    await printMenu();
    const ans = (await rlPrompt(t('select'))).trim();
    try {
      if (ans === '1') await startDev();
      else if (ans === '2') await stopDev();
      else if (ans === '3') await dropDevSchema();
      else if (ans === '4') await purgeDevOnly();
      else if (ans === '5') await purgeAll();
      else if (ans === '6') await status();
      else if (ans === '7') await tailLogs();
      else if (ans === '8') await restartServices();
      else if (ans === '9') await buildService();
      else if (ans === '10') await execShell();
      else if (ans === '11') await openUrls();
      else if (ans === '12') await startProd();
      else if (ans === '13') await stopProd();
      else if (ans === '14') await changeLanguage();
      else if (ans === '0') break;
    } catch (e) {
      console.error('[console]', t('error_prefix'), e.message || e);
    }
  }
}

main();
