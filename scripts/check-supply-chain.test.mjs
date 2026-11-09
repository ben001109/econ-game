import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditImageTrust,
  auditRecordedEvidence,
  evaluateNpmAuditRecord,
  parseNpmAuditJson,
  validateRecordedEvidenceSchema,
} from './check-supply-chain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures/check-supply-chain');

function fixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

function codes(findings) {
  return findings.map((finding) => finding.code).sort();
}

const npmPolicy = fixture('npm-policy.json');
for (const item of npmPolicy.cases) {
  test(`npm policy: ${item.name}`, () => {
    assert.deepEqual(codes(evaluateNpmAuditRecord(item.record)), [...item.expectedCodes].sort());
  });
}

test('npm parser accepts complete clean evidence', () => {
  const parsed = parseNpmAuditJson(npmPolicy.jsonInputs.clean);
  assert.equal(parsed.counts.total, 0);
  assert.match(parsed.fingerprint, /^[a-f0-9]{64}$/);
});

test('npm parser fails closed on malformed evidence', () => {
  assert.throws(() => parseNpmAuditJson(npmPolicy.jsonInputs.malformed));
  assert.throws(
    () => parseNpmAuditJson(npmPolicy.jsonInputs.malformedDetails),
    /detail count is inconsistent/,
  );
});

test('npm parser fails closed on registry/network error evidence', () => {
  assert.throws(() => parseNpmAuditJson(npmPolicy.jsonInputs.network), /counts are missing/);
});

const evidenceSchema = fixture('evidence-schema.json');
const schemaNow = Date.parse(evidenceSchema.now);
for (const item of evidenceSchema.schemaCases) {
  test(`evidence schema: ${item.name}`, () => {
    const schemaFindings = validateRecordedEvidenceSchema(item.evidence, { now: schemaNow });
    assert.deepEqual(
      schemaFindings.map(({ code, severity, path }) => ({ code, severity, path })),
      item.expectedPaths.map((path) => ({
        code: 'EVIDENCE_SCHEMA_INVALID',
        severity: 'critical',
        path,
      })),
    );

    const auditedSchemaFindings = auditRecordedEvidence(item.evidence, {
      nodeVersion: '22',
      now: schemaNow,
    }).filter((finding) => finding.code === 'EVIDENCE_SCHEMA_INVALID');
    assert.deepEqual(auditedSchemaFindings, schemaFindings);
  });
}

test('recorded evidence audit preserves valid but genuinely red evidence', () => {
  const result = auditRecordedEvidence(evidenceSchema.validRedEvidence, {
    nodeVersion: '22',
    now: schemaNow,
  });
  assert.equal(
    result.some((finding) => finding.code === 'EVIDENCE_SCHEMA_INVALID'),
    false,
  );
  assert.equal(
    result.some((finding) => finding.code === 'NPM_VULNERABILITIES_OPEN'),
    true,
  );
  assert.equal(
    result.some((finding) => finding.code === 'EVIDENCE_MISSING'),
    true,
  );
  assert.equal(result.some((finding) => finding.code === 'EOL_RUNTIME'), true);
  assert.equal(
    result.every((finding) => finding.severity === 'critical'),
    true,
  );

  const pinned = auditRecordedEvidence(evidenceSchema.validRedEvidence, {
    nodeVersion: '22.23.1',
    now: schemaNow,
  });
  assert.equal(pinned.some((finding) => finding.code === 'EOL_RUNTIME'), true);
});

test('OCI Stage A manifest evidence must cover every current reference with no side effects', () => {
  const evidence = JSON.parse(
    readFileSync(join(HERE, '..', 'docs/security/supply-chain-evidence.json'), 'utf8'),
  );
  const valid = auditRecordedEvidence(evidence, {
    nodeVersion: evidence.runtime.node22.configured,
    executingNodeVersion: evidence.runtime.node22.executing,
    now: Date.parse(evidence.generatedAt),
  });
  assert.equal(valid.some((finding) => finding.code === 'EVIDENCE_SCHEMA_INVALID'), false);

  for (const alter of [
    (candidate) => { candidate.containers.stageA.manifestReview.completedReferences = 12; },
    (candidate) => { candidate.containers.stageA.manifestReview.verifiedReferences[0] = 'node:22-alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; },
    (candidate) => { candidate.containers.stageA.manifestReview.verifiedReferences[1] = candidate.containers.stageA.manifestReview.verifiedReferences[0]; },
    (candidate) => { candidate.containers.stageA.sideEffects.imagesBuilt = true; },
  ]) {
    const altered = structuredClone(evidence);
    alter(altered);
    const invalid = auditRecordedEvidence(altered, {
      nodeVersion: evidence.runtime.node22.configured,
      executingNodeVersion: evidence.runtime.node22.executing,
      now: Date.parse(evidence.generatedAt),
    });
    assert.equal(invalid.some((finding) => finding.code === 'EVIDENCE_SCHEMA_INVALID'), true);
  }
});

test('OCI image trust policy accepts clean, attested images and flags each policy breach', () => {
  const policy = JSON.parse(
    readFileSync(join(HERE, '..', 'docs/security/oci-image-trust-policy.json'), 'utf8'),
  );
  const node = 'node:22-alpine@sha256:' + 'a'.repeat(64);
  const devTool = 'adminer:4@sha256:' + 'b'.repeat(64);
  const now = Date.parse('2026-11-10T00:00:00Z');
  const record = (reference, source, scan) => ({
    reference,
    signature: { tool: 'cosign tree', status: 'NONE_PUBLISHED' },
    provenance: {
      status: 'PRESENT',
      builders: ['https://github.com/docker-library'],
      sources: [`${source}#0000000000000000000000000000000000000000:22/alpine3.24`],
    },
    scan,
  });
  const cleanScan = {
    os: { family: 'alpine', name: '3.24.4', eosl: false },
    osFixableCritical: 0,
    osFixableHigh: 0,
    languageFindings: [
      { id: 'CVE-1', severity: 'HIGH', location: 'usr/local/lib/node_modules/npm/node_modules/glob/package.json' },
    ],
  };
  const trust = {
    schemaVersion: 1,
    recordedAt: '2026-11-08T00:00:00Z',
    images: [
      record(node, 'https://github.com/nodejs/docker-node.git', cleanScan),
      // Dev-only images are not held to the vulnerability rules.
      record(devTool, 'https://github.com/TimWolla/docker-adminer.git', {
        ...cleanScan,
        osFixableCritical: 3,
      }),
    ],
  };
  assert.deepEqual(auditImageTrust([node, devTool], trust, policy, { now }), []);

  const breach = (alter, references = [node, devTool]) => {
    const altered = structuredClone(trust);
    alter(altered);
    return codes(auditImageTrust(references, altered, policy, { now }));
  };
  assert.deepEqual(breach(() => {}, [node, devTool, 'redis-commander:latest@sha256:' + 'c'.repeat(64)]), ['IMAGE_EVIDENCE_MISSING']);
  assert.deepEqual(breach((t) => { t.recordedAt = '2026-09-01T00:00:00Z'; }), ['STALE_IMAGE_SCAN']);
  assert.deepEqual(breach((t) => { t.images[0].provenance.builders = ['https://example.com']; }), ['PROVENANCE_MISMATCH']);
  assert.deepEqual(breach((t) => { t.images[0].provenance.sources = ['https://github.com/attacker/docker-node.git#1']; }), ['PROVENANCE_MISMATCH']);
  assert.deepEqual(breach((t) => { t.images[0].provenance = { status: 'ABSENT', builders: [], sources: [] }; }), ['PROVENANCE_MISMATCH']);
  assert.deepEqual(breach((t) => { t.images[0].scan.osFixableHigh = 1; }), ['IMAGE_VULNERABILITIES_OPEN']);
  assert.deepEqual(breach((t) => { t.images[0].scan.os.eosl = true; }), ['EOL_IMAGE_OS']);
  assert.deepEqual(
    breach((t) => { t.images[0].scan.languageFindings.push({ id: 'CVE-2', severity: 'CRITICAL', location: 'app/node_modules/x/package.json' }); }),
    ['IMAGE_VULNERABILITIES_OPEN'],
  );
  assert.deepEqual(
    codes(auditImageTrust([node], trust, policy, { now: Date.parse('2026-12-09T00:00:00Z') })),
    ['ACCEPTED_RISK_EXPIRED', 'STALE_IMAGE_SCAN'],
  );
  assert.deepEqual(codes(auditImageTrust([node], null, policy, { now })), ['EVIDENCE_MISSING']);
  const unlisted = 'ghcr.io/example/tool:1@sha256:' + 'd'.repeat(64);
  assert.deepEqual(
    breach((t) => { t.images.push(record(unlisted, 'https://github.com/example/tool.git', cleanScan)); }, [node, unlisted]),
    ['IMAGE_NOT_ALLOWED'],
  );
});
