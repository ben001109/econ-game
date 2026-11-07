import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

function publishedPortEntries(compose) {
  const lines = compose.split('\n');
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)ports:\s*$/.exec(lines[index]);
    if (!match) continue;
    const blockIndent = match[1].length;
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= blockIndent) {
        index -= 1;
        break;
      }
      if (/^\s*-\s+/.test(line)) entries.push(line.trim());
    }
  }
  return entries;
}

test('all Pterodactyl eggs keep secrets server-owned and reject credentialed clone URLs', () => {
  const expectedSecrets = new Map([
    ['econ_api_bun.json', ['DATABASE_URL', 'REDIS_URL']],
    ['econ_api_python.json', ['DATABASE_URL', 'REDIS_URL']],
    ['econ_bot_bun.json', ['DISCORD_BOT_TOKEN', 'BOT_SERVICE_CREDENTIAL']],
    ['econ_bot_python.json', ['DISCORD_BOT_TOKEN']],
    ['econ_frontend_bun.json', []],
    ['econ_frontend_python.json', []],
    ['econ_worker_bun.json', ['DATABASE_URL', 'REDIS_URL']],
    ['econ_worker_python.json', ['DATABASE_URL', 'REDIS_URL']],
  ]);
  const eggNames = readdirSync(join(root, 'pterodactyl/eggs'))
    .filter((name) => name.endsWith('.json'))
    .sort();
  assert.deepEqual(eggNames, [...expectedSecrets.keys()].sort());
  const sensitiveVariableName =
    /^(?:DATABASE_URL|REDIS_URL|BOT_SERVICE_CREDENTIAL|.*(?:DISCORD|CLERK|GIT).*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)|SUPABASE.*(?:SERVICE_ROLE|SECRET|TOKEN|PASSWORD)|(?:ACCESS|REFRESH)_TOKEN)$/i;

  for (const eggName of eggNames) {
    const egg = JSON.parse(read(`pterodactyl/eggs/${eggName}`));
    const variables = new Map(egg.variables.map((entry) => [entry.env_variable, entry]));
    assert.equal(variables.has('ACCESS_TOKEN'), false, eggName);
    assert.equal(variables.has('USERNAME'), false, eggName);
    for (const name of expectedSecrets.get(eggName)) {
      const variable = variables.get(name);
      assert.ok(variable, `${eggName}:${name}`);
      assert.equal(variable.default_value, '', `${eggName}:${name}`);
      assert.equal(variable.user_viewable, false, `${eggName}:${name}`);
      assert.equal(variable.user_editable, false, `${eggName}:${name}`);
      assert.match(variable.rules, /required/, `${eggName}:${name}`);
      assert.match(variable.description, /Server-owned/, `${eggName}:${name}`);
    }
    for (const variable of variables.values()) {
      if (sensitiveVariableName.test(variable.env_variable)) {
        assert.equal(variable.default_value, '', `${eggName}:${variable.env_variable}`);
        assert.equal(variable.user_viewable, false, `${eggName}:${variable.env_variable}`);
        assert.equal(variable.user_editable, false, `${eggName}:${variable.env_variable}`);
        assert.match(variable.rules, /required/, `${eggName}:${variable.env_variable}`);
      }
    }
    for (const adminField of ['WORK_DIR', 'START_CMD']) {
      assert.equal(variables.get(adminField)?.user_editable, false, `${eggName}:${adminField}`);
    }
    if (eggName === 'econ_api_bun.json') {
      const nodeEnv = variables.get('NODE_ENV');
      assert.ok(nodeEnv);
      assert.equal(nodeEnv.default_value, 'production');
      assert.equal(nodeEnv.user_editable, false);
      assert.match(nodeEnv.rules, /required\|in:production/);
      assert.match(egg.scripts.installation.script, /export NODE_ENV=production/);
      assert.match(egg.startup, /export NODE_ENV=production/);
    }
    const install = egg.scripts.installation.script;
    assert.match(install, /set -euo pipefail/, eggName);
    assert.doesNotMatch(install, /ACCESS_TOKEN|USERNAME|https:\/\/\$\{/, eggName);
    assert.match(install, /Only public HTTPS/, eggName);
    assert.match(install, /credentials .*forbidden/, eggName);
    assert.match(install, /git clone --/, eggName);
    assert.doesNotMatch(
      `${install}\n${egg.startup}`,
      /(?:\$\{|\{\{)[^}\n]*(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|DATABASE_URL|REDIS_URL)/i,
      eggName,
    );
    assert.doesNotMatch(
      egg.startup,
      /TOKEN|PASSWORD|SECRET|CREDENTIAL|DATABASE_URL|REDIS_URL/,
      eggName,
    );
  }
});

test('Compose files require credentials, bind locally, and gate administration tools', () => {
  for (const path of ['docker-compose.yml', 'docker-compose.python.yml']) {
    const compose = read(path);
    assert.doesNotMatch(compose, /gamepass|change-me/);
    assert.match(compose, /POSTGRES_PASSWORD:\s+\$\{POSTGRES_PASSWORD:\?/);
    const publishedPorts = publishedPortEntries(compose);
    assert.ok(publishedPorts.length > 0, path);
    for (const publishedPort of publishedPorts) {
      assert.match(
        publishedPort,
        /^-\s+["']?\$\{ECON_BIND_ADDRESS:-127\.0\.0\.1\}:\d+:\d+["']?$/,
        `${path}:${publishedPort}`,
      );
    }
    for (const service of ['adminer', 'redis-commander']) {
      const block = compose.slice(compose.indexOf(`  ${service}:`));
      assert.match(block.slice(0, block.indexOf('\n\n')), /profiles:\s*\[[^\]]*['"]tools['"]/);
    }
  }
  assert.match(read('docker-compose.python.yml'), /DISCORD_BOT_TOKEN:\s+\$\{DISCORD_BOT_TOKEN:\?/);
  assert.match(
    read('docs/operations/container-secret-boundary.md'),
    /Both Compose definitions bind published ports to `127\.0\.0\.1` by default/,
  );
});

test('console hides secret prompts and applies owner-only permissions to credential files', () => {
  const source = read('scripts/console.mjs');
  assert.match(source, /function rlSecretPrompt/);
  assert.match(source, /chmodSync\(path, 0o600\)/);
  assert.match(source, /setupAskSecret\('Enter New Relic license key:/);
  assert.match(source, /setupAskSecret\('Enter Sentry DSN:/);
  assert.match(source, /rlSecretPrompt\(prompt\)/);
  const workerGroup = source.slice(
    source.indexOf("name: 'worker'"),
    source.indexOf("name: 'frontend'"),
  );
  assert.doesNotMatch(workerGroup, /DISCORD_BOT_TOKEN|requiresDiscordToken/);
  const frontendMonitoring = source.slice(
    source.indexOf("path: join(servicesDir, 'frontend'"),
    source.indexOf('];', source.indexOf("path: join(servicesDir, 'frontend'")),
  );
  assert.doesNotMatch(frontendMonitoring, /NEW_RELIC_LICENSE_KEY/);
  assert.doesNotMatch(source, /console\.error\([^\n]*\.message/);
});

test('Linux setup keeps credential input private and administration tools opt-in', () => {
  const source = read('scripts/setup-linux.sh');
  assert.match(source, /read -r -s NEW_RELIC_LICENSE/);
  assert.match(source, /read -r -s SENTRY_DSN/);
  assert.match(source, /chmod 600 "\$path"/);
  assert.doesNotMatch(source, /gamepass|change-me/);
  const dockerStart = source
    .split('\n')
    .find((line) => line.includes('docker_compose --profile dev up'));
  assert.ok(dockerStart);
  assert.doesNotMatch(dockerStart, /adminer|redis-commander/);
});

test('all Node service loggers redact known credentials and serialize errors without messages', () => {
  for (const path of [
    'services/api/src/logger.ts',
    'services/bot/src/logger.ts',
    'services/worker/src/logger.ts',
  ]) {
    const source = read(path);
    for (const key of ['DATABASE_URL', 'DISCORD_BOT_TOKEN', 'BOT_SERVICE_CREDENTIAL']) {
      assert.match(source, new RegExp(key));
    }
    assert.match(source, /safeErrorSerializer/);
    assert.doesNotMatch(source.slice(source.indexOf('safeErrorSerializer')), /record\.message/);
  }
});

test('Python service settings do not guess database, cache, API, or Discord credentials', () => {
  const sources = [
    read('python/services/api/src/econ_api/config.py'),
    read('python/services/worker/src/econ_worker/config.py'),
    read('python/services/bot/src/econ_bot/config.py'),
  ].join('\n');
  assert.doesNotMatch(sources, /gamepass|change-me/);
  assert.doesNotMatch(sources, /default=.*(?:DATABASE_URL|REDIS_URL|DISCORD_BOT_TOKEN)/);
  for (const key of ['DATABASE_URL', 'REDIS_URL', 'DISCORD_BOT_TOKEN', 'API_BASE_URL']) {
    assert.match(sources, new RegExp(`alias="${key}"`));
  }
});

test('operator documentation contains no credential-shaped demonstration values', () => {
  const sources = [
    read('README.md'),
    read('pterodactyl/README.md'),
    read('python/services/api/README.md'),
    read('python/services/bot/README.md'),
    read('docs/operations/container-secret-boundary.md'),
  ].join('\n');
  assert.doesNotMatch(
    sources,
    /gamepass|change-me|DISCORD_BOT_TOKEN=|https?:\/\/[^\s/:]+:[^\s/@]+@/,
  );
});

test('Node Compose documentation matches root interpolation and service-specific secret files', () => {
  const compose = read('docker-compose.yml');
  const guide = read('docs/operations/container-secret-boundary.md');
  for (const service of ['api', 'worker', 'bot']) {
    assert.match(compose, new RegExp(`services/${service}/\\.env\\.local`));
    assert.match(guide, new RegExp(`services/${service}/\\.env\\.local`));
  }
  assert.match(guide, /root `\.env` is used only for Compose interpolation/);
  assert.match(guide, /does not automatically inject/);
  assert.doesNotMatch(guide, /Set every variable that Compose marks as required/);
});
