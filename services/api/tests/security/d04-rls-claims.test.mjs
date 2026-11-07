import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260814000100_d01_p0_persistence/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const trustedContext = readFileSync(
  new URL('../../src/auth/trusted-command-context.ts', import.meta.url),
  'utf8',
);
const d04Migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260814000200_d04_discord_link_challenge/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const d04Rollback = readFileSync(
  new URL(
    '../../prisma/migrations/20260814000200_d04_discord_link_challenge/rollback.sql',
    import.meta.url,
  ),
  'utf8',
);

test('D01 RLS consumes only the Clerk JWT subject and derives membership server-side', () => {
  assert.match(migration, /current_setting\('request\.jwt\.claim\.sub', TRUE\)/);
  assert.match(migration, /player\."clerkUserId" = d01_clerk_subject\(\)/);
  assert.match(migration, /membership\."revokedAt" IS NULL/);
  assert.doesNotMatch(migration, /request\.jwt\.claim\.(?:role|roles|tenant|restaurant|save)/);
});

test('authenticated clients receive read-only grants and core tables have no write policy', () => {
  assert.match(migration, /GRANT SELECT ON TABLE %I TO authenticated/);
  assert.doesNotMatch(
    migration,
    /CREATE POLICY[\s\S]{0,200}FOR (?:INSERT|UPDATE|DELETE) TO authenticated/,
  );
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO service_role/);
});

test('D04 trusted context loads Player, save, and membership from persistence', () => {
  assert.match(trustedContext, /findPlayerByClerkSubject/);
  assert.match(trustedContext, /competitiveSave\.findUnique/);
  assert.match(trustedContext, /restaurantMembership\.findUnique/);
  assert.match(trustedContext, /membership\.revokedAt !== null/);
  assert.match(trustedContext, /membershipId: membership\.id/);
  assert.match(trustedContext, /kind: 'restricted'/);
});

test('D04 durable challenge migration is bounded, service-only, atomic, and reversible', () => {
  assert.match(d04Migration, /CREATE TABLE "DiscordLinkChallenge"/);
  assert.match(d04Migration, /"tokenDigest" VARCHAR\(64\) NOT NULL UNIQUE/);
  assert.match(d04Migration, /INTERVAL '10 minutes'/);
  assert.match(d04Migration, /FOR UPDATE/);
  assert.match(d04Migration, /d04_consume_discord_link_challenge/);
  assert.match(d04Migration, /challenge\."correlationId"/);
  assert.match(d04Migration, /EXCEPTION WHEN unique_violation/);
  assert.match(d04Migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(d04Migration, /REVOKE ALL ON TABLE "DiscordLinkChallenge" FROM authenticated/);
  assert.doesNotMatch(
    d04Migration,
    /GRANT [^;]*(?:SELECT|INSERT|UPDATE|DELETE)[^;]*TO authenticated/,
  );
  assert.match(d04Rollback, /DROP TABLE IF EXISTS "DiscordLinkChallenge"/);
  assert.match(d04Rollback, /DROP FUNCTION IF EXISTS d04_consume_discord_link_challenge/);
});
