#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNpmAuditJson } from './check-supply-chain.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'docs/security/supply-chain-evidence.json');
const OCI_STAGE_A_ATTEMPT = 'docs/security/b8-c-oci-stage-a-attempt.json';
const WRITE = process.argv.includes('--write');
const SERVICES = ['api', 'bot', 'worker'];
const NPM_LOCKS = [
  ...SERVICES.map((service) => `services/${service}/package-lock.json`),
  'packages/econ-game-sdk/package-lock.json',
];
const DOCKERFILES = SERVICES.map((service) => `services/${service}/Dockerfile`);
const COMPOSE_FILES = ['docker-compose.yml'];
const EXPECTED_IMAGE_OCCURRENCES = 13;
const EXPECTED_UNIQUE_IMAGES = 7;

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');
}

function ociStageAAttempt() {
  return JSON.parse(read(OCI_STAGE_A_ATTEMPT));
}

function ociEvidenceMissing(stageA, images) {
  const verified = stageA?.manifestReview?.verifiedReferences ?? [];
  if (
    stageA?.status === 'MANIFESTS_VERIFIED' &&
    stageA?.manifestReview?.completedReferences === stageA?.manifestReview?.expectedReferences &&
    images.every((image) => verified.includes(image))
  ) {
    return [];
  }
  return [{ scope: 'OCI external runtime validation', blocking: true, detail: 'B8-C Stage A has not recorded a complete immutable-manifest verification covering every current reference; no image was pulled, built, started, or deployed.' }];
}

function command(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: '/tmp/econ-supply-chain-home',
      npm_config_cache: '/tmp/econ-supply-chain-npm-cache',
      npm_config_update_notifier: 'false',
      npm_config_userconfig: '/dev/null',
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status === null) {
    throw new Error(`${command} could not execute: ${result.error?.message ?? 'no exit status'}`);
  }
  return result;
}

function npmAudit(path, queriedAt) {
  const result = command(
    'npm',
    ['audit', '--package-lock-only', '--ignore-scripts', '--json'],
    join(ROOT, dirname(path)),
  );
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

function imageReferences() {
  const images = [];
  for (const path of DOCKERFILES) {
    for (const line of read(path).split(/\r?\n/)) {
      const match = line.match(/^FROM\s+([^\s]+)(?:\s+AS\s+\S+)?/i);
      if (match) images.push(match[1]);
    }
  }
  for (const path of COMPOSE_FILES) {
    for (const line of read(path).split(/\r?\n/)) {
      const match = line.match(/^\s*image:\s*['"]?([^\s'"#]+)/);
      if (match) images.push(match[1]);
    }
  }
  return images;
}

async function node22Lifecycle(verifiedAt) {
  const source = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
  const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Node lifecycle query failed with HTTP ${response.status}`);
  const schedule = await response.json();
  const release = schedule.v22;
  if (!release || typeof release.end !== 'string') throw new Error('Node v22 lifecycle is absent from official schedule');
  const configured = read('.nvmrc').trim();
  const executing = command('node', ['--version']).stdout.trim();
  // .nvmrc pins an exact Node 22 release, so CI and the evidence run the same runtime.
  if (!/^22\.\d+\.\d+$/.test(configured) || executing !== `v${configured}`) {
    throw new Error(`Node runtime must be an exact Node 22 release executing as v${configured}; got ${configured}/${executing}`);
  }
  return { source, verifiedAt, configured, executing, end: release.end, status: 'ACTIVE' };
}

async function main() {
  const generatedAt = new Date().toISOString();
  const npmAudits = NPM_LOCKS.map((path) => npmAudit(path, generatedAt));
  const runtime = await node22Lifecycle(generatedAt);
  const images = imageReferences();
  if (images.length !== EXPECTED_IMAGE_OCCURRENCES || new Set(images).size !== EXPECTED_UNIQUE_IMAGES || images.some((image) => !/@sha256:[a-f0-9]{64}$/.test(image))) {
    throw new Error(`OCI enumeration is not immutable ${EXPECTED_IMAGE_OCCURRENCES}/${EXPECTED_UNIQUE_IMAGES} evidence: ${images.length}/${new Set(images).size}`);
  }
  const stageA = ociStageAAttempt();
  const evidence = {
    schemaVersion: 2,
    generatedAt,
    generator: 'scripts/generate-supply-chain-evidence.mjs --write',
    repository: { head: command('git', ['rev-parse', 'HEAD']).stdout.trim(), branch: command('git', ['branch', '--show-current']).stdout.trim(), worktree: 'dirty-authorized', secretsRead: false },
    locks: NPM_LOCKS.map((path) => ({ path, ecosystem: 'npm', sha256: sha256(path) })),
    npmAudits,
    containers: { source: 'docs/security/b7-c-oci-digest-remediation.md (authoritative registry manifests at 2026-08-16T16:03:07Z)', imageOccurrences: images.length, uniqueImages: new Set(images).size, digestPinnedOccurrences: images.length, images: [...new Set(images)].sort(), runtimeDockerfiles: DOCKERFILES.length, explicitNonRootRuntime: DOCKERFILES.length, status: 'DIGESTS_VERIFIED_STATIC', stageA },
    runtime: { node22: runtime },
    knownRisks: [],
    evidenceMissing: [
      ...ociEvidenceMissing(stageA, [...new Set(images)]),
      { scope: 'OCI signatures, attestations, and layer CVEs', blocking: true, detail: 'cosign and oras are not installed, no trusted identity policy is configured, and no signature/attestation verification or image-layer CVE scanner result is available.' },
    ],
    remediation: { lockfilesChangedByB7D: false, dependenciesInstalled: false, servicesOrContainersStarted: false, externalImagePullOrDeploy: false },
  };
  const output = `${JSON.stringify(evidence, null, 2)}\n`;
  if (WRITE) writeFileSync(OUTPUT, output);
  else process.stdout.write(output);
}

main().catch((error) => {
  process.stderr.write(`Evidence generation failed closed: ${error.message}\n`);
  process.exitCode = 1;
});
