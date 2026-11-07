import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('Compose files require credentials, bind locally, and gate administration tools', () => {
  for (const path of ['docker-compose.yml']) {
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
  assert.match(
    read('docs/operations/container-secret-boundary.md'),
    /The Compose definition binds published ports to `127\.0\.0\.1` by default/,
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
    source.indexOf("name: 'bot'"),
  );
  assert.doesNotMatch(workerGroup, /DISCORD_BOT_TOKEN|requiresDiscordToken/);
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

test('operator documentation contains no credential-shaped demonstration values', () => {
  const sources = [
    read('README.md'),
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
