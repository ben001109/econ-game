#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidencePath = resolve(repositoryRoot, 'docs/operations/closed-beta-gate-evidence.json');
const requiredGateIds = [
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
];

const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
const gatesById = new Map(evidence.gates.map((gate) => [gate.id, gate]));
const failures = [];

for (const id of requiredGateIds) {
  const gate = gatesById.get(id);
  if (!gate) {
    failures.push(`${id}: missing gate record`);
    continue;
  }
  if (gate.status !== 'verified') failures.push(`${id}: status is ${gate.status}`);
  if (!Array.isArray(gate.evidence) || gate.evidence.length === 0) {
    failures.push(`${id}: no immutable CI/drill evidence`);
  }
}

if (evidence.commitSha === null || evidence.commitSha === '') {
  failures.push('commitSha: release evidence is not bound to a commit');
}

if (failures.length > 0) {
  console.error('Closed-beta promotion is blocked:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`Closed-beta evidence verified for ${evidence.commitSha}.`);
}
