import {
  DAY_END_FIXED_FIELDS,
  canonicalizeReleaseEvidence,
  hashReleaseEvidenceEvents,
  hashReleaseEvidenceSnapshot,
  type CanonicalEvidenceEvent,
  type CanonicalEvidenceValue,
  type FinalResourceVersions,
} from '../../../../packages/econ-game-release-evidence/index.js';

/**
 * The small, server-only bridge from already-produced day results to the
 * immutable D01/D03 replay records.  It deliberately does not calculate a
 * service result, inventory movement, ledger result, or risk transition.
 */
export const DAY_EVIDENCE_COMPOSER_VERSION = 'p0-day-evidence-composer/v1' as const;

export const DAY_EVIDENCE_EVENT_TYPES = Object.freeze({
  open: 'BUSINESS_DAY_OPENED',
  servicePeriod: 'SERVICE_PERIOD_COMPLETED',
  inventory: 'INVENTORY_DAY_FINALIZED',
  dayEnd: 'DAY_END_SETTLED',
  risk: 'RISK_DAY_FINALIZED',
} as const);

export type DayEvidenceServicePeriodPlan = 'TWO_PERIODS' | 'THREE_PERIODS';
export type DayEvidenceServicePeriod = 'LUNCH' | 'OFF_PEAK' | 'DINNER';

export type DayEvidenceScope = Readonly<{
  restaurantId: string;
  saveId: string;
  businessDay: number;
}>;

/** A result producer owns this descriptor; a client cannot provide it. */
export type AuthoritativeDayEventDescriptor = Readonly<{
  eventId: string;
  localSequence: number;
  simulationRuleVersion: string;
  payload: CanonicalEvidenceValue;
}>;

export type AuthoritativeServicePeriodEvidence = Readonly<{
  period: DayEvidenceServicePeriod;
  servicePeriodExecutionId: string;
  event: AuthoritativeDayEventDescriptor;
}>;

export type AuthoritativeDayEndEvidence = Readonly<{
  event: AuthoritativeDayEventDescriptor;
  fixedFieldSnapshot: Readonly<
    Record<(typeof DAY_END_FIXED_FIELDS)[number], CanonicalEvidenceValue>
  >;
  finalResourceVersions: FinalResourceVersions;
}>;

export type ComposeDayEvidenceInput = Readonly<{
  scope: DayEvidenceScope;
  servicePeriodPlan: DayEvidenceServicePeriodPlan;
  open: AuthoritativeDayEventDescriptor;
  servicePeriods: readonly AuthoritativeServicePeriodEvidence[];
  inventory: AuthoritativeDayEventDescriptor;
  dayEnd: AuthoritativeDayEndEvidence;
  risk: AuthoritativeDayEventDescriptor;
}>;

/**
 * This is intentionally the field subset that can be inserted into
 * `ReplayEvent`.  Database IDs, timestamps, and the per-row self hash are
 * absent from canonical input and are not manufactured here.
 */
export type ReplayEventEvidenceRecord = Readonly<{
  restaurantId: string;
  saveId: string;
  businessDay: number;
  eventId: string;
  servicePeriodExecutionId?: string;
  sequence: number;
  eventType: (typeof DAY_EVIDENCE_EVENT_TYPES)[keyof typeof DAY_EVIDENCE_EVENT_TYPES];
  simulationRuleVersion: string;
  payload: CanonicalEvidenceValue;
  eventHash: string;
}>;

/**
 * The evidence columns for `DayEndSnapshot`.  The settlement handler is
 * responsible for supplying the separately-produced E05 financial columns;
 * this composer never creates or defaults them.
 */
export type DayEndEvidenceRecord = Readonly<{
  restaurantId: string;
  saveId: string;
  businessDay: number;
  fixedFieldSnapshot: Readonly<
    Record<(typeof DAY_END_FIXED_FIELDS)[number], CanonicalEvidenceValue>
  >;
  finalResourceVersions: FinalResourceVersions;
  eventHash: string;
  snapshotHash: string;
}>;

export type ComposedDayEvidence = Readonly<{
  version: typeof DAY_EVIDENCE_COMPOSER_VERSION;
  replayEvents: readonly ReplayEventEvidenceRecord[];
  dayEnd: DayEndEvidenceRecord;
}>;

type CandidateEvent = Readonly<{
  descriptor: AuthoritativeDayEventDescriptor;
  eventType: ReplayEventEvidenceRecord['eventType'];
  servicePeriodExecutionId?: string;
}>;

const canonicalPeriodsByPlan: Readonly<
  Record<DayEvidenceServicePeriodPlan, readonly DayEvidenceServicePeriod[]>
> = Object.freeze({
  TWO_PERIODS: Object.freeze([
    'LUNCH',
    'DINNER',
  ] as const satisfies readonly DayEvidenceServicePeriod[]),
  THREE_PERIODS: Object.freeze([
    'LUNCH',
    'OFF_PEAK',
    'DINNER',
  ] as const satisfies readonly DayEvidenceServicePeriod[]),
});

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing authority fields`);
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new Error(`${label} must be a non-empty identifier`);
  }
}

function assertBusinessDay(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('scope.businessDay must be a positive safe integer');
  }
}

function assertLocalSequence(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}.localSequence must be a non-negative safe integer`);
  }
}

function assertRuleVersion(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new Error(`${label}.simulationRuleVersion must be a non-empty version`);
  }
}

function cloneCanonicalValue(value: unknown, label: string): CanonicalEvidenceValue {
  try {
    // Use the authoritative runtime as the only canonical-value validator.
    canonicalizeReleaseEvidence(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not canonical release evidence: ${message}`);
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (Array.isArray(value))
    return Object.freeze(value.map((item) => cloneCanonicalValue(item, label)));
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>).map(([key, nested]) => [
        key,
        cloneCanonicalValue(nested, label),
      ]),
    ),
  );
}

function parseScope(value: unknown): DayEvidenceScope {
  assertExactKeys(value, ['restaurantId', 'saveId', 'businessDay'], 'scope');
  assertIdentifier(value.restaurantId, 'scope.restaurantId');
  assertIdentifier(value.saveId, 'scope.saveId');
  assertBusinessDay(value.businessDay);
  return Object.freeze({
    restaurantId: value.restaurantId,
    saveId: value.saveId,
    businessDay: value.businessDay,
  });
}

function parseDescriptor(value: unknown, label: string): AuthoritativeDayEventDescriptor {
  assertExactKeys(value, ['eventId', 'localSequence', 'simulationRuleVersion', 'payload'], label);
  assertIdentifier(value.eventId, `${label}.eventId`);
  assertLocalSequence(value.localSequence, label);
  assertRuleVersion(value.simulationRuleVersion, label);
  return Object.freeze({
    eventId: value.eventId,
    localSequence: value.localSequence,
    simulationRuleVersion: value.simulationRuleVersion,
    payload: cloneCanonicalValue(value.payload, `${label}.payload`),
  });
}

function parsePlan(value: unknown): DayEvidenceServicePeriodPlan {
  if (value !== 'TWO_PERIODS' && value !== 'THREE_PERIODS') {
    throw new Error('servicePeriodPlan must be TWO_PERIODS or THREE_PERIODS');
  }
  return value;
}

function parseServicePeriods(
  value: unknown,
  plan: DayEvidenceServicePeriodPlan,
): readonly AuthoritativeServicePeriodEvidence[] {
  if (!Array.isArray(value)) throw new Error('servicePeriods must be an array');
  const expectedPeriods = canonicalPeriodsByPlan[plan];
  if (value.length !== expectedPeriods.length) {
    throw new Error(
      `${plan} requires exactly ${expectedPeriods.length} service-period evidence records`,
    );
  }
  const parsed = value.map((periodEvidence, index) => {
    const label = `servicePeriods[${index}]`;
    assertExactKeys(periodEvidence, ['period', 'servicePeriodExecutionId', 'event'], label);
    const expectedPeriod = expectedPeriods[index]!;
    if (periodEvidence.period !== expectedPeriod) {
      throw new Error(
        `${plan} service periods must use canonical order ${expectedPeriods.join(',')}`,
      );
    }
    assertIdentifier(periodEvidence.servicePeriodExecutionId, `${label}.servicePeriodExecutionId`);
    return Object.freeze({
      period: expectedPeriod,
      servicePeriodExecutionId: periodEvidence.servicePeriodExecutionId,
      event: parseDescriptor(periodEvidence.event, `${label}.event`),
    });
  });
  const executionIds = new Set(parsed.map((item) => item.servicePeriodExecutionId));
  if (executionIds.size !== parsed.length)
    throw new Error('service-period execution IDs must be unique');
  return Object.freeze(parsed);
}

function parseFinalResourceVersions(value: unknown): FinalResourceVersions {
  if (!isPlainRecord(value)) throw new Error('dayEnd.finalResourceVersions must be a plain object');
  const cloned = cloneCanonicalValue(value, 'dayEnd.finalResourceVersions');
  if (!isPlainRecord(cloned))
    throw new Error('dayEnd.finalResourceVersions must be a plain object');
  const entries = Object.entries(cloned);
  if (entries.length === 0) throw new Error('dayEnd.finalResourceVersions must not be empty');
  for (const [resource, version] of entries) {
    if (resource.trim().length === 0)
      throw new Error('dayEnd.finalResourceVersions has an empty resource key');
    if (typeof version === 'number') {
      if (!Number.isSafeInteger(version) || version < 0) {
        throw new Error(`${resource} final resource version must be a non-negative safe integer`);
      }
    } else if (typeof version !== 'string' || version.trim().length === 0) {
      throw new Error(`${resource} final resource version must be a non-empty string or integer`);
    }
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string | number>);
}

function parseDayEnd(value: unknown, businessDay: number): AuthoritativeDayEndEvidence {
  assertExactKeys(value, ['event', 'fixedFieldSnapshot', 'finalResourceVersions'], 'dayEnd');
  assertExactKeys(value.fixedFieldSnapshot, DAY_END_FIXED_FIELDS, 'dayEnd.fixedFieldSnapshot');
  const fixedFieldSnapshot = cloneCanonicalValue(
    value.fixedFieldSnapshot,
    'dayEnd.fixedFieldSnapshot',
  );
  if (!isPlainRecord(fixedFieldSnapshot))
    throw new Error('dayEnd.fixedFieldSnapshot must be a plain object');
  assertBusinessDay(fixedFieldSnapshot.dayIndex);
  if (fixedFieldSnapshot.dayIndex !== businessDay) {
    throw new Error('dayEnd.fixedFieldSnapshot.dayIndex must equal scope.businessDay');
  }
  return Object.freeze({
    event: parseDescriptor(value.event, 'dayEnd.event'),
    fixedFieldSnapshot: Object.freeze(
      Object.fromEntries(
        DAY_END_FIXED_FIELDS.map((field) => [
          field,
          fixedFieldSnapshot[field] as CanonicalEvidenceValue,
        ]),
      ) as Record<(typeof DAY_END_FIXED_FIELDS)[number], CanonicalEvidenceValue>,
    ),
    finalResourceVersions: parseFinalResourceVersions(value.finalResourceVersions),
  });
}

function parseInput(value: unknown): Readonly<{
  scope: DayEvidenceScope;
  servicePeriodPlan: DayEvidenceServicePeriodPlan;
  open: AuthoritativeDayEventDescriptor;
  servicePeriods: readonly AuthoritativeServicePeriodEvidence[];
  inventory: AuthoritativeDayEventDescriptor;
  dayEnd: AuthoritativeDayEndEvidence;
  risk: AuthoritativeDayEventDescriptor;
}> {
  assertExactKeys(
    value,
    ['scope', 'servicePeriodPlan', 'open', 'servicePeriods', 'inventory', 'dayEnd', 'risk'],
    'day evidence input',
  );
  const servicePeriodPlan = parsePlan(value.servicePeriodPlan);
  const scope = parseScope(value.scope);
  return Object.freeze({
    scope,
    servicePeriodPlan,
    open: parseDescriptor(value.open, 'open'),
    servicePeriods: parseServicePeriods(value.servicePeriods, servicePeriodPlan),
    inventory: parseDescriptor(value.inventory, 'inventory'),
    dayEnd: parseDayEnd(value.dayEnd, scope.businessDay),
    risk: parseDescriptor(value.risk, 'risk'),
  });
}

function assertContiguousChronologicalSourceSequences(events: readonly CandidateEvent[]): void {
  const seen = new Set<number>();
  const sorted = [...events].sort(
    (left, right) => left.descriptor.localSequence - right.descriptor.localSequence,
  );
  for (const [index, event] of sorted.entries()) {
    const sourceSequence = event.descriptor.localSequence;
    if (seen.has(sourceSequence))
      throw new Error('day evidence contains duplicate local sequences');
    seen.add(sourceSequence);
    if (sourceSequence !== index) {
      throw new Error('day evidence local sequences must be contiguous from 0');
    }
  }
  // Requiring source category chronology prevents a forged source ordering from
  // moving a finalisation record before OPEN or a service period.
  for (const [index, event] of events.entries()) {
    if (event.descriptor.localSequence !== index) {
      throw new Error(
        'day evidence source ordering must follow OPEN, canonical periods, inventory, day end, and risk',
      );
    }
  }
}

function assertUniqueEventIds(events: readonly CandidateEvent[]): void {
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.descriptor.eventId)) throw new Error('day evidence event IDs must be unique');
    ids.add(event.descriptor.eventId);
  }
}

/**
 * Validates complete, already-authoritative day evidence and turns it into
 * immutable insert records.  It does not persist anything.
 */
export function composeDayEvidence(input: ComposeDayEvidenceInput): ComposedDayEvidence {
  const parsed = parseInput(input);
  const candidates: readonly CandidateEvent[] = Object.freeze([
    Object.freeze({ descriptor: parsed.open, eventType: DAY_EVIDENCE_EVENT_TYPES.open }),
    ...parsed.servicePeriods.map((period) =>
      Object.freeze({
        descriptor: period.event,
        eventType: DAY_EVIDENCE_EVENT_TYPES.servicePeriod,
        servicePeriodExecutionId: period.servicePeriodExecutionId,
      }),
    ),
    Object.freeze({ descriptor: parsed.inventory, eventType: DAY_EVIDENCE_EVENT_TYPES.inventory }),
    Object.freeze({ descriptor: parsed.dayEnd.event, eventType: DAY_EVIDENCE_EVENT_TYPES.dayEnd }),
    Object.freeze({ descriptor: parsed.risk, eventType: DAY_EVIDENCE_EVENT_TYPES.risk }),
  ]);

  assertContiguousChronologicalSourceSequences(candidates);
  assertUniqueEventIds(candidates);

  const canonicalEvents: readonly CanonicalEvidenceEvent[] = Object.freeze(
    candidates.map((candidate, sequence) =>
      Object.freeze({
        sequence,
        simulationRuleVersion: candidate.descriptor.simulationRuleVersion,
        type: candidate.eventType,
        payload: candidate.descriptor.payload,
      }),
    ),
  );
  const eventHash = hashReleaseEvidenceEvents(canonicalEvents);
  const snapshotHash = hashReleaseEvidenceSnapshot(
    parsed.dayEnd.fixedFieldSnapshot,
    parsed.dayEnd.finalResourceVersions,
  );
  const replayEvents = Object.freeze(
    candidates.map((candidate, sequence) =>
      Object.freeze({
        restaurantId: parsed.scope.restaurantId,
        saveId: parsed.scope.saveId,
        businessDay: parsed.scope.businessDay,
        eventId: candidate.descriptor.eventId,
        ...(candidate.servicePeriodExecutionId === undefined
          ? {}
          : { servicePeriodExecutionId: candidate.servicePeriodExecutionId }),
        sequence,
        eventType: candidate.eventType,
        simulationRuleVersion: candidate.descriptor.simulationRuleVersion,
        payload: candidate.descriptor.payload,
        eventHash,
      }),
    ),
  );
  return Object.freeze({
    version: DAY_EVIDENCE_COMPOSER_VERSION,
    replayEvents,
    dayEnd: Object.freeze({
      restaurantId: parsed.scope.restaurantId,
      saveId: parsed.scope.saveId,
      businessDay: parsed.scope.businessDay,
      fixedFieldSnapshot: parsed.dayEnd.fixedFieldSnapshot,
      finalResourceVersions: parsed.dayEnd.finalResourceVersions,
      eventHash,
      snapshotHash,
    }),
  });
}
