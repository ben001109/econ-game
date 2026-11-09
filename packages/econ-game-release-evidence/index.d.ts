export type CanonicalEvidenceValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalEvidenceValue[]
  | Readonly<{ [key: string]: CanonicalEvidenceValue }>;

export type CanonicalEvidenceEvent = Readonly<{
  sequence: number;
  simulationRuleVersion: string;
  type: string;
  payload: CanonicalEvidenceValue;
}>;

export type FinalResourceVersions = Readonly<Record<string, string | number>>;

export declare const RELEASE_EVIDENCE_VERSION: 'mvp-release-evidence-v1';
export declare const DAY_END_FIXED_FIELDS: readonly [
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
];

export declare function canonicalizeReleaseEvidence(value: unknown): string;
export declare function hashReleaseEvidenceEvents(
  events: readonly CanonicalEvidenceEvent[],
): string;
export declare function hashReleaseEvidenceSnapshot(
  fixedFieldSnapshot: Readonly<Record<string, unknown>>,
  finalResourceVersions: FinalResourceVersions,
): string;
