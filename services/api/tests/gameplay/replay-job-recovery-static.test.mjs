import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../../src/gameplay/gameplay-read-model.ts', import.meta.url),
  'utf8',
);
const integration = readFileSync(
  new URL('../../src/gameplay/gameplay-read-model.integration.test.ts', import.meta.url),
  'utf8',
);

test('replay recovery registers a static GET before the job-id polling route', () => {
  assert.match(
    source,
    /GAMEPLAY_LATEST_REPLAY_JOB_ROUTE\s*=\s*['"]\/saves\/:saveId\/replay-jobs\/latest['"]/,
  );
  assert.ok(
    source.indexOf('GAMEPLAY_LATEST_REPLAY_JOB_ROUTE,') <
      source.indexOf('GAMEPLAY_REPLAY_JOB_ROUTE,'),
  );
  assert.match(source, /parseLatestReplayQuery\(request\.query\)/);
  assert.match(source, /value\.businessDay !== '1'/);
});

test('durable recovery source is read-only, scope-linked and ambiguity-safe', () => {
  const query = source.match(
    /`\/\* gameplay-read:latest-replay-job \*\/[\s\S]*?LIMIT 2`/,
  )?.[0];
  assert.ok(query);
  assert.match(query, /JOIN "OutboxEvent" source/);
  assert.match(query, /job\."jobKind" = 'VERSIONED_REPLAY'/);
  assert.match(query, /job\."businessKey" = \$3/);
  assert.match(query, /ORDER BY job\."createdAt" DESC, job\."id" ASC/);
  assert.doesNotMatch(query, /\b(?:INSERT|UPDATE|DELETE)\b/);
  assert.match(source, /DAY_REPLAY_JOB_SELECTION_REQUIRED/);
  assert.match(source, /simulation\.versioned-replay\.requested/);
  assert.match(source, /p0-day-replay-locator\/v1/);
  assert.match(source, /sameDayReplayLocator\(jobLocator, sourceLocator\)/);
  assert.match(source, /row\.status === 'PENDING'[\s\S]*row\.errorClass === 'TRANSIENT'[\s\S]*'RETRYING'/);
  assert.match(source, /row\.status === 'FAILED' && row\.errorClass === 'PERMANENT'/);
  assert.match(source, /row\.status === 'DEAD_LETTER' && row\.errorClass === 'TRANSIENT'/);
});

test('route contract covers scope denial, Bot audit and safe pending-terminal recovery', () => {
  assert.match(integration, /READ_LATEST_DAY_REPLAY_JOB/);
  assert.match(integration, /omitBotAuditSink/);
  assert.match(integration, /CLOSED_BETA_NOT_ELIGIBLE/);
  assert.match(integration, /save-other\/replay-jobs\/latest/);
  assert.match(integration, /DAY_REPLAY_JOB_SELECTION_REQUIRED/);
  assert.match(integration, /privateField of \['inputPayload', 'sourcePayload', 'errorDetails', 'replayPayload'\]/);
});
