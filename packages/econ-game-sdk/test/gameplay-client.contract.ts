import type {
  GameplayApiClient,
  GameplayCommandInput,
  GameplayProjection,
  ReplayJobProjection,
} from '../src/index.js';

declare const api: GameplayApiClient;
void api.getLatestReplayJob('save-1', 1);
void api.getPreopenConfigurationChoices('save-1').then((choices) => {
  const plan: 'TWO_PERIODS' | 'THREE_PERIODS' = choices.save.servicePeriodPlan;
  void plan;
  // @ts-expect-error this public read model deliberately has no server identity authority.
  void choices.save.playerId;
});
// @ts-expect-error MVP recovery is deliberately pinned to the first business day.
void api.getLatestReplayJob('save-1', 2);

declare const projection: GameplayProjection;

const advance: GameplayCommandInput<{
  businessDay: 1;
  expectedPeriodKey: 'LUNCH';
  ownerAssignment: 'NONE';
}> = {
  commandId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'advance-lunch',
  expectedVersion: projection.expectedVersion,
  payload: { businessDay: 1, expectedPeriodKey: 'LUNCH', ownerAssignment: 'NONE' },
};

void advance;

// Actor and tenant scope are deliberately unavailable on client command inputs.
// @ts-expect-error actorId is server-derived and cannot enter the command body.
advance.actorId = 'forbidden';

declare const replay: ReplayJobProjection;
if (replay.terminal) {
  const terminalStatus: 'MATCH' | 'MISMATCH' | 'PERMANENT_FAILURE' | 'RETRY_EXHAUSTED' = replay.status;
  void terminalStatus;
} else {
  const pendingStatus: 'QUEUED' | 'RUNNING' | 'RETRYING' = replay.status;
  void pendingStatus;
}
