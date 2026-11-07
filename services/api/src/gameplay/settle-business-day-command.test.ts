import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  BUSINESS_DAY_SETTLED_EVENT_TYPE,
  SETTLE_BUSINESS_DAY,
  createSettleBusinessDayCommandHandler,
  parseSettleBusinessDayIntent,
} from './settle-business-day-command.js';

test('accepts only the exact first-day settlement intent', () => {
  assert.deepEqual(parseSettleBusinessDayIntent({ businessDay: 1 }), { businessDay: 1 });
  for (const value of [
    {},
    { businessDay: 2 },
    { businessDay: 1, revenue: '1' },
    { businessDay: 1, riskState: 'NORMAL' },
    Object.assign(Object.create(null), { businessDay: 1 }),
  ]) {
    assert.throws(() => parseSettleBusinessDayIntent(value));
  }
});

test('registers a synchronous settlement handler and a non-job event type', () => {
  const handler = createSettleBusinessDayCommandHandler();
  assert.equal(handler.commandType, SETTLE_BUSINESS_DAY);
  assert.equal(BUSINESS_DAY_SETTLED_EVENT_TYPE, 'gameplay.business-day.settled');
  assert.equal(BUSINESS_DAY_SETTLED_EVENT_TYPE.includes('replay'), false);
  assert.equal(BUSINESS_DAY_SETTLED_EVENT_TYPE.includes('job'), false);
});

test('repository, command, and D03 retain locked-record, balanced-ledger, redaction, and error contracts', async () => {
  const [command, repository, d03] = await Promise.all([
    readFile(new URL('./settle-business-day-command.ts', import.meta.url), 'utf8'),
    readFile(new URL('./prisma-settle-business-day-repository.ts', import.meta.url), 'utf8'),
    readFile(new URL('../domains/ledger/postgres-ledger-store.ts', import.meta.url), 'utf8'),
  ]);
  for (const contract of [
    'resolveMvpFirstDaySettlementPolicy',
    'composeDayEvidence',
    'cashBeforeE05RiskPenalty',
    "kind: 'ledger.posting/v1'",
    "eventType: BUSINESS_DAY_SETTLED_EVENT_TYPE",
  ]) assert.ok(command.includes(contract), contract);
  for (const hidden of ['demandSeed', 'inventoryState', 'inventoryOutcomes', 'grossRevenue', 'cogs']) {
    const publicProjection = command.slice(command.indexOf('const publicRisk'), command.indexOf('return Object.freeze({\n        aggregateVersion'));
    assert.equal(publicProjection.includes(hidden), false, `${hidden} leaked in public projection`);
  }
  assert.equal(command.includes('outbox.job-request/v1'), false);
  assert.equal(repository.includes('SimulationJob'), false);
  for (const marker of [
    'settle-business-day:latest-risk',
    'settle-business-day:waste-stock',
    'settle-business-day:insert-replay-event',
    'settle-business-day:insert-day-end',
    'settle-business-day:insert-risk-state',
    'settle-business-day:insert-reputation-history',
    'settle-business-day:transition-day',
  ]) assert.ok(repository.includes(marker), marker);
  assert.ok(d03.includes("constraint === 'BusinessDay_settled_evidence_check'"));
  assert.ok(d03.includes("throw new CommandError(409, 'SETTLEMENT_EVIDENCE_CONFLICT')"));
});

test('paired migration makes SETTLED evidence complete and rollback fail closed', async () => {
  const root = new URL('../../prisma/migrations/20260823000200_settle_business_day_guards/', import.meta.url);
  const [forward, rollback] = await Promise.all([
    readFile(new URL('migration.sql', root), 'utf8'),
    readFile(new URL('rollback.sql', root), 'utf8'),
  ]);
  for (const contract of [
    'BusinessDay_settled_evidence_check',
    "'BUSINESS_DAY_OPENED'",
    "'INVENTORY_DAY_FINALIZED'",
    "'DAY_END_SETTLED'",
    "'RISK_DAY_FINALIZED'",
    '"DayEndSnapshot"',
    '"RiskState"',
    '"ReputationDimensionHistory"',
    'NUMERIC(9,6)',
  ]) assert.ok(forward.includes(contract), contract);
  assert.ok(rollback.includes('rollback refused: settlement evidence exists'));
  assert.ok(rollback.includes('DROP TRIGGER IF EXISTS "BusinessDay_settled_evidence_guard"'));
});
