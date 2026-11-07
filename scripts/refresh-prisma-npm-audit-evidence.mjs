#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseNpmAuditJson } from './check-supply-chain.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = 'docs/security/supply-chain-evidence.json';
const NPM_TARGETS = ['services/api/package-lock.json', 'services/worker/package-lock.json'];
const LOCK_TARGETS = [...NPM_TARGETS, 'services/api/bun.lock', 'services/worker/bun.lock'];
const WRITE = process.argv.includes('--write');

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');
}

function requireSingle(entries, path, kind) {
  const matches = entries.filter((entry) => entry?.path === path);
  if (matches.length !== 1) throw new Error(`${kind} must contain exactly one entry for ${path}`);
  return matches[0];
}

function audit(path, queriedAt) {
  const result = spawnSync('npm', ['audit', '--package-lock-only', '--ignore-scripts', '--json'], {
    cwd: join(ROOT, dirname(path)),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: '/tmp/econ-prisma-audit-home',
      npm_config_cache: '/tmp/econ-prisma-audit-cache',
      npm_config_update_notifier: 'false',
      npm_config_userconfig: '/dev/null',
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status === null) {
    throw new Error(`npm audit failed for ${path}: ${result.error?.message ?? 'no exit status'}`);
  }
  const parsed = parseNpmAuditJson(result.stdout);
  const raw = JSON.parse(result.stdout);
  const entries = Object.values(raw.vulnerabilities).map((item) => ({
    package: item.name,
    severity: item.severity,
    direct: item.isDirect,
    range: item.range,
  })).sort((a, b) => a.package.localeCompare(b.package));
  return {
    path,
    queriedAt,
    source: 'https://registry.npmjs.org/-/npm/v1/security/audits/quick',
    command: 'npm audit --package-lock-only --ignore-scripts --json',
    exitCode: result.status,
    status: parsed.counts.total === 0 ? 'CLEAN' : 'VULNERABILITIES_FOUND',
    fingerprint: parsed.fingerprint,
    counts: parsed.counts,
    entries,
  };
}

function refresh(evidence, queriedAt) {
  if (!Array.isArray(evidence?.locks) || !Array.isArray(evidence?.npmAudits)) {
    throw new Error('evidence must contain locks and npmAudits arrays');
  }
  const result = structuredClone(evidence);
  for (const path of LOCK_TARGETS) {
    requireSingle(result.locks, path, 'locks').sha256 = sha256(path);
  }
  if (!Array.isArray(result?.bun?.lockfiles)) throw new Error('evidence must contain bun.lockfiles');
  for (const path of LOCK_TARGETS.filter((path) => path.endsWith('/bun.lock'))) {
    requireSingle(result.bun.lockfiles, path, 'bun.lockfiles').sha256 = sha256(path);
  }
  for (const path of NPM_TARGETS) {
    const index = result.npmAudits.findIndex((entry) => entry?.path === path);
    requireSingle(result.npmAudits, path, 'npmAudits');
    result.npmAudits[index] = audit(path, queriedAt);
  }
  return result;
}

function main() {
  const original = read(EVIDENCE);
  const refreshed = refresh(JSON.parse(original), new Date().toISOString());
  const output = `${JSON.stringify(refreshed, null, 2)}\n`;
  if (WRITE) writeFileSync(join(ROOT, EVIDENCE), output);
  else process.stdout.write(output);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Prisma npm audit evidence refresh failed closed: ${error.message}\n`);
  process.exitCode = 1;
}
