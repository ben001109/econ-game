import {
  canonicalizeReleaseEvidence,
  hashReleaseEvidenceEvents,
  hashReleaseEvidenceSnapshot,
  RELEASE_EVIDENCE_VERSION,
  type CanonicalEvidenceValue,
  type FinalResourceVersions as SharedFinalResourceVersions,
} from '@econ-game/release-evidence';

import type { DayEndSnapshot } from '../day-end/day-end.js';

export { canonicalizeReleaseEvidence, RELEASE_EVIDENCE_VERSION };

export type CanonicalValue = CanonicalEvidenceValue;

export type ReplayEventForEvidence = Readonly<{
  sequence: number;
  simulationRuleVersion: string;
  type: string;
  payload: CanonicalValue;
}>;

export type FinalResourceVersions = SharedFinalResourceVersions;

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

export function hashReplayEventSequence(events: readonly ReplayEventForEvidence[]): string {
  return hashReleaseEvidenceEvents(events);
}

export function hashDayEndSnapshot(input: DayEndEvidenceInput): string {
  return hashReleaseEvidenceSnapshot(
    input.snapshot as Readonly<Record<string, unknown>>,
    input.finalResourceVersions,
  );
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
