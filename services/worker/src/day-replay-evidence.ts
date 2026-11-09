import {
  canonicalizeReleaseEvidence,
  hashReleaseEvidenceEvents,
  hashReleaseEvidenceSnapshot,
  RELEASE_EVIDENCE_VERSION,
  type CanonicalEvidenceEvent,
} from '@econ-game/release-evidence';

import type { JsonObject, SimulationDatabase } from './simulation-platform.js';

export const DAY_REPLAY_EVIDENCE_RULE_KEY = 'DAY_REPLAY_EVIDENCE' as const;
export const DAY_REPLAY_EVIDENCE_RULE_VERSION = RELEASE_EVIDENCE_VERSION;
export const DAY_REPLAY_EVIDENCE_PROCESSOR_ID = 'E05_DAY_REPLAY_SHA256_V1' as const;
export const DAY_REPLAY_LOCATOR_VERSION = 'p0-day-replay-locator/v1' as const;
export const DAY_REPLAY_RESULT_VERSION = 'e05-day-replay-verification/v1' as const;

export const DAY_REPLAY_RULE_PAYLOAD = Object.freeze({
  evidenceVersion: DAY_REPLAY_EVIDENCE_RULE_VERSION,
  locatorSchemaVersion: DAY_REPLAY_LOCATOR_VERSION,
  resultSchemaVersion: DAY_REPLAY_RESULT_VERSION,
}) satisfies JsonObject;

export type DayReplayLocator = Readonly<{
  businessDay: number;
  dayEndSnapshotId: string;
  eventHash: string;
  saveId: string;
  snapshotHash: string;
}>;

export type DayReplaySourceSnapshot = Readonly<{
  id: string;
  businessDay: number;
  eventHash: string;
  snapshotHash: string;
  fixedFieldSnapshot: unknown;
  finalResourceVersions: unknown;
}>;

export type DayReplaySourceEvent = Readonly<{
  sequence: number;
  eventType: string;
  simulationRuleVersion: string;
  payload: unknown;
  eventHash: string;
}>;

export type DayReplaySourceRecord = Readonly<{
  snapshot: DayReplaySourceSnapshot;
  events: readonly DayReplaySourceEvent[];
}>;

export interface DayReplayEvidenceSource {
  load(
    input: Readonly<{
      restaurantId: string;
      saveId: string;
      businessDay: number;
      dayEndSnapshotId: string;
    }>,
  ): Promise<DayReplaySourceRecord | undefined>;
}

type SnapshotRow = DayReplaySourceSnapshot;

export class PostgresDayReplayEvidenceSource implements DayReplayEvidenceSource {
  constructor(private readonly database: SimulationDatabase) {}

  async load(
    input: Readonly<{
      restaurantId: string;
      saveId: string;
      businessDay: number;
      dayEndSnapshotId: string;
    }>,
  ): Promise<DayReplaySourceRecord | undefined> {
    return this.database.$transaction(async (transaction) => {
      const snapshotRows = await transaction.$queryRawUnsafe<readonly SnapshotRow[]>(
        `/* e05-day-replay:scoped-snapshot */
         SELECT snapshot."id", snapshot."businessDay", snapshot."eventHash",
                snapshot."snapshotHash", snapshot."fixedFieldSnapshot",
                snapshot."finalResourceVersions"
         FROM "DayEndSnapshot" snapshot
         JOIN "BusinessDay" day
           ON day."restaurantId" = snapshot."restaurantId"
          AND day."saveId" = snapshot."saveId"
          AND day."businessDay" = snapshot."businessDay"
         JOIN "CompetitiveSave" save
           ON save."restaurantId" = snapshot."restaurantId"
          AND save."id" = snapshot."saveId"
         WHERE snapshot."restaurantId" = $1
           AND snapshot."saveId" = $2
           AND snapshot."businessDay" = $3
           AND snapshot."id" = $4
           AND day."status" = 'SETTLED'
           AND save."retiredAt" IS NULL
         FOR SHARE OF snapshot, day, save`,
        input.restaurantId,
        input.saveId,
        input.businessDay,
        input.dayEndSnapshotId,
      );
      const snapshot = snapshotRows[0];
      if (!snapshot || snapshotRows.length !== 1) return undefined;

      const events = await transaction.$queryRawUnsafe<readonly DayReplaySourceEvent[]>(
        `/* e05-day-replay:scoped-events */
         SELECT event."sequence", event."eventType", event."simulationRuleVersion",
                event."payload", event."eventHash"
         FROM "ReplayEvent" event
         WHERE event."restaurantId" = $1
           AND event."saveId" = $2
           AND event."businessDay" = $3
         ORDER BY event."sequence" ASC
         FOR SHARE OF event`,
        input.restaurantId,
        input.saveId,
        input.businessDay,
      );
      return Object.freeze({
        snapshot: Object.freeze({ ...snapshot }),
        events: Object.freeze([...events]),
      });
    });
  }
}

export { canonicalizeReleaseEvidence };
export type DayReplayCanonicalEvent = CanonicalEvidenceEvent;

export function hashDayReplayEvents(events: readonly DayReplayCanonicalEvent[]): string {
  return hashReleaseEvidenceEvents(events);
}

export function hashDayReplaySnapshot(
  fixedFieldSnapshot: unknown,
  finalResourceVersions: unknown,
): string {
  return hashReleaseEvidenceSnapshot(
    fixedFieldSnapshot as Readonly<Record<string, unknown>>,
    finalResourceVersions as Readonly<Record<string, string | number>>,
  );
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export const unavailableDayReplaySource: DayReplayEvidenceSource = Object.freeze({
  async load() {
    return undefined;
  },
});
