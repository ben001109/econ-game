import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260814000300_d05_closed_beta_entry/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const rollback = readFileSync(
  new URL(
    '../../prisma/migrations/20260814000300_d05_closed_beta_entry/rollback.sql',
    import.meta.url,
  ),
  'utf8',
);
const repository = readFileSync(
  new URL('../../src/closed-beta/prisma-closed-beta-repository.ts', import.meta.url),
  'utf8',
);
const routes = readFileSync(
  new URL('../../src/closed-beta/closed-beta-routes.ts', import.meta.url),
  'utf8',
);
const postgresRegression = readFileSync(
  new URL('./d05-closed-beta-postgres.sql', import.meta.url),
  'utf8',
);

test('consent latest-state reads use only the database identity sequence', () => {
  assert.match(migration, /"decisionSequence" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL UNIQUE/);
  assert.match(migration, /ORDER BY prior_decision\."decisionSequence" DESC LIMIT 1/);
  assert.match(migration, /ORDER BY decision\."decisionSequence" DESC\s+LIMIT 1/);
  assert.doesNotMatch(migration, /ORDER BY[^;]+"createdAt" DESC[^;]+"id" DESC/);
});

test('reward decisions form a locked one-successor chain with an effective-current query', () => {
  assert.match(migration, /"supersedesEligibilityId" TEXT,/);
  assert.match(
    migration,
    /"RewardEligibility_supersession_key" UNIQUE \("cohortId", "playerId", "rewardKind", "supersedesEligibilityId"\)/,
  );
  assert.match(migration, /"RewardEligibility_supersedes_fkey" FOREIGN KEY/);
  assert.match(migration, /FOR UPDATE OF reward/);
  assert.match(migration, /successor\."supersedesEligibilityId" = target\."id"/);
  assert.match(migration, /CREATE FUNCTION d05_effective_reward_eligibility/);
  assert.match(migration, /successor\."supersedesEligibilityId" = current_reward\."id"/);
  assert.match(
    routes,
    /'supersedesEligibilityId',[\s\S]*'eligible',[\s\S]*'source',[\s\S]*'reason'/,
  );
  assert.match(
    migration,
    /target\."policyDigest", target\."milestoneEventId", target\."evidenceSnapshot",\s+target\."evidenceHash", decision_eligible, target\."rewardKind"/,
  );
  assert.doesNotMatch(
    routes.slice(routes.indexOf("'/closed-beta/cohorts/:cohortId/reward-eligibility/decisions'")),
    /'milestoneEventId'|'evidenceSnapshot'|'rewardKind'/,
  );
});

test('server correlation is bound into every D05 audit path and client correlation is not accepted', () => {
  assert.ok((routes.match(/request\.id/g) ?? []).length >= 10);
  assert.doesNotMatch(routes, /x-correlation-id/i);
  assert.ok((repository.match(/correlationId: input\.correlationId/g) ?? []).length >= 8);
  assert.match(repository, /"targetId", "metadata", "correlationId", "createdAt"/);
  assert.equal(
    (migration.match(/INSERT INTO "AuditLog"/g) ?? []).length,
    (migration.match(/"metadata", "correlationId", "createdAt"/g) ?? []).length,
  );
  assert.match(migration, /d05_redeem_invite\([\s\S]*correlation_id TEXT/);
  assert.match(migration, /d05_record_consent_decision\([\s\S]*correlation_id TEXT/);
  assert.match(migration, /d05_record_reward_decision\([\s\S]*correlation_id TEXT/);
});

test('expired redemption writes a digest-free correlated audit and rollback removes new functions', () => {
  const expiryBranch = migration.slice(
    migration.indexOf('IF invitation."expiresAt" <= redeemed_at THEN'),
    migration.indexOf(
      'END IF;',
      migration.indexOf('IF invitation."expiresAt" <= redeemed_at THEN'),
    ),
  );
  assert.match(expiryBranch, /closed_beta_invite_expired_on_redeem/);
  assert.match(expiryBranch, /correlation_id/);
  assert.doesNotMatch(expiryBranch, /tokenDigest|presented_token_digest/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS d05_record_reward_decision/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS d05_effective_reward_eligibility/);
  assert.match(
    rollback,
    /DROP FUNCTION IF EXISTS d05_record_consent_decision\(TEXT, TEXT, "ConsentDecisionKind", TIMESTAMP, TEXT, TEXT, TEXT\)/,
  );
});

test('invite transitions lock invite before cohort and database races map to stable outcomes', () => {
  const revokeFunction = migration.slice(
    migration.indexOf('CREATE FUNCTION d05_revoke_invite'),
    migration.indexOf('CREATE FUNCTION d05_redeem_invite'),
  );
  const redeemFunction = migration.slice(
    migration.indexOf('CREATE FUNCTION d05_redeem_invite'),
    migration.indexOf('CREATE FUNCTION d05_record_consent_decision'),
  );
  for (const transition of [revokeFunction, redeemFunction]) {
    const inviteLock = transition.indexOf('FROM "TestCohortInvite"');
    const cohortLock = transition.indexOf('FROM "TestCohort"');
    assert.ok(inviteLock >= 0 && cohortLock > inviteLock);
    assert.match(transition.slice(inviteLock, cohortLock), /FOR UPDATE/);
  }
  const activation = repository.slice(
    repository.indexOf('async activateInvite'),
    repository.indexOf('async revokeInvite'),
  );
  assert.ok(activation.indexOf('lockedInvite') < activation.indexOf('lockedCohort'));
  assert.match(repository, /d05_revoke_invite\(\$1,\$2,\$3,\$4,\$5,\$6\)/);
  assert.match(repository, /'P2034', '40P01', '40001'/);
  assert.match(repository, /isRetryableDatabaseRace\(error\)\) return 'invalid'/);
  assert.match(revokeFunction, /closed_beta_invite_revoked/);
  assert.match(revokeFunction, /correlation_id/);
  assert.doesNotMatch(revokeFunction, /SELECT 'forbidden'::TEXT/);
  const repositoryRevoke = repository.slice(
    repository.indexOf('async revokeInvite'),
    repository.indexOf('async redeemInvite'),
  );
  assert.match(
    repositoryRevoke,
    /if \(rows\[0\]\?\.result === 'revoked'\) return;\s+forbidden\(\)/,
  );
  assert.match(
    rollback,
    /DROP FUNCTION IF EXISTS d05_revoke_invite\(TEXT, TEXT, TEXT, TIMESTAMP, TEXT, TEXT\)/,
  );
  assert.match(postgresRegression, /dblink_connect\('d05_revoke_race'/);
  assert.match(postgresRegression, /dblink_connect\('d05_redeem_race'/);
  assert.match(postgresRegression, /SET statement_timeout = '5s'/);
  assert.match(postgresRegression, /SELECT result FROM d05_revoke_invite/);
  assert.match(postgresRegression, /SELECT result FROM d05_redeem_invite/);
  assert.match(
    postgresRegression,
    /count\(\*\) FROM concurrent_results WHERE result IN \('redeemed', 'revoked'\)\) <> 1/,
  );
  assert.match(postgresRegression, /"metadata"->>'inviteId' = 'invite-revoke-race'\) <> 1/);
  assert.match(postgresRegression, /active_memberships > \(SELECT "quota"/);
  assert.match(postgresRegression, /terminal_outcome <> missing_outcome/);
  assert.match(postgresRegression, /cross_tenant_outcome <> missing_outcome/);
  assert.match(postgresRegression, /revoke probes were distinguishable/);
});
