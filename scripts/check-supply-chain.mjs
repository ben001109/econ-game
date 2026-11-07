#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_PATH = join(ROOT, 'docs/security/supply-chain-evidence.json');
const ONLINE = process.argv.includes('--online');
const JSON_OUTPUT = process.argv.includes('--json');

const SERVICES = ['api', 'bot', 'worker'];
const NPM_LOCKS = [
  ...SERVICES.map((service) => `services/${service}/package-lock.json`),
  'packages/econ-game-sdk/package-lock.json',
];
const DOCKERFILES = SERVICES.map((service) => `services/${service}/Dockerfile`);
const COMPOSE_FILES = ['docker-compose.yml'];

const findings = [];

function addFinding(code, path, detail, severity = 'high') {
  findings.push({ code, severity, path, detail });
}

function policyFinding(code, path, detail) {
  return { code, severity: 'critical', path, detail };
}

function validatedCounts(counts) {
  const levels = ['info', 'low', 'moderate', 'high', 'critical'];
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    throw new Error('vulnerability counts are missing');
  }
  for (const level of [...levels, 'total']) {
    if (!Number.isInteger(counts[level]) || counts[level] < 0) {
      throw new Error(`${level} count must be a non-negative integer`);
    }
  }
  const sum = levels.reduce((total, level) => total + counts[level], 0);
  return { sum, total: counts.total };
}

export function evaluateNpmAuditRecord(audit) {
  const validPath = typeof audit?.path === 'string' && audit.path !== '';
  const path = validPath ? audit.path : 'npm audit evidence';
  let counts;
  try {
    counts = validatedCounts(audit?.counts);
  } catch (error) {
    return [policyFinding('NPM_AUDIT_MALFORMED', path, error.message)];
  }

  const result = [];
  if (!validPath) {
    result.push(policyFinding('NPM_AUDIT_MALFORMED', path, 'Audit path is missing.'));
  }
  const validStatus = audit?.status === 'CLEAN' || audit?.status === 'VULNERABILITIES_FOUND';
  if (!validStatus) {
    result.push(
      policyFinding(
        'NPM_AUDIT_MALFORMED',
        path,
        `Unsupported audit status ${audit?.status ?? 'missing'}.`,
      ),
    );
  }
  if (counts.sum !== counts.total) {
    result.push(
      policyFinding(
        'NPM_AUDIT_INCONSISTENT',
        path,
        `Severity counts sum to ${counts.sum}, but total is ${counts.total}.`,
      ),
    );
  }
  if (
    (audit?.status === 'CLEAN' && counts.total !== 0) ||
    (audit?.status === 'VULNERABILITIES_FOUND' && counts.total === 0)
  ) {
    result.push(
      policyFinding(
        'NPM_AUDIT_INCONSISTENT',
        path,
        `${audit.status} is inconsistent with total ${counts.total}.`,
      ),
    );
  }
  if (counts.sum > 0 || counts.total > 0) {
    result.push(
      policyFinding(
        'NPM_VULNERABILITIES_OPEN',
        path,
        `Recorded audit has ${counts.total} unresolved advisory entries.`,
      ),
    );
  }
  return result;
}

export function parseNpmAuditJson(stdout) {
  if (typeof stdout !== 'string' || stdout.trim() === '') {
    throw new Error('npm audit returned no JSON evidence');
  }
  const parsed = JSON.parse(stdout);
  const counts = validatedCounts(parsed?.metadata?.vulnerabilities);
  if (counts.sum !== counts.total) {
    throw new Error('npm audit vulnerability counts are inconsistent');
  }
  if (!parsed.vulnerabilities || typeof parsed.vulnerabilities !== 'object') {
    throw new Error('npm audit vulnerability details are missing');
  }
  const entries = Object.values(parsed.vulnerabilities);
  if (entries.length !== counts.total) {
    throw new Error('npm audit vulnerability detail count is inconsistent');
  }
  const rows = entries.map((item) => {
    if (
      !item ||
      typeof item.name !== 'string' ||
      !['info', 'low', 'moderate', 'high', 'critical'].includes(item.severity) ||
      typeof item.isDirect !== 'boolean' ||
      typeof item.range !== 'string'
    ) {
      throw new Error('npm audit contains malformed vulnerability details');
    }
    return `${item.name}:${item.severity}:${item.isDirect}:${item.range}`;
  });
  rows.sort();
  return {
    counts: parsed.metadata.vulnerabilities,
    fingerprint: createHash('sha256').update(rows.join('\n')).digest('hex'),
  };
}

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function sha256(path) {
  return createHash('sha256')
    .update(readFileSync(join(ROOT, path)))
    .digest('hex');
}

function requireFile(path) {
  if (!existsSync(join(ROOT, path))) {
    addFinding('MISSING_REQUIRED_FILE', path, 'Required supply-chain input is absent.');
    return false;
  }
  return true;
}

function auditLocks(evidence) {
  const expected = new Map((evidence.locks ?? []).map((item) => [item.path, item]));
  for (const path of NPM_LOCKS) {
    if (!requireFile(path)) continue;
    const item = expected.get(path);
    if (!item) {
      addFinding('LOCK_NOT_IN_EVIDENCE', path, 'Lockfile is not bound to the evidence report.');
      continue;
    }
    const actual = sha256(path);
    if (item.sha256 !== actual) {
      addFinding('STALE_LOCK_EVIDENCE', path, `Expected ${item.sha256}; found ${actual}.`);
    }
  }

  for (const path of NPM_LOCKS) {
    if (!existsSync(join(ROOT, path))) continue;
    const lock = JSON.parse(read(path));
    if (!Number.isInteger(lock.lockfileVersion) || lock.lockfileVersion < 2) {
      addFinding(
        'WEAK_NPM_LOCK_FORMAT',
        path,
        `Unsupported lockfileVersion ${lock.lockfileVersion}.`,
      );
    }
  }
}

function auditActions() {
  const workflowDir = join(ROOT, '.github/workflows');
  if (!existsSync(workflowDir)) return;
  for (const name of readdirSync(workflowDir)
    .filter((entry) => /\.ya?ml$/.test(entry))
    .sort()) {
    const path = `.github/workflows/${name}`;
    for (const [index, line] of read(path).split(/\r?\n/).entries()) {
      const match = line.match(/\buses:\s*['"]?([^\s'"#]+)/);
      if (!match || match[1].startsWith('./')) continue;
      const at = match[1].lastIndexOf('@');
      const ref = at === -1 ? '' : match[1].slice(at + 1);
      if (!/^[a-f0-9]{40}$/.test(ref)) {
        addFinding('ACTION_NOT_PINNED', path, `Line ${index + 1} uses mutable ref ${match[1]}.`);
      }
    }
  }
}

function recordImage(path, image, location, images) {
  images.push(image);
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) {
    addFinding('IMAGE_NOT_PINNED', path, `${location} uses mutable image ${image}.`);
  }
}

function auditContainers(evidence) {
  const images = [];
  for (const path of DOCKERFILES) {
    if (!requireFile(path)) continue;
    const source = read(path);
    const lines = source.split(/\r?\n/);
    let finalUser = '';
    let sawFrom = false;
    for (const [index, line] of lines.entries()) {
      const from = line.match(/^FROM\s+([^\s]+)(?:\s+AS\s+\S+)?/i);
      if (from) {
        sawFrom = true;
        finalUser = '';
        recordImage(path, from[1], `line ${index + 1}`, images);
      }
      const user = line.match(/^USER\s+(.+?)\s*$/i);
      if (user) finalUser = user[1];
    }
    if (sawFrom && (!finalUser || /^(?:root|0)(?::(?:root|0))?$/.test(finalUser))) {
      addFinding(
        'CONTAINER_RUNS_AS_ROOT',
        path,
        'Final image stage has no explicit non-root USER.',
      );
    }
  }

  for (const path of COMPOSE_FILES) {
    if (!requireFile(path)) continue;
    for (const [index, line] of read(path).split(/\r?\n/).entries()) {
      const match = line.match(/^\s*image:\s*['"]?([^\s'"#]+)/);
      if (match) recordImage(path, match[1], `line ${index + 1}`, images);
    }
  }

  const expected = evidence?.containers;
  if (!expected || !Array.isArray(expected.images)) {
    addFinding('CONTAINER_EVIDENCE_MALFORMED', 'containers.images', 'Evidence must list every immutable image reference.', 'critical');
    return;
  }
  const actualUnique = [...new Set(images)].sort();
  const expectedUnique = [...new Set(expected.images)].sort();
  if (
    expected.imageOccurrences !== images.length ||
    expected.digestPinnedOccurrences !== images.filter((image) => /@sha256:[a-f0-9]{64}$/.test(image)).length ||
    expected.uniqueImages !== actualUnique.length ||
    JSON.stringify(expectedUnique) !== JSON.stringify(actualUnique)
  ) {
    addFinding(
      'STALE_CONTAINER_EVIDENCE',
      'containers',
      `Expected ${expected.imageOccurrences} occurrence(s)/${expected.uniqueImages} image(s); found ${images.length}/${actualUnique.length}.`,
      'critical',
    );
  }
}

function auditBootstrap() {
  const path = 'scripts/setup-linux.sh';
  if (!requireFile(path)) return;
  const source = read(path);
  const download = source.indexOf('download_to_file "https://get.docker.com" "$tmp"');
  const verify = source.indexOf('verify_sha256 "$tmp" "$DOCKER_INSTALL_SCRIPT_SHA256"');
  const execute = source.indexOf('run_with_sudo sh "$tmp"');
  if (
    download === -1 ||
    verify === -1 ||
    execute === -1 ||
    !(download < verify && verify < execute)
  ) {
    addFinding(
      'UNVERIFIED_BOOTSTRAP_EXECUTION',
      path,
      'Downloaded Docker bootstrap must be SHA-256 verified before sudo execution.',
      'critical',
    );
  }
  if (!source.includes('DOCKER_INSTALL_SCRIPT_SHA256="${DOCKER_INSTALL_SCRIPT_SHA256:-}"')) {
    addFinding(
      'BOOTSTRAP_TRUST_INPUT_MISSING',
      path,
      'Bootstrap checksum must be supplied out of band.',
    );
  }
}

function isoDateTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateOciStageAAttempt(containers) {
  const attempt = containers?.stageA;
  const path = 'containers.stageA';
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    return policyFinding('EVIDENCE_SCHEMA_INVALID', path, 'OCI Stage A attempt evidence is required.');
  }
  const sideEffects = attempt.sideEffects;
  const expectedReferences = Array.isArray(containers?.images) ? containers.images : [];
  const verifiedReferences = attempt.manifestReview?.verifiedReferences;
  const recordedReferences = attempt.manifestReview?.expectedReferences;
  // The recorded attempt may cover references that later left the repository; every current
  // reference must still be one it verified.
  const coversCurrentReferences =
    Number.isInteger(recordedReferences) &&
    recordedReferences > 0 &&
    Array.isArray(verifiedReferences) &&
    verifiedReferences.length === recordedReferences &&
    new Set(verifiedReferences).size === recordedReferences &&
    expectedReferences.length > 0 &&
    new Set(expectedReferences).size === expectedReferences.length &&
    expectedReferences.every((reference) => verifiedReferences.includes(reference));
  const valid =
    attempt.schemaVersion === 2 &&
    attempt.stage === 'B8-C-A' &&
    attempt.status === 'MANIFESTS_VERIFIED' &&
    isIsoTimestamp(attempt.recordedAt) &&
    typeof attempt.command === 'string' &&
    attempt.command !== '' &&
    typeof attempt.commandTimestamp === 'string' &&
    attempt.commandTimestamp !== '' &&
    typeof attempt.environment?.dockerClient === 'string' &&
    attempt.environment.dockerClient !== '' &&
    typeof attempt.environment?.buildx === 'string' &&
    attempt.environment.buildx !== '' &&
    typeof attempt.environment?.dockerContext === 'string' &&
    attempt.environment.dockerContext !== '' &&
    attempt.registryResult?.registry === 'OCI registries' &&
    attempt.registryResult?.authentication === 'unauthenticated' &&
    attempt.registryResult?.status === 'ALL_REFERENCES_MATCHED' &&
    attempt.manifestReview?.completedReferences === recordedReferences &&
    attempt.manifestReview?.status === 'COMPLETE_MATCHED_IMMUTABLE_REFERENCES' &&
    attempt.manifestReview?.retryAttempted === true &&
    coversCurrentReferences &&
    attempt.tooling?.cosignInstalled === false &&
    attempt.tooling?.orasInstalled === false &&
    attempt.tooling?.trustedIdentityPolicyConfigured === false &&
    sideEffects?.imageLayersPulled === false &&
    sideEffects?.imagesBuilt === false &&
    sideEffects?.containersRun === false &&
    sideEffects?.imagesScanned === false &&
    sideEffects?.imagesDeployed === false;
  return valid
    ? null
    : policyFinding(
      'EVIDENCE_SCHEMA_INVALID',
      path,
      'OCI Stage A evidence must verify every current immutable reference, preserve absent tooling/policy, and record no side effects.',
    );
}

export function validateRecordedEvidenceSchema(evidence, { now = Date.now() } = {}) {
  const result = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return [
      policyFinding(
        'EVIDENCE_SCHEMA_INVALID',
        'supply-chain evidence',
        'Evidence root must be an object.',
      ),
    ];
  }

  if (!Array.isArray(evidence.evidenceMissing)) {
    result.push(
      policyFinding(
        'EVIDENCE_SCHEMA_INVALID',
        'evidenceMissing',
        'evidenceMissing must be an array, including when there are no gaps.',
      ),
    );
  } else {
    for (const [index, gap] of evidence.evidenceMissing.entries()) {
      if (
        !gap ||
        typeof gap !== 'object' ||
        Array.isArray(gap) ||
        typeof gap.scope !== 'string' ||
        gap.scope === '' ||
        typeof gap.detail !== 'string' ||
        gap.detail === '' ||
        typeof gap.blocking !== 'boolean'
      ) {
        result.push(
          policyFinding(
            'EVIDENCE_SCHEMA_INVALID',
            `evidenceMissing[${index}]`,
            'Evidence gaps require non-empty scope/detail strings and a boolean blocking field.',
          ),
        );
      }
    }
  }

  if (evidence.containers !== undefined) {
    const stageAAttemptFinding = validateOciStageAAttempt(evidence.containers);
    if (stageAAttemptFinding) result.push(stageAAttemptFinding);
  }

  const node = evidence.runtime?.node22;
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    result.push(
      policyFinding(
        'EVIDENCE_SCHEMA_INVALID',
        'runtime.node22',
        'runtime.node22 must be an object.',
      ),
    );
    return result;
  }

  const endTimestamp = isoDateTimestamp(node.end);
  if (endTimestamp === null) {
    result.push(
      policyFinding(
        'EVIDENCE_SCHEMA_INVALID',
        'runtime.node22.end',
        'runtime.node22.end must be a valid ISO YYYY-MM-DD date.',
      ),
    );
  }
  if (typeof node.status !== 'string' || node.status === '') {
    result.push(
      policyFinding(
        'EVIDENCE_SCHEMA_INVALID',
        'runtime.node22.status',
        'runtime.node22.status must be an explicit non-empty string.',
      ),
    );
  } else if (endTimestamp !== null && endTimestamp < now && node.status !== 'EOL') {
    result.push(
      policyFinding(
        'EVIDENCE_SCHEMA_INVALID',
        'runtime.node22.status',
        `runtime.node22.status must be EOL after ${node.end}.`,
      ),
    );
  }

  return result;
}

export function auditRecordedEvidence(
  evidence,
  { nodeVersion = '', executingNodeVersion = process.version, now = Date.now() } = {},
) {
  const result = validateRecordedEvidenceSchema(evidence, { now });
  if (!Array.isArray(evidence?.npmAudits)) {
    result.push(
      policyFinding('NPM_AUDIT_MALFORMED', 'npm audit evidence', 'npmAudits must be an array.'),
    );
  } else {
    const paths = new Set();
    for (const audit of evidence.npmAudits) {
      if (typeof audit?.path === 'string') paths.add(audit.path);
      result.push(...evaluateNpmAuditRecord(audit));
    }
    for (const path of NPM_LOCKS) {
      if (!paths.has(path)) {
        result.push(
          policyFinding(
            'NPM_AUDIT_MISSING',
            path,
            'No npm audit evidence exists for this lockfile.',
          ),
        );
      }
    }
  }
  if (Array.isArray(evidence?.evidenceMissing)) {
    for (const gap of evidence.evidenceMissing) {
      if (
        gap &&
        typeof gap === 'object' &&
        !Array.isArray(gap) &&
        typeof gap.scope === 'string' &&
        typeof gap.detail === 'string' &&
        gap.blocking === true
      ) {
        result.push(policyFinding('EVIDENCE_MISSING', gap.scope, gap.detail));
      }
    }
  }

  const node = evidence?.runtime?.node22;
  const endTimestamp = isoDateTimestamp(node?.end);
  if (
    nodeVersion === '22' &&
    endTimestamp !== null &&
    typeof node?.status === 'string' &&
    endTimestamp < now
  ) {
    result.push(
      policyFinding('EOL_RUNTIME', '.nvmrc', `Node 22 reached end of life on ${node.end}.`),
    );
  }
  if (node?.configured !== nodeVersion || node?.executing !== executingNodeVersion) {
    result.push(
      policyFinding(
        'RUNTIME_EVIDENCE_MISMATCH',
        '.nvmrc',
        `Evidence records ${node?.configured ?? 'missing'}/${node?.executing ?? 'missing'}; found ${nodeVersion}/${executingNodeVersion}.`,
      ),
    );
  }
  return result;
}

function npmAudit(path) {
  const cwd = join(ROOT, dirname(path));
  const auditEnv = {
    PATH: process.env.PATH ?? '',
    HOME: '/tmp/econ-supply-chain-home',
    npm_config_cache: '/tmp/econ-supply-chain-npm-cache',
    npm_config_update_notifier: 'false',
    npm_config_userconfig: '/dev/null',
  };
  const result = spawnSync('npm', ['audit', '--package-lock-only', '--ignore-scripts', '--json'], {
    cwd,
    encoding: 'utf8',
    env: auditEnv,
    maxBuffer: 20 * 1024 * 1024,
  });
  try {
    return parseNpmAuditJson(result.stdout);
  } catch (error) {
    addFinding('EVIDENCE_MISSING', path, `npm audit failed closed: ${error.message}.`, 'critical');
    return null;
  }
}

async function auditOnline(evidence) {
  const recorded = new Map((evidence.npmAudits ?? []).map((item) => [item.path, item]));
  for (const path of NPM_LOCKS) {
    const current = npmAudit(path);
    const expected = recorded.get(path);
    if (
      current &&
      (JSON.stringify(current.counts) !== JSON.stringify(expected?.counts) ||
        current.fingerprint !== expected?.fingerprint)
    ) {
      addFinding(
        'STALE_NPM_AUDIT',
        path,
        'Current registry counts differ from the evidence report.',
        'critical',
      );
    }
  }
}

async function main() {
  if (!requireFile(relative(ROOT, EVIDENCE_PATH))) {
    process.exitCode = 1;
    return;
  }
  const evidence = JSON.parse(read(relative(ROOT, EVIDENCE_PATH)));
  auditLocks(evidence);
  auditActions();
  auditContainers(evidence);
  auditBootstrap();
  const nodeVersion = existsSync(join(ROOT, '.nvmrc')) ? read('.nvmrc').trim() : '';
  findings.push(...auditRecordedEvidence(evidence, { nodeVersion }));
  if (ONLINE) await auditOnline(evidence);

  const result = {
    ok: findings.length === 0,
    mode: ONLINE ? 'online' : 'offline',
    evidence: relative(ROOT, EVIDENCE_PATH),
    findings,
  };
  if (JSON_OUTPUT) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const finding of findings) {
      process.stderr.write(
        `[${finding.severity.toUpperCase()}] ${finding.code} ${finding.path}: ${finding.detail}\n`,
      );
    }
    process.stdout.write(
      `Supply-chain check: ${result.ok ? 'PASS' : 'FAIL'} (${findings.length} finding(s), ${result.mode})\n`,
    );
  }
  if (!result.ok) process.exitCode = 1;
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) await main();
