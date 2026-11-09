import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const repository = readFileSync(
  `${root}/services/api/src/closed-beta/prisma-wipe-batch-repository.ts`,
  'utf8',
);
const service = readFileSync(`${root}/services/api/src/closed-beta/wipe-batch.ts`, 'utf8');

test('D05-C derives active OWNER and all-active-save scope server-side', () => {
  assert.match(repository, /"role" = 'OWNER' AND "revokedAt" IS NULL/);
  assert.match(repository, /WHERE "restaurantId" = \$1 AND "retiredAt" IS NULL ORDER BY "id"/);
  assert.match(repository, /assertOwner\(transaction, batch\.requestedByPlayerId/);
  assert.match(repository, /assertOwner\(database, batch\.approvedByPlayerId/);
  assert.match(repository, /WIPE_DISTINCT_APPROVER_REQUIRED/);
  assert.match(
    service,
    /hashCommandRequest\(command, \{[\s\S]+actorId:[\s\S]+tenantId:[\s\S]+saveId:/,
  );
});

test('dry-run/request authority is canonical and idempotency is durable', () => {
  assert.match(service, /WIPE_SCOPE_VERSION = 'd05-wipe-scope\/v2'/);
  assert.match(repository, /SELECT DISTINCT "environment" FROM "TestCohort"/);
  assert.match(service, /WIPE_POLICY_VERSION = 'd05-complete-non-historical-save-clear\/v1'/);
  assert.match(service, /unknownFamily: 'RETAIN'/);
  assert.match(service, /externalClerkEffect: 'NONE'/);
  assert.match(repository, /WIPE_DRY_RUN_STALE/);
  assert.match(repository, /INSERT INTO "IdempotencyRecord"/);
  assert.match(repository, /IDEMPOTENCY_KEY_REUSED/);
  assert.match(repository, /EXPECTED_VERSION_CONFLICT/);
});

test('freeze and isolate use D05-B checkpoints and only retire scoped live saves', () => {
  assert.match(repository, /INSERT INTO "WipeBatchCheckpoint"/);
  assert.match(repository, /"phase", "attempt", "outcome"/);
  assert.match(repository, /JOIN "WipeBatchSaveScope" scope/);
  assert.match(repository, /SET "retiredAt" = CURRENT_TIMESTAMP/);
  assert.match(repository, /"retiredByWipeBatchId" = \$1/);
  assert.match(repository, /RETURNING "isolatedAt", "clearEligibleAt"/);
  assert.match(repository, /latest\.outcome !== 'FAILED'/);
  assert.match(repository, /latest\.phase !== 'FROZEN' && latest\.phase !== 'ISOLATED'/);
  assert.match(repository, /WIPE_RESUME_REQUIRED/);
  assert.match(repository, /'FAILED',\$6,\$7,\$8::jsonb,\$9/);
  assert.match(repository, /interruption: 'MANUAL_RESUME_REQUIRED'/);
  assert.match(repository, /latest\.attempt \+ 1/);
  assert.match(
    repository,
    /WHERE "id" = \$1 AND "restaurantId" = \$2`,\s*batch\.id,\s*input\.restaurantId/,
  );
  assert.match(repository, /batch\."lifecyclePhase" IN \('FROZEN', 'ISOLATED', 'CLEARED'\)/);
  assert.match(repository, /WIPE_SCOPE_FROZEN/);
});

test('D05-C has no clear/delete, generic job, broad account, or Clerk side effect', () => {
  assert.doesNotMatch(
    repository,
    /DELETE\s+FROM|TRUNCATE|WipeTombstone|IdentityLink|DiscordLinkChallenge/,
  );
  assert.doesNotMatch(repository, /SimulationJob|clerk\.com|deleteUser|updateUser|fetch\(/);
  assert.doesNotMatch(service, /fetch\(|clerk\.com|deleteUser|updateUser/);
  assert.doesNotMatch(
    repository,
    /UPDATE "(?:Player|RestaurantMembership|Employee|InventoryStock|Order)"/,
  );
});
