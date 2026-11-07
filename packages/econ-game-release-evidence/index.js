import { createHash } from 'node:crypto';

export const RELEASE_EVIDENCE_VERSION = 'mvp-release-evidence-v1';

export const DAY_END_FIXED_FIELDS = Object.freeze([
  'dayIndex',
  'grossRevenue',
  'cogs',
  'wasteLoss',
  'payroll',
  'opex',
  'tax',
  'debtDue',
  'riskPenalty',
  'riskPenaltyCalculation',
  'dailyNet',
  'resolutionComparisonShortfall',
  'shortfall',
  'cashAfter',
  'reputation',
  'riskTags',
  'riskState',
  'highRiskRevenueEnabled',
  'leaderboardEligible',
]);

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalizeReleaseEvidence(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('release evidence cannot contain a non-finite number');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeReleaseEvidence(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalizeReleaseEvidence(nested)}`)
      .join(',')}}`;
  }
  throw new Error('release evidence contains an unsupported value');
}

function sha256(canonicalPayload) {
  return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}

export function hashReleaseEvidenceEvents(events) {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const seen = new Set();
  for (const event of ordered) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || seen.has(event.sequence)) {
      throw new Error('replay event sequence must contain unique non-negative safe integers');
    }
    seen.add(event.sequence);
    if (typeof event.simulationRuleVersion !== 'string' || event.simulationRuleVersion.trim().length === 0) {
      throw new Error('every replay event must include a simulation rule version');
    }
    if (typeof event.type !== 'string' || event.type.trim().length === 0) {
      throw new Error('every replay event must include a type');
    }
  }
  return sha256(
    canonicalizeReleaseEvidence({
      version: RELEASE_EVIDENCE_VERSION,
      events: ordered,
    }),
  );
}

function validateFinalResourceVersions(versions) {
  if (!isPlainObject(versions)) throw new Error('final resource versions must be an object');
  const entries = Object.entries(versions);
  if (entries.length === 0) throw new Error('final resource versions are required');
  for (const [resource, version] of entries) {
    if (resource.trim().length === 0) {
      throw new Error('final resource version keys must be non-empty');
    }
    if (typeof version === 'number') {
      if (!Number.isSafeInteger(version) || version < 0) {
        throw new Error(`${resource} final resource version must be a non-negative safe integer`);
      }
    } else if (typeof version !== 'string' || version.trim().length === 0) {
      throw new Error(`${resource} final resource version must be non-empty`);
    }
  }
}

export function hashReleaseEvidenceSnapshot(fixedFieldSnapshot, finalResourceVersions) {
  if (!isPlainObject(fixedFieldSnapshot)) {
    throw new Error('day replay snapshot evidence must be an object');
  }
  validateFinalResourceVersions(finalResourceVersions);
  for (const field of DAY_END_FIXED_FIELDS) {
    if (!Object.hasOwn(fixedFieldSnapshot, field)) {
      throw new Error(`day-end snapshot is missing ${field}`);
    }
  }
  const snapshot = Object.fromEntries(
    DAY_END_FIXED_FIELDS.map((field) => [field, fixedFieldSnapshot[field]]),
  );
  return sha256(
    canonicalizeReleaseEvidence({
      version: RELEASE_EVIDENCE_VERSION,
      snapshot,
      finalResourceVersions,
    }),
  );
}
