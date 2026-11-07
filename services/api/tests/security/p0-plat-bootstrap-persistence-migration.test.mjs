import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260817000300_p0_plat_bootstrap_persistence/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const rollback = readFileSync(
  new URL(
    '../../prisma/migrations/20260817000300_p0_plat_bootstrap_persistence/rollback.sql',
    import.meta.url,
  ),
  'utf8',
);
const playerCommandMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260817000400_p0_plat_bootstrap_player_command_state/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const playerCommandRollback = readFileSync(
  new URL(
    '../../prisma/migrations/20260817000400_p0_plat_bootstrap_player_command_state/rollback.sql',
    import.meta.url,
  ),
  'utf8',
);
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');

test('forward and rollback pair only the additive bootstrap persistence objects', () => {
  for (const objectName of [
    'BootstrapProvisioningStatus',
    'BootstrapAuthority',
    'BootstrapProvisioningEpoch',
  ]) {
    assert.match(migration, new RegExp(`(?:TYPE|TABLE) "${objectName}"`));
    assert.match(rollback, new RegExp(`DROP (?:TYPE|TABLE) IF EXISTS "${objectName}"`));
  }
  assert.match(rollback, /rollback refused: BootstrapAuthority evidence exists/);
  assert.match(rollback, /rollback refused: BootstrapProvisioningEpoch evidence exists/);
  assert.ok(
    rollback.indexOf('rollback refused: BootstrapAuthority evidence exists') <
      rollback.indexOf('DROP TABLE IF EXISTS "BootstrapAuthority"'),
  );
  assert.doesNotMatch(rollback, /CASCADE/);
});

test('forward migration contains no destructive data or schema operation', () => {
  assert.doesNotMatch(migration, /^\s*(?:DELETE\s+FROM|UPDATE\s+"|TRUNCATE\b|DROP\s+)/im);
  assert.doesNotMatch(
    migration,
    /ALTER\s+TABLE\s+"(?!BootstrapAuthority|BootstrapProvisioningEpoch)/i,
  );
  assert.doesNotMatch(migration, /(?:Restaurant|CompetitiveSave).*DEFAULT\s+(?:'[^']+'|\d+)/i);
});

test('immutable authority binds one player to qualifying invite consent provenance', () => {
  assert.match(migration, /"playerId" TEXT NOT NULL UNIQUE/);
  assert.match(migration, /"cohortMembershipId" TEXT NOT NULL UNIQUE/);
  assert.match(migration, /"inviteId" TEXT NOT NULL UNIQUE/);
  assert.match(migration, /"consentDecisionId" TEXT NOT NULL UNIQUE/);
  for (const target of [
    'Player',
    'TestCohort',
    'TestCohortMembership',
    'TestCohortInvite',
    'ConsentDecision',
    'Restaurant',
  ]) {
    assert.match(migration, new RegExp(`REFERENCES "${target}"\\("id"\\) ON DELETE RESTRICT`));
  }
  assert.match(migration, /membership\."status" = 'ACTIVE'/);
  assert.match(migration, /invitation\."status" = 'CONSUMED'/);
  assert.match(migration, /decision\."decision" = 'ACCEPTED'/);
  assert.match(migration, /later\."decisionSequence" > decision\."decisionSequence"/);
  assert.match(migration, /decision\."retentionUntil" > CURRENT_TIMESTAMP/);
  assert.match(migration, /bootstrap authority provenance is immutable/);
});

test('epoch constraints bind tenant owner save audit and one active player epoch', () => {
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "BootstrapProvisioningEpoch_one_active_per_player_key"[\s\S]*WHERE "status" = 'ACTIVE'/,
  );
  assert.match(migration, /"sourceEligibilityRestaurantId" TEXT NOT NULL/);
  assert.match(migration, /"provisionedRestaurantId" TEXT NOT NULL UNIQUE/);
  assert.match(migration, /"ownerMembershipId" TEXT NOT NULL UNIQUE/);
  assert.match(migration, /"saveId" TEXT NOT NULL UNIQUE/);
  assert.match(
    migration,
    /authority\."sourceEligibilityRestaurantId" <> NEW\."provisionedRestaurantId"/,
  );
  assert.match(migration, /authority\."playerId" = NEW\."playerId"/);
  assert.doesNotMatch(
    migration,
    /authority\."sourceEligibilityRestaurantId" = NEW\."provisionedRestaurantId"/,
  );
  assert.match(migration, /membership\."restaurantId" = NEW\."provisionedRestaurantId"/);
  assert.match(migration, /membership\."playerId" = NEW\."playerId"/);
  assert.match(migration, /save_row\."restaurantId" = NEW\."provisionedRestaurantId"/);
  assert.match(migration, /save_row\."ownerPlayerId" = NEW\."playerId"/);
  assert.match(migration, /owner_audit\."restaurantId" = NEW\."provisionedRestaurantId"/);
  assert.match(migration, /owner_audit\."actorPlayerId" = NEW\."playerId"/);
  assert.match(migration, /membership\."role" = 'OWNER'/);
  assert.match(migration, /membership\."revokedAt" IS NULL/);
  assert.match(migration, /save_row\."mode" = 'COMPETITIVE'/);
  assert.match(migration, /save_row\."version" = 1/);
  assert.match(migration, /owner_audit\."targetType" = 'RestaurantMembership'/);
  assert.match(migration, /owner_audit\."targetId" = NEW\."ownerMembershipId"/);
  assert.match(migration, /bootstrap epoch provenance is immutable/);
});

test('re-entry is a same-authority forward-only predecessor chain', () => {
  assert.match(migration, /"predecessorEpochId" TEXT UNIQUE/);
  assert.match(migration, /UNIQUE \("authorityId", "epochNumber"\)/);
  assert.match(migration, /predecessor\."authorityId" <> NEW\."authorityId"/);
  assert.match(migration, /predecessor\."playerId" <> NEW\."playerId"/);
  assert.match(migration, /predecessor\."epochNumber" <> NEW\."epochNumber" - 1/);
  assert.match(migration, /predecessor\."status" <> 'CLEARED'/);
  assert.doesNotMatch(migration, /predecessor\."status" NOT IN \('RETIRED', 'CLEARED'\)/);
  assert.match(migration, /OLD\."status" = 'ACTIVE' AND NEW\."status" = 'RETIRED'/);
  assert.match(migration, /OLD\."status" = 'RETIRED' AND NEW\."status" = 'CLEARED'/);
  assert.match(migration, /transitions are forward-only ACTIVE to RETIRED to CLEARED/);
});

test('new persistence is fail-closed under RLS and explicitly represented in Prisma', () => {
  for (const table of ['BootstrapAuthority', 'BootstrapProvisioningEpoch']) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE "${table}" FROM authenticated`));
  }
  assert.doesNotMatch(migration, /CREATE POLICY/);
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE "BootstrapAuthority" TO service_role/);
  assert.match(
    migration,
    /GRANT SELECT, INSERT, UPDATE ON TABLE "BootstrapProvisioningEpoch" TO service_role/,
  );
  assert.match(schema, /enum BootstrapProvisioningStatus/);
  assert.match(schema, /model BootstrapAuthority/);
  assert.match(schema, /model BootstrapProvisioningEpoch/);
  assert.match(schema, /predecessor\s+BootstrapProvisioningEpoch\?/);
  assert.match(schema, /@@unique\(\[authorityId, epochNumber\]\)/);
});

test('static inspection does not claim transition or PostgreSQL runtime proof', () => {
  assert.doesNotMatch(import.meta.url, /postgres/i);
  assert.match(migration, /Runtime provisioning and transitions are[\s\S]*deferred/);
});

test('Player command state migration and rollback pair the additive version contract', () => {
  assert.match(playerCommandMigration, /CREATE TABLE "BootstrapPlayerCommandState"/);
  assert.match(playerCommandMigration, /ADD COLUMN "playerCommandVersion" INTEGER NOT NULL/);
  assert.match(playerCommandRollback, /DROP COLUMN IF EXISTS "playerCommandVersion"/);
  assert.match(playerCommandRollback, /DROP TABLE IF EXISTS "BootstrapPlayerCommandState"/);
  assert.match(
    playerCommandRollback,
    /rollback refused: BootstrapPlayerCommandState evidence exists/,
  );
  assert.match(
    playerCommandRollback,
    /rollback refused: versioned BootstrapProvisioningEpoch evidence exists/,
  );
  assert.doesNotMatch(playerCommandRollback, /CASCADE/);
});

test('Player version is durable monotonic state and cannot reset across epochs', () => {
  assert.match(playerCommandMigration, /"playerId" TEXT PRIMARY KEY/);
  assert.match(playerCommandMigration, /CHECK \("version" >= 0\)/);
  assert.match(playerCommandMigration, /NEW\."version" <> 0/);
  assert.match(playerCommandMigration, /NEW\."version" <> OLD\."version" \+ 1/);
  assert.match(playerCommandMigration, /cannot be deleted or reset/);
  assert.match(playerCommandMigration, /UNIQUE \("playerId", "playerCommandVersion"\)/);
  assert.match(playerCommandMigration, /epoch Player command version is immutable/);
  assert.doesNotMatch(playerCommandMigration, /authorityId[^\n]+playerCommandVersion/);
});

test('epoch and Player state form one locked CAS with deferred commit verification', () => {
  assert.match(playerCommandMigration, /WHERE state\."playerId" = NEW\."playerId"\s+FOR UPDATE/);
  assert.match(playerCommandMigration, /NEW\."playerCommandVersion" <> current_version \+ 1/);
  assert.match(
    playerCommandMigration,
    /epoch\."playerId" = NEW\."playerId"[\s\S]*epoch\."playerCommandVersion" = NEW\."version"/,
  );
  assert.match(playerCommandMigration, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(
    playerCommandMigration,
    /state\."playerId" = NEW\."playerId"[\s\S]*state\."version" = NEW\."playerCommandVersion"/,
  );
});

test('Player command state is service-only and forward migration has no destructive DML', () => {
  assert.match(
    playerCommandMigration,
    /ALTER TABLE "BootstrapPlayerCommandState" FORCE ROW LEVEL SECURITY/,
  );
  assert.match(
    playerCommandMigration,
    /REVOKE ALL ON TABLE "BootstrapPlayerCommandState" FROM authenticated/,
  );
  assert.match(
    playerCommandMigration,
    /GRANT SELECT, INSERT, UPDATE ON TABLE "BootstrapPlayerCommandState" TO service_role/,
  );
  assert.doesNotMatch(
    playerCommandMigration,
    /^\s*(?:DELETE\s+FROM|UPDATE\s+"|TRUNCATE\b|DROP\s+)/im,
  );
  assert.match(schema, /model BootstrapPlayerCommandState/);
  assert.match(schema, /playerCommandVersion\s+Int/);
  assert.match(schema, /@@unique\(\[playerId, playerCommandVersion\]\)/);
});
