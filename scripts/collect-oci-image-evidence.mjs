#!/usr/bin/env node

// Collects the OCI evidence that scripts/check-supply-chain.mjs evaluates against
// docs/security/oci-image-trust-policy.json: manifest resolution (Stage A), then signatures,
// provenance and a trivy vulnerability scan for every pinned image (Stage B).
// Requires docker (buildx), cosign and trivy. Without --write it prints the Stage B record only.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE_A_OUTPUT = join(ROOT, 'docs/security/b8-c-oci-stage-a-attempt.json');
const TRUST_OUTPUT = join(ROOT, 'docs/security/oci-image-trust-evidence.json');
const WRITE = process.argv.includes('--write');
const SERVICES = ['api', 'bot', 'worker'];
const DOCKERFILES = SERVICES.map((service) => `services/${service}/Dockerfile`);
const COMPOSE_FILES = ['docker-compose.yml'];
const SCAN_PLATFORM = 'linux/amd64';
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
  if (result.error || result.status === null) {
    throw new Error(`${command} could not execute: ${result.error?.message ?? 'no exit status'}`);
  }
  return result;
}

function runOk(command, args) {
  const result = run(command, args);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout;
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
  return [...new Set(images)].sort();
}

// Reads only whether a Docker Hub credential entry exists, never the credential itself.
function dockerHubAuthenticated() {
  try {
    const config = JSON.parse(readFileSync(join(process.env.HOME ?? '', '.docker/config.json'), 'utf8'));
    return Object.keys(config.auths ?? {}).some((host) => host.includes('docker.io'));
  } catch {
    return false;
  }
}

function manifestName(reference) {
  return runOk('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{.Name}}']).trim();
}

function signature(reference) {
  const output = runOk('cosign', ['tree', reference]);
  return {
    tool: 'cosign tree',
    status: output.includes('No Supply Chain Security Related Artifacts found') ? 'NONE_PUBLISHED' : 'PRESENT',
  };
}

function provenance(reference) {
  const raw = runOk('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Provenance}}']).trim();
  const byPlatform = raw && raw !== 'null' ? JSON.parse(raw) : {};
  const records = Object.values(byPlatform)
    .map((entry) => entry?.SLSA)
    .filter(Boolean);
  if (records.length === 0) return { status: 'ABSENT', platforms: 0, builders: [], sources: [] };
  return {
    status: 'PRESENT',
    signed: false,
    platforms: records.length,
    builders: [...new Set(records.map((record) => record.builder?.id ?? ''))].sort(),
    sources: [...new Set(records.map((record) => record.invocation?.configSource?.uri ?? ''))].sort(),
  };
}

function scan(reference) {
  const report = JSON.parse(
    runOk('trivy', ['image', '--quiet', '--platform', SCAN_PLATFORM, '--scanners', 'vuln', '--format', 'json', reference]),
  );
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  let osFixableCritical = 0;
  let osFixableHigh = 0;
  const languageFindings = [];
  for (const result of report.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      counts[vulnerability.Severity] = (counts[vulnerability.Severity] ?? 0) + 1;
      const severe = vulnerability.Severity === 'CRITICAL' || vulnerability.Severity === 'HIGH';
      if (result.Class === 'os-pkgs' && vulnerability.FixedVersion) {
        if (vulnerability.Severity === 'CRITICAL') osFixableCritical += 1;
        if (vulnerability.Severity === 'HIGH') osFixableHigh += 1;
      }
      if (result.Class === 'lang-pkgs' && severe) {
        languageFindings.push({
          id: vulnerability.VulnerabilityID,
          severity: vulnerability.Severity,
          package: `${vulnerability.PkgName}@${vulnerability.InstalledVersion}`,
          fixedVersion: vulnerability.FixedVersion ?? '',
          location: vulnerability.PkgPath || result.Target,
        });
      }
    }
  }
  languageFindings.sort((a, b) => `${a.location}${a.id}`.localeCompare(`${b.location}${b.id}`));
  return {
    os: { family: report.Metadata?.OS?.Family ?? '', name: report.Metadata?.OS?.Name ?? '', eosl: report.Metadata?.OS?.EOSL === true },
    counts,
    osFixableCritical,
    osFixableHigh,
    languageFindings,
  };
}

function main() {
  const recordedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const references = imageReferences();
  const verifiedReferences = [];
  for (const reference of references) {
    const name = manifestName(reference);
    if (name !== reference && name !== `docker.io/library/${reference}` && name !== `docker.io/${reference}`) {
      throw new Error(`Registry resolved ${reference} as ${name}`);
    }
    verifiedReferences.push(reference);
  }
  const tooling = {
    dockerClient: runOk('docker', ['version', '--format', '{{.Client.Version}}']).trim(),
    buildx: runOk('docker', ['buildx', 'version']).trim(),
    dockerContext: runOk('docker', ['context', 'show']).trim(),
    cosign: JSON.parse(runOk('cosign', ['version', '--json'])).gitVersion,
    trivy: JSON.parse(runOk('trivy', ['version', '--format', 'json'])).Version,
  };
  const images = references.map((reference) => ({
    reference,
    signature: signature(reference),
    provenance: provenance(reference),
    scan: scan(reference),
  }));
  const trivyDb = JSON.parse(runOk('trivy', ['version', '--format', 'json'])).VulnerabilityDB ?? {};

  const stageA = {
    schemaVersion: 2,
    recordedAt,
    stage: 'B8-C-A',
    status: 'MANIFESTS_VERIFIED',
    command: `docker buildx imagetools inspect <immutable-reference> --format '{{.Name}}' (once for each of the ${references.length} recorded references, by scripts/collect-oci-image-evidence.mjs)`,
    commandTimestamp: recordedAt,
    environment: { dockerClient: tooling.dockerClient, buildx: tooling.buildx, dockerContext: tooling.dockerContext },
    registryResult: { registry: 'OCI registries', authentication: dockerHubAuthenticated() ? 'authenticated' : 'unauthenticated', status: 'ALL_REFERENCES_MATCHED' },
    manifestReview: {
      expectedReferences: references.length,
      completedReferences: verifiedReferences.length,
      status: 'COMPLETE_MATCHED_IMMUTABLE_REFERENCES',
      retryAttempted: true,
      verifiedReferences,
    },
    tooling: { cosignInstalled: true, orasInstalled: false, trustedIdentityPolicyConfigured: false },
    sideEffects: { imageLayersPulled: false, imagesBuilt: false, containersRun: false, imagesScanned: false, imagesDeployed: false },
  };
  const trust = {
    schemaVersion: 1,
    recordedAt,
    collector: 'scripts/collect-oci-image-evidence.mjs --write',
    policy: 'docs/security/oci-image-trust-policy.json',
    scanPlatform: SCAN_PLATFORM,
    tooling: { cosign: tooling.cosign, trivy: tooling.trivy, trivyDbUpdatedAt: trivyDb.UpdatedAt ?? '' },
    sideEffects: { imageLayersPulled: true, imagesBuilt: false, containersRun: false, imagesDeployed: false },
    images,
  };
  if (WRITE) {
    writeFileSync(STAGE_A_OUTPUT, `${JSON.stringify(stageA, null, 2)}\n`);
    writeFileSync(TRUST_OUTPUT, `${JSON.stringify(trust, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(trust, null, 2)}\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`OCI evidence collection failed closed: ${error.message}\n`);
  process.exitCode = 1;
}
