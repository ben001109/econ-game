import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { requiredGateIds } from './check-closed-beta-evidence.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, 'check-closed-beta-evidence.mjs');
const CANDIDATE_SHA = 'a'.repeat(40);

function validEvidence() {
  return {
    schemaVersion: 1,
    commitSha: CANDIDATE_SHA,
    gates: requiredGateIds.map((id, index) => {
      const digest = index.toString(16).repeat(64);
      return {
        id,
        status: 'verified',
        evidence: [
          {
            id: `artifact-${id}`,
            locator: `https://evidence.example.invalid/${id}?sha256=${digest}`,
            sha256: digest,
          },
        ],
      };
    }),
  };
}

function runChecker(evidence, { candidateSha } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'econ-closed-beta-evidence-'));
  const evidencePath = join(directory, 'evidence.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8');
  const env = { ...process.env };
  delete env.CANDIDATE_SHA;
  delete env.GITHUB_SHA;
  const arguments_ = [CHECKER, '--evidence', evidencePath];
  if (candidateSha !== undefined) arguments_.push('--candidate-sha', candidateSha);

  try {
    return spawnSync(process.execPath, arguments_, { encoding: 'utf8', env });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runDefaultChecker() {
  const env = { ...process.env };
  delete env.CANDIDATE_SHA;
  delete env.GITHUB_SHA;
  return spawnSync(process.execPath, [CHECKER], { encoding: 'utf8', env });
}

function expectBlocked(evidence, expected, options) {
  const result = runChecker(evidence, options);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, expected);
}

test('a minimally complete, candidate-bound registry passes', () => {
  const result = runChecker(validEvidence(), { candidateSha: CANDIDATE_SHA });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(CANDIDATE_SHA));
});

test('the checked-in all-blocked registry remains promotion-blocking', () => {
  const result = runDefaultChecker();
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /quality: status is blocked/u);
});

test('missing, duplicate, and unknown gate records fail closed without map masking', () => {
  const missing = validEvidence();
  missing.gates = missing.gates.slice(1);
  expectBlocked(missing, /quality: missing gate record/u);

  const duplicate = validEvidence();
  duplicate.gates.push(structuredClone(duplicate.gates[0]));
  expectBlocked(duplicate, /quality: duplicate gate record/u);

  const unknown = validEvidence();
  unknown.gates[0].id = 'unapproved-gate';
  expectBlocked(unknown, /unapproved-gate: unknown gate record/u);
});

test('malformed and mismatched candidate SHA bindings fail closed', () => {
  const malformed = validEvidence();
  malformed.commitSha = 'abcdef';
  expectBlocked(malformed, /commitSha: release evidence must be a full lowercase immutable SHA/u);

  expectBlocked(validEvidence(), /does not match the candidate context/u, {
    candidateSha: 'b'.repeat(40),
  });
});

test('the registry schema version is fixed at version 1', () => {
  const missingSchemaVersion = validEvidence();
  delete missingSchemaVersion.schemaVersion;
  expectBlocked(missingSchemaVersion, /schemaVersion: expected exactly 1/u);

  const unsupportedSchemaVersion = validEvidence();
  unsupportedSchemaVersion.schemaVersion = 2;
  expectBlocked(unsupportedSchemaVersion, /schemaVersion: expected exactly 1/u);
});

test('a verified gate requires a nonempty structured immutable artifact', () => {
  const noEvidence = validEvidence();
  noEvidence.gates[0].evidence = [];
  expectBlocked(noEvidence, /quality: no immutable CI\/drill evidence/u);

  const unstructured = validEvidence();
  unstructured.gates[0].evidence = ['https://evidence.example.invalid/not-structured'];
  expectBlocked(unstructured, /must be a structured artifact record/u);

  const unboundLocator = validEvidence();
  unboundLocator.gates[0].evidence[0].locator = 'https://evidence.example.invalid/quality';
  expectBlocked(unboundLocator, /locator must use exactly \?sha256=/u);

  const percentEncodedDigest = validEvidence();
  const encodedArtifact = percentEncodedDigest.gates[11].evidence[0];
  encodedArtifact.locator = `https://evidence.example.invalid/incident-response?sha256=%62${'b'.repeat(63)}`;
  expectBlocked(percentEncodedDigest, /locator must use exactly \?sha256=/u);

  const uppercaseQueryKey = validEvidence();
  const uppercaseArtifact = uppercaseQueryKey.gates[11].evidence[0];
  uppercaseArtifact.locator = `https://evidence.example.invalid/incident-response?SHA256=${uppercaseArtifact.sha256}`;
  expectBlocked(uppercaseQueryKey, /locator must use exactly \?sha256=/u);

  const alternateQuery = validEvidence();
  const alternateArtifact = alternateQuery.gates[11].evidence[0];
  alternateArtifact.locator = `https://evidence.example.invalid/incident-response?sha256=${alternateArtifact.sha256}&source=ci`;
  expectBlocked(alternateQuery, /locator must use exactly \?sha256=/u);

  const uppercaseDigest = validEvidence();
  uppercaseDigest.gates[0].evidence[0].sha256 = 'B'.repeat(64);
  uppercaseDigest.gates[0].evidence[0].locator =
    `https://evidence.example.invalid/quality?sha256=${'B'.repeat(64)}`;
  expectBlocked(uppercaseDigest, /sha256 must be a lowercase SHA-256 digest/u);
});

test('duplicate artifact IDs and canonical locators fail closed', () => {
  const duplicateId = validEvidence();
  duplicateId.gates[1].evidence[0].id = duplicateId.gates[0].evidence[0].id;
  expectBlocked(duplicateId, /duplicate artifact ID artifact-quality/u);

  const duplicateLocator = validEvidence();
  duplicateLocator.gates[1].evidence[0].locator = duplicateLocator.gates[0].evidence[0].locator;
  duplicateLocator.gates[1].evidence[0].sha256 = duplicateLocator.gates[0].evidence[0].sha256;
  expectBlocked(duplicateLocator, /duplicate artifact locator/u);
});
