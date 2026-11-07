import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
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
});

test('OCI Stage A manifest evidence must cover every current reference with no side effects', () => {
  const evidence = JSON.parse(
    readFileSync(join(HERE, '..', 'docs/security/supply-chain-evidence.json'), 'utf8'),
  );
  const valid = auditRecordedEvidence(evidence, {
    nodeVersion: '22',
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
      nodeVersion: '22',
      executingNodeVersion: evidence.runtime.node22.executing,
      now: Date.parse(evidence.generatedAt),
    });
    assert.equal(invalid.some((finding) => finding.code === 'EVIDENCE_SCHEMA_INVALID'), true);
  }
});
