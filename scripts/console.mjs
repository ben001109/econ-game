#!/usr/bin/env node
// Human-friendly control console for econ-game
// No external deps; uses readline + child_process

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, join, basename, relative } from 'node:path';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';

const root = resolve(process.cwd());
const CONFIG_PATH = join(root, '.econ-console.json');
const services = {
  dev: ['api-dev', 'worker-dev', 'frontend-dev', 'bot-dev'],
  aux: ['adminer', 'redis-commander'],
  db: ['postgres', 'redis'],
  prod: ['api', 'worker', 'frontend', 'bot'],
  bun: ['api-bun', 'worker-bun', 'frontend-bun', 'bot-bun'],
};

const ENV_GROUPS = [
  {
    dir: join(root, 'services', 'api'),
    files: ['.env', '.env.local'],
    example: '.env.example',
  },
  {
    dir: join(root, 'services', 'worker'),
    files: ['.env', '.env.local'],
    example: '.env.example',
  },
  {
    dir: join(root, 'services', 'frontend'),
    files: ['.env', '.env.local'],
    example: '.env.example',
  },
  {
    dir: join(root, 'services', 'bot'),
    files: ['.env.local'],
    example: '.env.example',
  },
];

// --- i18n ---------------------------------------------------------------
const I18N = {
  en: {
    menu_header: '=== Econ Game Console ===',
    // consolidated service + clean submenus
    menu_services: 'Services (start/stop/restart/rebuild)',
    menu_clean: 'Clean (consolidated options)',
    menu_6: 'Status (compose ps)',
    menu_7: 'Tail Logs',
    menu_8: 'Restart Services',
    menu_9: 'Build Services',
    menu_10: 'Exec Shell in Container',
    menu_11: 'Open URLs (Frontend/API/Adminer/Redis UI)',
    menu_12: 'Start Prod',
    menu_13: 'Stop Prod',
    menu_14: 'Change Language',
    menu_15: 'Quick Restart Dev',
    menu_16: 'Quick Restart Prod',
    menu_17: 'Quick Restart Dev + Tail',
    menu_18: 'Quick Restart Prod + Tail',
    select_prod_start: 'Select prod apps to start (empty = all prod apps):',
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
    purge_all_confirm: 'Proceed to Full Purge?',
    purge_all_mode_header: 'Full Clean Options:',
    purge_all_volumes: 'Remove volumes? [1] No, [2] Yes (-v) [2]: ',
    purge_all_images: 'Remove images? [1] none, [2] local, [3] all [1]: ',
    purge_dev_only_intro: 'Purge Dev Only: remove dev containers + drop dev schema (keeps named volumes).',
    proceed_question: 'Proceed?',
    exec_which: 'Exec shell into which (index): ',
    shell_prompt: 'Shell [sh/bash]: ',
    tail_select: 'Select services to tail (space separated indices):',
    tail_enter: 'Enter indices (e.g., 1 2 5), empty for dev apps: ',
    tailing: 'Tailing: ',
    tail_quit_hint: "Press 'q' to quit tail",
    error_prefix: 'Error:',
    lang_prompt: 'Choose language: [1] English, [2] 繁體中文 (default based on locale): ',
    lang_changed: 'Language changed to',
    // DB removal prompts
    db_also_remove_containers: 'Also remove DB containers (postgres/redis/adminer/redis-commander)?',
    db_also_remove_volumes: 'Also remove DB named volumes (-v)?',
    // Services submenu
    services_header: '=== Service Ops ===',
    services_opt_1: 'Start',
    services_opt_2: 'Stop',
    services_opt_3: 'Restart',
    services_opt_4: 'Rebuild',
    services_opt_5: 'Quick Restart (Dev)',
    services_opt_6: 'Quick Restart (Prod)',
    services_select: 'Choose (1-6, 0=back): ',
    services_scope: 'Scope: [1] Dev, [2] Prod, [3] Bun, [4] Pick dev services [1]: ',
    // Build flags
    build_no_cache: 'Rebuild without cache?',
    build_pull_base: 'Pull base images before build?',
    // Clean submenu
    clean_header: '=== Clean Menu ===',
    clean_opt_1: 'Purge Dev Only (remove dev containers + drop dev schema)',
    clean_opt_2: 'Full Clean: containers only (compose down)',
    clean_opt_3: 'Full Clean: containers + volumes (down -v)',
    clean_opt_4: 'Full Clean: containers + volumes + images (local)',
    clean_opt_5: 'Full Clean: containers + volumes + images (all)',
    clean_opt_6: 'Docker System Prune (global: images/containers/networks/volumes)',
    clean_opt_7: 'Clear ./logs folder (local host files)',
    clean_select: 'Choose (1-7, 0=back): ',
    system_prune_confirm: 'Prune ALL Docker resources on this machine? (global)',
    clear_logs_confirm: 'Delete all files under ./logs on host?',
    logs_cleared: 'Logs folder cleared.',
    logs_missing: 'Logs folder not found; nothing to do.',
  },
  zh: {
    menu_header: '=== 經濟遊戲 控制台 ===',
    // consolidated service + clean submenus
    menu_services: '服務操作（開啟/關閉/重啟/重建）',
    menu_clean: '清理（整合所有清理選項）',
    menu_6: '查看狀態 (compose ps)',
    menu_7: '追蹤日誌',
    menu_8: '重啟服務',
    menu_9: '重建映像 (build)',
    menu_10: '進入容器 Shell',
    menu_11: '開啟網址（前端/API/Adminer/Redis UI）',
    menu_12: '啟動正式服務',
    menu_13: '停止正式服務',
    menu_14: '切換語言',
    menu_15: '快速重啟（開發服務）',
    menu_16: '快速重啟（正式服務）',
    menu_17: '快速重啟（開發）並追蹤',
    menu_18: '快速重啟（正式）並追蹤',
    select_prod_start: '選擇要啟動的正式服務（空白＝全部）：',
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
    purge_all_confirm: '要執行真全清嗎？',
    purge_all_mode_header: '全清選項：',
    purge_all_volumes: '是否刪除 volumes？[1] 否、[2] 是 (-v) [2]：',
    purge_all_images: '是否刪除映像？[1] 不刪、[2] local、[3] all [1]：',
    purge_dev_only_intro: '只清開發：移除 dev 容器 + 丟棄 dev schema（保留命名卷）。',
    proceed_question: '是否繼續？',
    exec_which: '要進入哪一個容器（輸入編號）：',
    shell_prompt: '使用 Shell（sh/bash）：',
    tail_select: '選擇要追蹤的服務（以空白分隔）：',
    tail_enter: '輸入編號（例如 1 2 5），空白＝dev 服務：',
    tailing: '追蹤：',
    tail_quit_hint: "按 'q' 退出追蹤",
    error_prefix: '錯誤：',
    lang_prompt: '選擇語言：[1] English, [2] 繁體中文（依環境預設）：',
    lang_changed: '語言已切換為',
    // DB removal prompts
    db_also_remove_containers: '是否同時移除資料庫與工具容器（postgres/redis/adminer/redis-commander）？',
    db_also_remove_volumes: '是否同時刪除資料庫命名卷（-v）？',
    // Services submenu
    services_header: '=== 服務操作 ===',
    services_opt_1: '啟動',
    services_opt_2: '停止',
    services_opt_3: '重啟',
    services_opt_4: '重建',
    services_opt_5: '快速重啟（開發）',
    services_opt_6: '快速重啟（正式）',
    services_select: '請選擇（1-6，0 返回）：',
    services_scope: '操作範圍：[1] 開發、[2] 正式、[3] Bun、[4] 自選（Dev） [1]：',
    // Build flags
    build_no_cache: '重建時不使用快取？',
    build_pull_base: '重建前先拉取基底映像？',
    // Clean submenu
    clean_header: '=== 清理選單 ===',
    clean_opt_1: '只清開發（移除 dev 容器 + 丟棄 dev schema）',
    clean_opt_2: '真全清：僅容器（compose down）',
    clean_opt_3: '真全清：容器 + 卷（down -v）',
    clean_opt_4: '真全清：容器 + 卷 + 映像（local）',
    clean_opt_5: '真全清：容器 + 卷 + 映像（all）',
    clean_opt_6: 'Docker 系統清理（全域：映像/容器/網路/卷）',
    clean_opt_7: '清空本機 logs 資料夾（./logs）',
    clean_select: '請選擇（1-7，0 返回）：',
    system_prune_confirm: '這會清理此機器上所有 Docker 資源（全域）。是否繼續？',
    clear_logs_confirm: '要刪除 ./logs 內所有檔案嗎？',
    logs_cleared: '已清空 logs 資料夾。',
    logs_missing: '找不到 logs 資料夾，無需處理。',
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

function ensureEnvFiles() {
  const created = [];
  for (const group of ENV_GROUPS) {
    const absFiles = group.files.map((name) => join(group.dir, name));
    if (!absFiles.length) continue;
    const existing = absFiles.filter((p) => existsSync(p));
    let primary = existing[0];
    if (!primary) {
      const examplePath = group.example ? join(group.dir, group.example) : null;
      let seed = '# Auto-generated env file\n';
      if (examplePath && existsSync(examplePath)) {
        try {
          seed = readFileSync(examplePath, 'utf8');
        } catch {}
      }
      try {
        writeFileSync(absFiles[0], seed);
        primary = absFiles[0];
        created.push(relative(root, absFiles[0]));
      } catch {}
    }
    if (!primary) continue;
    for (const abs of absFiles) {
      if (existsSync(abs)) continue;
      const stub = `# Auto-generated stub by console.mjs\n# Actual values in ${basename(primary)}\n`;
      try {
        writeFileSync(abs, stub);
        created.push(relative(root, abs));
      } catch {}
    }
  }
  if (created.length) {
    console.log('[console] Ensured env files:', created.join(', '));
  }
}

function getProjectName() {
  return process.env.COMPOSE_PROJECT_NAME || basename(root);
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

function runCapture(cmd, args, opts = {}) {
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, ...opts });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolveP(out) : reject(new Error(err || `${cmd} ${args.join(' ')} -> ${code}`))));
  });
}

async function dockerCompose(args) {
  try {
    await sh('docker', ['compose', ...args]);
  } catch (e) {
    throw e;
  }
}

function followLogs(services) {
  return new Promise((resolve) => {
    const child = spawn('docker', ['compose', 'logs', '-f', ...services], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    const onKey = (buf) => {
      const s = buf.toString();
      if (s === 'q' || s === 'Q') {
        child.kill('SIGINT');
      }
    };

    const stdin = process.stdin;
    const hadRaw = stdin.isTTY && stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);

    child.on('close', () => {
      stdin.off('data', onKey);
      if (stdin.isTTY) stdin.setRawMode(Boolean(hadRaw));
      resolve();
    });
    child.on('error', () => {
      stdin.off('data', onKey);
      if (stdin.isTTY) stdin.setRawMode(Boolean(hadRaw));
      resolve();
    });
  });
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
    let dbArgs = ['rm', '-s', '-f'];
    try {
      const rmDbVol = await confirm(t('db_also_remove_volumes'));
      if (rmDbVol) dbArgs.push('-v');
    } catch {}
    try { await dockerCompose([...dbArgs, ...services.db, ...services.aux]); } catch {}
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
  // Optionally remove DB containers and volumes
  const rmDb = await confirm(t('db_also_remove_containers'));
  if (rmDb) {
    const rmDbVol = await confirm(t('db_also_remove_volumes'));
    const args = ['rm', '-s', '-f'];
    if (rmDbVol) args.push('-v');
    try { await dockerCompose([...args, ...services.db, ...services.aux]); } catch {}
  }
}

async function purgeAll(mode) {
  // mode: 2=down, 3=down -v, 4=down -v --rmi local, 5=down -v --rmi all
  const yes = await confirm(t('proceed_question'));
  if (!yes) return;
  const args = ['down', '--remove-orphans'];
  if (mode >= 3) args.push('-v');
  if (mode === 4) args.push('--rmi', 'local');
  if (mode === 5) args.push('--rmi', 'all');
  await dockerCompose(args);

  // Extra cleanup to ensure nothing leftover
  const project = getProjectName();

  // Ensure any leftover containers with compose project label are removed
  try {
    const contOut = await runCapture('docker', ['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${project}`]);
    const conts = contOut.split('\n').map((s) => s.trim()).filter(Boolean);
    if (conts.length) await sh('docker', ['rm', '-f', ...conts]);
  } catch {}

  // Ensure project volumes (with compose labels) are removed
  if (mode >= 3) {
    try {
      const volOut = await runCapture('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]);
      const vols = volOut.split('\n').map((s) => s.trim()).filter(Boolean);
      if (vols.length) await sh('docker', ['volume', 'rm', '-f', ...vols]);
    } catch {}
  }

  // Ensure images are removed
  if (mode >= 4) {
    try {
      // Remove images labeled to this compose project
      const labeled = await runCapture('docker', ['image', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]);
      const byLabel = labeled.split('\n').map((s) => s.trim()).filter(Boolean);
      // Also attempt by name pattern <project>-<service>
      const ref = await runCapture('docker', ['image', 'ls', '-q', '--filter', `reference=${project}-*`]);
      const byRef = ref.split('\n').map((s) => s.trim()).filter(Boolean);
      const imgs = Array.from(new Set([...byLabel, ...byRef]));
      if (imgs.length) await sh('docker', ['image', 'rm', '-f', ...imgs]);
    } catch {}
    try {
      // Clear dangling images left from builds
      await sh('docker', ['image', 'prune', '-f']);
    } catch {}
  }

  if (mode === 5) {
    // Additionally remove base images used by compose services (from compose file image: entries)
    try {
      const yml = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
      const images = [];
      for (const line of yml.split(/\r?\n/)) {
        const m = line.match(/^\s*image:\s*"?([^"#]+)\s*"?/);
        if (m && m[1]) images.push(m[1].trim());
      }
      const uniq = Array.from(new Set(images));
      if (uniq.length) await sh('docker', ['image', 'rm', '-f', ...uniq]);
    } catch {}
  }
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
  // Optionally remove DB containers and volumes
  const rmDb = await confirm(t('db_also_remove_containers'));
  if (rmDb) {
    const rmDbVol = await confirm(t('db_also_remove_volumes'));
    const args = ['rm', '-s', '-f'];
    if (rmDbVol) args.push('-v');
    try { await dockerCompose([...args, ...services.db, ...services.aux]); } catch {}
  }
  console.log('[console]', t('dev_purge_complete'));
}

async function systemPrune() {
  const yes = await confirm(t('system_prune_confirm'));
  if (!yes) return;
  try {
    await sh('docker', ['system', 'prune', '-a', '-f', '--volumes']);
  } catch {}
}

async function clearLogs() {
  const yes = await confirm(t('clear_logs_confirm'));
  if (!yes) return;
  const logsPath = join(root, 'logs');
  if (!existsSync(logsPath)) {
    console.log('[console]', t('logs_missing'));
    return;
  }
  try {
    rmSync(logsPath, { recursive: true, force: true });
    mkdirSync(logsPath, { recursive: true });
    console.log('[console]', t('logs_cleared'));
  } catch (e) {
    console.error('[console]', t('error_prefix'), e.message || e);
  }
}

async function startProd() {
  await dockerCompose(['--profile', 'prod', 'up', '-d', ...services.db, ...services.prod, ...services.aux]);
}

async function stopProd() {
  await dockerCompose(['rm', '-s', '-f', ...services.prod]);
}

async function startBun() {
  await dockerCompose(['--profile', 'bun', 'up', '-d', ...services.db, ...services.bun, ...services.aux]);
}

async function stopBun() {
  await dockerCompose(['rm', '-s', '-f', ...services.bun]);
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
  console.log(`[console] ${t('tail_quit_hint')}`);
  await followLogs(chosen);
}

async function restartServices() {
  const all = [...services.dev, ...services.prod, ...services.bun];
  all.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  const sel = (await rlPrompt(LANG === 'zh' ? '要重啟哪些服務（輸入編號，空白＝dev）：' : 'Restart which (indices, empty for dev apps): ')).trim();
  let chosen = services.dev;
  if (sel) {
    const idx = sel.split(/\s+/).map((x) => Number(x) - 1).filter((i) => i >= 0 && i < all.length);
    chosen = idx.map((i) => all[i]);
  }
  await dockerCompose(['restart', ...chosen]);
}

async function restartDevQuick() {
  // Quick restart selected dev apps by forcing recreate (no extra prompts)
  console.log(t('select_dev_start'));
  printIndexed(services.dev);
  const devSel = await rlPrompt(t('indices'));
  const chosenDev = pickByIndex(services.dev, devSel, services.dev);
  const flags = ['--profile', 'dev', 'up', '-d', '--force-recreate'];
  console.log('[console]', t('starting_cmd_prefix') + [...flags, ...chosenDev].join(' '));
  await dockerCompose([...flags, ...chosenDev]);
}

async function restartProdQuick() {
  // Quick restart selected prod apps by forcing recreate (no extra prompts)
  console.log(t('select_prod_start'));
  printIndexed(services.prod);
  const sel = await rlPrompt(t('indices'));
  const chosen = pickByIndex(services.prod, sel, services.prod);
  const flags = ['--profile', 'prod', 'up', '-d', '--force-recreate'];
  console.log('[console]', t('starting_cmd_prefix') + [...flags, ...chosen].join(' '));
  await dockerCompose([...flags, ...chosen]);
}

async function restartDevQuickTail() {
  console.log(t('select_dev_start'));
  printIndexed(services.dev);
  const sel = await rlPrompt(t('indices'));
  const chosen = pickByIndex(services.dev, sel, services.dev);
  const flags = ['--profile', 'dev', 'up', '-d', '--force-recreate'];
  console.log('[console]', t('starting_cmd_prefix') + [...flags, ...chosen].join(' '));
  await dockerCompose([...flags, ...chosen]);
  console.log(`[console] ${t('tail_quit_hint')}`);
  await followLogs(chosen);
}

async function restartProdQuickTail() {
  console.log(t('select_prod_start'));
  printIndexed(services.prod);
  const sel = await rlPrompt(t('indices'));
  const chosen = pickByIndex(services.prod, sel, services.prod);
  const flags = ['--profile', 'prod', 'up', '-d', '--force-recreate'];
  console.log('[console]', t('starting_cmd_prefix') + [...flags, ...chosen].join(' '));
  await dockerCompose([...flags, ...chosen]);
  console.log(`[console] ${t('tail_quit_hint')}`);
  await followLogs(chosen);
}

async function servicesMenu() {
  console.log(`\n${t('services_header')}`);
  console.log(`1) ${t('services_opt_1')}`);
  console.log(`2) ${t('services_opt_2')}`);
  console.log(`3) ${t('services_opt_3')}`);
  console.log(`4) ${t('services_opt_4')}`);
  console.log(`5) ${t('services_opt_5')}`);
  console.log(`6) ${t('services_opt_6')}`);
  console.log('0) Back');
  const choice = (await rlPrompt(t('services_select'))).trim();
  if (!choice || choice === '0') return;
  if (choice === '3') {
    await restartServices();
    return;
  }
  if (choice === '5') {
    await restartDevQuick();
    return;
  }
  if (choice === '6') {
    await restartProdQuick();
    return;
  }
  const scope = (await rlPrompt(t('services_scope'))).trim();
  const isProd = scope === '2';
  const isBun = scope === '3';
  const isPick = scope === '4';
  if (choice === '1') {
    if (isProd) await startProd();
    else if (isBun) await startBun();
    else if (isPick) await startDev(); // startDev already allows picking dev services and extras
    else await startDev();
  } else if (choice === '2') {
    if (isProd) await stopProd();
    else if (isBun) await stopBun();
    else if (isPick) await stopDev(); // stopDev allows picking dev services + extras
    else await stopDev();
  } else if (choice === '4') {
    await buildService();
  }
}

async function buildService() {
  const all = [...services.prod, ...services.dev, ...services.bun];
  all.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  const sel = (await rlPrompt(LANG === 'zh' ? '要 build/重建 哪些服務（輸入編號，空白＝全部）：' : 'Build/Rebuild which (indices, empty for all prod+dev): ')).trim();
  let chosen = all;
  if (sel) {
    const idx = sel.split(/\s+/).map((x) => Number(x) - 1).filter((i) => i >= 0 && i < all.length);
    chosen = idx.map((i) => all[i]);
  }
  const noCache = await confirm(t('build_no_cache'));
  const pullBase = await confirm(t('build_pull_base'));
  const args = ['build'];
  if (noCache) args.push('--no-cache');
  if (pullBase) args.push('--pull');
  await dockerCompose([...args, ...chosen]);
}

async function cleanMenu() {
  console.log(`\n${t('clean_header')}`);
  console.log(`1) ${t('clean_opt_1')}`);
  console.log(`2) ${t('clean_opt_2')}`);
  console.log(`3) ${t('clean_opt_3')}`);
  console.log(`4) ${t('clean_opt_4')}`);
  console.log(`5) ${t('clean_opt_5')}`);
  console.log(`6) ${t('clean_opt_6')}`);
  console.log(`7) ${t('clean_opt_7')}`);
  console.log('0) Back');
  const sel = (await rlPrompt(t('clean_select'))).trim();
  if (sel === '1') {
    await purgeDevOnly();
  } else if (sel === '2') {
    await purgeAll(2);
  } else if (sel === '3') {
    await purgeAll(3);
  } else if (sel === '4') {
    await purgeAll(4);
  } else if (sel === '5') {
    await purgeAll(5);
  } else if (sel === '6') {
    await systemPrune();
  } else if (sel === '7') {
    await clearLogs();
  }
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
  console.log(`1) ${t('menu_services')}`); // Services submenu
  console.log(`2) ${t('menu_clean')}`); // Clean submenu
  console.log(`3) ${t('menu_6')}`); // Status
  console.log(`4) ${t('menu_7')}`); // Tail Logs
  console.log(`5) ${t('menu_10')}`); // Exec Shell (repurposed index to keep essentials high)
  console.log(`6) ${t('menu_11')}`); // Open URLs
  console.log(`7) ${t('menu_14')}`); // Change Language
  console.log(`8) ${t('menu_15')}`); // Quick Restart Dev
  console.log(`9) ${t('menu_16')}`); // Quick Restart Prod
  console.log(`10) ${t('menu_17')}`); // Quick Restart Dev + Tail
  console.log(`11) ${t('menu_18')}`); // Quick Restart Prod + Tail
  console.log('0) Quit');
}

async function main() {
  if (!existsSync(join(root, 'docker-compose.yml'))) {
    console.error('[console] Please run from repo root (missing docker-compose.yml).');
    process.exit(1);
  }
  ensureEnvFiles();
  for (;;) {
    await printMenu();
    const ans = (await rlPrompt(t('select'))).trim();
    try {
      if (ans === '1') await servicesMenu();
      else if (ans === '2') await cleanMenu();
      else if (ans === '3') await status();
      else if (ans === '4') await tailLogs();
      else if (ans === '5') await execShell();
      else if (ans === '6') await openUrls();
      else if (ans === '7') await changeLanguage();
      else if (ans === '8') await restartDevQuick();
      else if (ans === '9') await restartProdQuick();
      else if (ans === '10') await restartDevQuickTail();
      else if (ans === '11') await restartProdQuickTail();
      else if (ans === '0') break;
    } catch (e) {
      console.error('[console]', t('error_prefix'), e.message || e);
    }
  }
}

main();
