#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultEvidencePath = resolve(repositoryRoot, 'docs/operations/closed-beta-gate-evidence.json');
export const requiredGateIds = Object.freeze([
  'quality',
  'unit-invariant',
  'api-integration',
  'rls-isolation',
  'web-e2e',
  'discord-e2e',
  'concurrency-redelivery',
  'event-hash',
  'snapshot-hash',
  'rollback',
  'incident-response',
  'backup-restore',
  'market-replay-rebuild',
  'wipe-resume',
]);

const immutableShaPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFullCommitSha(value) {
  return typeof value === 'string' && immutableShaPattern.test(value);
}

function parseArguments(argv) {
  const options = { evidencePath: defaultEvidencePath, candidateSha: undefined };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--evidence') {
      if (!value) throw new Error('--evidence requires a path');
      options.evidencePath = resolve(value);
      index += 1;
      continue;
    }
    if (argument === '--candidate-sha') {
      if (!value) throw new Error('--candidate-sha requires a full SHA');
      options.candidateSha = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  return options;
}

function artifactFailurePrefix(gateId, artifactIndex) {
  return `${gateId}: evidence[${artifactIndex}]`;
}

function validateVerifiedArtifacts(gate, seenArtifactIds, seenLocators) {
  const failures = [];
  if (!Array.isArray(gate.evidence) || gate.evidence.length === 0) {
    return [`${gate.id}: no immutable CI/drill evidence`];
  }

  for (const [artifactIndex, artifact] of gate.evidence.entries()) {
    const prefix = artifactFailurePrefix(gate.id, artifactIndex);
    if (!isPlainObject(artifact)) {
      failures.push(`${prefix}: must be a structured artifact record`);
      continue;
    }

    const artifactId = artifact.id;
    if (typeof artifactId !== 'string' || artifactId.trim() === '') {
      failures.push(`${prefix}: id must be a nonempty artifact ID`);
    } else if (seenArtifactIds.has(artifactId)) {
      failures.push(`${prefix}: duplicate artifact ID ${artifactId}`);
    } else {
      seenArtifactIds.add(artifactId);
    }

    const digest = artifact.sha256;
    if (typeof digest !== 'string' || !sha256Pattern.test(digest)) {
      failures.push(`${prefix}: sha256 must be a lowercase SHA-256 digest`);
    }

    if (typeof artifact.locator !== 'string' || artifact.locator.trim() === '') {
      failures.push(`${prefix}: locator must be an immutable HTTPS URL`);
      continue;
    }

    let locator;
    try {
      locator = new URL(artifact.locator);
    } catch {
      failures.push(`${prefix}: locator must be an immutable HTTPS URL`);
      continue;
    }

    if (
      locator.protocol !== 'https:' ||
      locator.username !== '' ||
      locator.password !== '' ||
      locator.hash !== '' ||
      locator.search !== `?sha256=${digest}`
    ) {
      failures.push(`${prefix}: locator must use exactly ?sha256=<its lowercase SHA-256 digest>`);
      continue;
    }

    const canonicalLocator = locator.toString();
    if (seenLocators.has(canonicalLocator)) {
      failures.push(`${prefix}: duplicate artifact locator ${canonicalLocator}`);
    } else {
      seenLocators.add(canonicalLocator);
    }
  }

  return failures;
}

export function evaluateEvidence(evidence, { candidateShas = [] } = {}) {
  const failures = [];
  if (!isPlainObject(evidence)) return ['evidence: expected a JSON object'];

  if (evidence.schemaVersion !== 1) {
    failures.push('schemaVersion: expected exactly 1');
  }

  if (!isFullCommitSha(evidence.commitSha)) {
    failures.push('commitSha: release evidence must be a full lowercase immutable SHA');
  }

  const suppliedCandidateShas = candidateShas.filter((value) => value !== undefined && value !== '');
  for (const candidateSha of suppliedCandidateShas) {
    if (!isFullCommitSha(candidateSha)) {
      failures.push('candidate SHA: candidate context must be a full lowercase immutable SHA');
    }
  }
  const distinctCandidateShas = new Set(suppliedCandidateShas);
  if (distinctCandidateShas.size > 1) {
    failures.push('candidate SHA: supplied candidate contexts disagree');
  } else if (
    distinctCandidateShas.size === 1 &&
    isFullCommitSha(evidence.commitSha) &&
    evidence.commitSha !== suppliedCandidateShas[0]
  ) {
    failures.push('commitSha: release evidence does not match the candidate context');
  }

  if (!Array.isArray(evidence.gates)) {
    failures.push('gates: expected an array');
    return failures;
  }

  const gateCounts = new Map();
  for (const [gateIndex, gate] of evidence.gates.entries()) {
    if (!isPlainObject(gate) || typeof gate.id !== 'string') {
      failures.push(`gates[${gateIndex}]: gate record must have a string id`);
      continue;
    }
    gateCounts.set(gate.id, (gateCounts.get(gate.id) ?? 0) + 1);
    if (!requiredGateIds.includes(gate.id)) {
      failures.push(`${gate.id}: unknown gate record`);
    }
  }

  for (const id of requiredGateIds) {
    const count = gateCounts.get(id) ?? 0;
    if (count === 0) failures.push(`${id}: missing gate record`);
    if (count > 1) failures.push(`${id}: duplicate gate record`);
  }

  const seenArtifactIds = new Set();
  const seenLocators = new Set();
  for (const gate of evidence.gates) {
    if (!isPlainObject(gate) || !requiredGateIds.includes(gate.id)) continue;
    if (gate.status !== 'verified' && gate.status !== 'blocked') {
      failures.push(`${gate.id}: status must be verified or blocked`);
      continue;
    }
    if (gate.status === 'blocked') {
      failures.push(`${gate.id}: status is blocked`);
      continue;
    }
    if (gate.status === 'verified') {
      failures.push(...validateVerifiedArtifacts(gate, seenArtifactIds, seenLocators));
    }
  }

  return failures;
}

function candidateContexts(options) {
  return [options.candidateSha, process.env.CANDIDATE_SHA, process.env.GITHUB_SHA];
}

function main() {
  let options;
  let evidence;
  try {
    options = parseArguments(process.argv.slice(2));
    evidence = JSON.parse(readFileSync(options.evidencePath, 'utf8'));
  } catch (error) {
    console.error(`Closed-beta promotion is blocked: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const failures = evaluateEvidence(evidence, { candidateShas: candidateContexts(options) });
  if (failures.length > 0) {
    console.error('Closed-beta promotion is blocked:');
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
    return;
  }

  console.log(`Closed-beta evidence verified for ${evidence.commitSha}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
