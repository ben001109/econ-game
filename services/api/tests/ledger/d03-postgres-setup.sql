\set ON_ERROR_STOP on

CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;

\ir ../../prisma/migrations/20260814000100_d01_p0_persistence/migration.sql
\ir ../../prisma/migrations/20260814000200_d04_discord_link_challenge/migration.sql
\ir ../../prisma/migrations/20260814000300_d05_closed_beta_entry/migration.sql
\ir ../../prisma/migrations/20260814000400_d03_ledger_outbox/migration.sql
\ir ../../prisma/migrations/20260814000500_d03_durable_simulation/migration.sql
\ir ../../prisma/migrations/20260818000100_d03_generic_durable_command/migration.sql

SET ROLE service_role;

INSERT INTO "Player" ("id", "clerkUserId", "displayName") VALUES
  ('player-a', 'clerk-a', 'Player A'),
  ('player-b', 'clerk-b', 'Player B');

INSERT INTO "Restaurant" ("id", "name") VALUES
  ('restaurant-a', 'Restaurant A'),
  ('restaurant-b', 'Restaurant B');

INSERT INTO "RestaurantMembership" (
  "id", "playerId", "restaurantId", "role"
) VALUES
  ('membership-a', 'player-a', 'restaurant-a', 'OWNER'),
  ('membership-b', 'player-b', 'restaurant-b', 'OWNER');

INSERT INTO "CompetitiveSave" (
  "id", "restaurantId", "ownerPlayerId", "mode", "version",
  "openingScenario", "operatingMode", "servicePeriodPlan", "difficultyGroup",
  "demandSeed", "simulationRuleVersion", "openingSnapshot", "openingSnapshotHash"
) VALUES
  (
    'save-a', 'restaurant-a', 'player-a', 'COMPETITIVE', 1,
    'DEFAULT_SMALL_SHOP', 'LOCKED', 'DINNER', 'STANDARD',
    'seed-a', 'mvp-e01-v1', '{}'::jsonb, repeat('a', 64)
  ),
  (
    'save-b', 'restaurant-b', 'player-b', 'COMPETITIVE', 1,
    'DEFAULT_SMALL_SHOP', 'LOCKED', 'DINNER', 'STANDARD',
    'seed-b', 'mvp-e01-v1', '{}'::jsonb, repeat('b', 64)
  );

RESET ROLE;
