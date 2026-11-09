import { createHash } from 'node:crypto';

import { CommandError, type CommandEnvelope } from '../commands/command-contract.js';
import type { CommandHandler, DurableCommandPersistence } from '../commands/command-dispatcher.js';

export const REQUEST_DAY_REPLAY = 'REQUEST_DAY_REPLAY' as const;
export const DAY_REPLAY_EVIDENCE_RULE_VERSION = 'mvp-release-evidence-v1' as const;
export const DAY_REPLAY_REPLAY_LOCATOR_VERSION = 'p0-day-replay-locator/v1' as const;

type DayReplayEvidenceRow = Readonly<{
  businessDay: number;
  dayEndSnapshotId: string;
  eventHash: string;
  snapshotHash: string;
}>;

type DayReplayEvidence = DayReplayEvidenceRow;

/**
 * The replay request only queues a versioned job. Its outbox body deliberately
 * carries immutable locators and evidence hashes, not ReplayEvent payloads or
 * a copied DayEndSnapshot. The worker resolves those scoped records when it
 * consumes the request.
 */
export function createRequestDayReplayCommandHandler(): CommandHandler {
  return Object.freeze({
    commandType: REQUEST_DAY_REPLAY,
    async execute({ context, command, currentVersion, persistence }) {
      const businessDay = parseRequestDayReplayIntent(command);
      const evidence = await loadDayReplayEvidence(persistence, {
        restaurantId: context.tenantId,
        saveId: context.saveId,
        businessDay,
      });
      if (!evidence) throw new CommandError(422, 'DAY_REPLAY_NOT_AVAILABLE');

      const jobId = dayReplayJobId(command.commandId);
      const replay = Object.freeze({
        schemaVersion: 'd03-versioned-replay-job/v1' as const,
        replayKind: 'DAY_REPLAY',
        businessDay: evidence.businessDay,
        rule: Object.freeze({
          kind: 'RULE' as const,
          key: 'DAY_REPLAY_EVIDENCE',
          version: DAY_REPLAY_EVIDENCE_RULE_VERSION,
        }),
        catalogs: Object.freeze([]),
        replayPayload: Object.freeze({
          schemaVersion: DAY_REPLAY_REPLAY_LOCATOR_VERSION,
          locator: Object.freeze({
            businessDay: evidence.businessDay,
            dayEndSnapshotId: evidence.dayEndSnapshotId,
            eventHash: evidence.eventHash,
            saveId: context.saveId,
            snapshotHash: evidence.snapshotHash,
          }),
        }),
      });
      const businessKey = `${context.saveId}:${evidence.businessDay}:DAY_REPLAY`;
      const payload = Object.freeze({
        businessKey,
        jobId,
        jobKind: 'VERSIONED_REPLAY',
        replay,
        schemaVersion: 'd03-versioned-replay-request/v1',
      });

      return Object.freeze({
        status: 202 as const,
        aggregateVersion: currentVersion + 1,
        jobId,
        result: Object.freeze({
          businessDay: evidence.businessDay,
          eventHash: evidence.eventHash,
          replayAvailability: 'QUEUED',
          snapshotHash: evidence.snapshotHash,
        }),
        effects: Object.freeze({
          outbox: Object.freeze([
            Object.freeze({
              kind: 'outbox.job-request/v1' as const,
              eventId: command.commandId,
              eventSequence: 0,
              eventType: 'simulation.versioned-replay.requested',
              eventVersion: 1,
              jobId,
              payload,
            }),
          ]),
        }),
      });
    },
  });
}

export function parseRequestDayReplayIntent(command: CommandEnvelope): number {
  const payload = command.payload;
  if (
    Object.keys(payload).length !== 1 ||
    !Object.hasOwn(payload, 'businessDay') ||
    typeof payload.businessDay !== 'number' ||
    !Number.isSafeInteger(payload.businessDay) ||
    payload.businessDay < 1
  ) {
    throw new CommandError(422, 'DAY_REPLAY_REQUEST_INVALID');
  }
  return payload.businessDay;
}

async function loadDayReplayEvidence(
  persistence: DurableCommandPersistence,
  input: Readonly<{ restaurantId: string; saveId: string; businessDay: number }>,
): Promise<DayReplayEvidence | undefined> {
  const rows = await persistence.mutate<readonly DayReplayEvidenceRow[]>(
    `/* request-day-replay:evidence */
     SELECT day."businessDay", snapshot."id" AS "dayEndSnapshotId",
            snapshot."eventHash", snapshot."snapshotHash"
     FROM "BusinessDay" day
     JOIN "DayEndSnapshot" snapshot
       ON snapshot."restaurantId" = day."restaurantId"
      AND snapshot."saveId" = day."saveId"
      AND snapshot."businessDay" = day."businessDay"
     WHERE day."restaurantId" = $1
       AND day."saveId" = $2
       AND day."businessDay" = $3
       AND day."status" = 'SETTLED'
       AND (
         SELECT COUNT(*) FROM "DayEndSnapshot" candidate
         WHERE candidate."restaurantId" = day."restaurantId"
           AND candidate."saveId" = day."saveId"
           AND candidate."businessDay" = day."businessDay"
       ) = 1
       AND EXISTS (
         SELECT 1 FROM "ReplayEvent" event
         WHERE event."restaurantId" = day."restaurantId"
           AND event."saveId" = day."saveId"
           AND event."businessDay" = day."businessDay"
       )
     FOR SHARE OF day, snapshot`,
    input.restaurantId,
    input.saveId,
    input.businessDay,
  );
  const evidence = rows[0];
  if (
    rows.length !== 1 ||
    !evidence ||
    evidence.businessDay !== input.businessDay ||
    !isNonEmptyBoundedString(evidence.dayEndSnapshotId, 200) ||
    !isSha256(evidence.eventHash) ||
    !isSha256(evidence.snapshotHash)
  ) {
    return undefined;
  }
  return Object.freeze({ ...evidence });
}

/** RFC 4122 UUIDv5 with a fixed DNS namespace and an explicit command domain. */
export function dayReplayJobId(commandId: string): string {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const name = Buffer.from(`econ-game:request-day-replay:${commandId}`, 'utf8');
  const digest = createHash('sha1').update(namespace).update(name).digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isNonEmptyBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}
