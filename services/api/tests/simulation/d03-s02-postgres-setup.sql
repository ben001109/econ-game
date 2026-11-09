\set ON_ERROR_STOP on

CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;

\ir ../../prisma/migrations/20260814000100_d01_p0_persistence/migration.sql
\ir ../../prisma/migrations/20260814000200_d04_discord_link_challenge/migration.sql
\ir ../../prisma/migrations/20260814000300_d05_closed_beta_entry/migration.sql
\ir ../../prisma/migrations/20260814000400_d03_ledger_outbox/migration.sql
\ir ../../prisma/migrations/20260814000500_d03_durable_simulation/migration.sql
\ir ../../prisma/migrations/20260816000100_b2_outbox_dead_letter/migration.sql
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

BEGIN;

INSERT INTO "LedgerTransaction" (
  "id", "restaurantId", "saveId", "commandId", "actorPlayerId",
  "kind", "currency", "reason"
)
SELECT source_id, 'restaurant-a', 'save-a', source_id, 'player-a',
       'POSTING', 'TWD', 'D03-S-02 source event'
FROM unnest(ARRAY[
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000007'
]::text[]) AS source(source_id);

INSERT INTO "LedgerLine" (
  "id", "restaurantId", "saveId", "transactionId", "sequence",
  "accountCode", "direction", "amountMinor"
)
SELECT source_id || ':0', 'restaurant-a', 'save-a', source_id, 0,
       'CASH:SETTLEMENT', 'DEBIT', 1
FROM unnest(ARRAY[
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000007'
]::text[]) AS source(source_id)
UNION ALL
SELECT source_id || ':1', 'restaurant-a', 'save-a', source_id, 1,
       'EQUITY:TEST_SOURCE', 'CREDIT', 1
FROM unnest(ARRAY[
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000007'
]::text[]) AS source(source_id);

INSERT INTO "OutboxEvent" (
  "id", "restaurantId", "saveId", "transactionId", "causationCommandId", "aggregateType",
  "aggregateId", "aggregateVersion", "eventType", "eventVersion", "payload"
)
SELECT source_id, 'restaurant-a', 'save-a', source_id, source_id, 'CompetitiveSave',
       'save-a', 1,
       CASE WHEN ordinal = 6 THEN 'simulation.future.requested'
            ELSE 'simulation.versioned-replay.requested' END,
       1,
       CASE WHEN ordinal = 7 THEN '{"malformed":true}'::jsonb ELSE jsonb_build_object(
         'schemaVersion', 'd03-versioned-replay-request/v1',
         'jobId', '20000000-0000-4000-8000-' || lpad(ordinal::text, 12, '0'),
         'jobKind', 'MARKET_TICK',
         'businessKey', 'save-a:2:SUPPLY_PRICE',
         'replay', jsonb_build_object(
           'schemaVersion', 'd03-versioned-replay-job/v1',
           'replayKind', 'MARKET_TICK',
           'businessDay', 2,
           'rule', jsonb_build_object(
             'kind', 'RULE',
             'key', 'MARKET_PRICE',
             'version', CASE WHEN ordinal = 3 THEN 'market-rule/missing' ELSE 'market-rule/v1' END
           ),
           'catalogs', jsonb_build_array(jsonb_build_object(
             'kind', 'CATALOG',
             'key', 'INGREDIENT_PRICE',
             'version', 'ingredient-catalog/v1'
           )),
           'replayPayload', jsonb_build_object(
             'saveId', 'save-a',
             'marketSeed', 'seed-a',
             'tickKind', 'SUPPLY_PRICE',
             'prngCursor', 0
           )
         )
       ) END
FROM unnest(ARRAY[
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000007'
]::text[]) WITH ORDINALITY AS source(source_id, ordinal);

COMMIT;

RESET ROLE;
