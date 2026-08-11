import { createHash } from 'node:crypto';

import type { DayEndSnapshot } from '../day-end/day-end.js';

export const RELEASE_EVIDENCE_VERSION = 'mvp-release-evidence-v1' as const;

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | Readonly<{ [key: string]: CanonicalValue }>;

export type ReplayEventForEvidence = Readonly<{
  sequence: number;
  simulationRuleVersion: string;
  type: string;
  payload: CanonicalValue;
}>;

export type FinalResourceVersions = Readonly<Record<string, string | number>>;

export type DayEndEvidenceInput = Readonly<{
  snapshot: DayEndSnapshot;
  finalResourceVersions: FinalResourceVersions;
}>;

export type ClientReleaseEvidenceInput = Readonly<{
  client: 'WEB' | 'DISCORD';
  replayEvents: readonly ReplayEventForEvidence[];
  dayEnd: DayEndEvidenceInput;
}>;

export type ReleaseEvidenceHashes = Readonly<{
  version: typeof RELEASE_EVIDENCE_VERSION;
  eventHash: string;
  snapshotHash: string;
}>;

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalizeReleaseEvidence(value: unknown): string {
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
  if (typeof value === 'object' && isPlainObject(value)) {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalizeReleaseEvidence(nested)}`)
      .join(',')}}`;
  }
  throw new Error('release evidence contains an unsupported value');
}

function sha256(canonicalPayload: string): string {
  return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}

function canonicalReplaySequence(events: readonly ReplayEventForEvidence[]): string {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const seen = new Set<number>();
  for (const event of ordered) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || seen.has(event.sequence)) {
      throw new Error('replay event sequence must contain unique non-negative safe integers');
    }
    seen.add(event.sequence);
    if (event.simulationRuleVersion.trim().length === 0) {
      throw new Error('every replay event must include a simulation rule version');
    }
    if (event.type.trim().length === 0) throw new Error('every replay event must include a type');
  }
  return canonicalizeReleaseEvidence({
    version: RELEASE_EVIDENCE_VERSION,
    events: ordered,
  });
}

export function hashReplayEventSequence(events: readonly ReplayEventForEvidence[]): string {
  return sha256(canonicalReplaySequence(events));
}

function validateFinalResourceVersions(versions: FinalResourceVersions): void {
  const entries = Object.entries(versions);
  if (entries.length === 0) throw new Error('final resource versions are required');
  for (const [resource, version] of entries) {
    if (resource.trim().length === 0)
      throw new Error('final resource version keys must be non-empty');
    if (typeof version === 'number') {
      if (!Number.isSafeInteger(version) || version < 0) {
        throw new Error(`${resource} final resource version must be a non-negative safe integer`);
      }
    } else if (version.trim().length === 0) {
      throw new Error(`${resource} final resource version must be non-empty`);
    }
  }
}

const DAY_END_FIXED_FIELDS = Object.freeze([
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
] as const satisfies readonly (keyof DayEndSnapshot)[]);

function canonicalDayEndSnapshot(input: DayEndEvidenceInput): string {
  validateFinalResourceVersions(input.finalResourceVersions);
  const snapshot = input.snapshot as Readonly<Record<string, unknown>>;
  for (const field of DAY_END_FIXED_FIELDS) {
    if (!Object.hasOwn(snapshot, field)) throw new Error(`day-end snapshot is missing ${field}`);
  }
  return canonicalizeReleaseEvidence({
    version: RELEASE_EVIDENCE_VERSION,
    snapshot: Object.fromEntries(DAY_END_FIXED_FIELDS.map((field) => [field, snapshot[field]])),
    finalResourceVersions: input.finalResourceVersions,
  });
}

export function hashDayEndSnapshot(input: DayEndEvidenceInput): string {
  return sha256(canonicalDayEndSnapshot(input));
}

export function createReleaseEvidenceHashes(
  input: Omit<ClientReleaseEvidenceInput, 'client'>,
): ReleaseEvidenceHashes {
  return Object.freeze({
    version: RELEASE_EVIDENCE_VERSION,
    eventHash: hashReplayEventSequence(input.replayEvents),
    snapshotHash: hashDayEndSnapshot(input.dayEnd),
  });
}

export function verifyWebDiscordReleaseEvidence(
  web: ClientReleaseEvidenceInput,
  discord: ClientReleaseEvidenceInput,
): ReleaseEvidenceHashes {
  if (web.client !== 'WEB' || discord.client !== 'DISCORD') {
    throw new Error('release comparison requires WEB and DISCORD evidence in canonical order');
  }
  const webHashes = createReleaseEvidenceHashes(web);
  const discordHashes = createReleaseEvidenceHashes(discord);
  if (webHashes.eventHash !== discordHashes.eventHash) {
    throw new Error('release blocked: Web and Discord eventHash values differ');
  }
  if (webHashes.snapshotHash !== discordHashes.snapshotHash) {
    throw new Error('release blocked: Web and Discord snapshotHash values differ');
  }
  return webHashes;
}
