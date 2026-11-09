\set ON_ERROR_STOP on

CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;

\ir ../../prisma/migrations/20260814000100_d01_p0_persistence/migration.sql

SET ROLE service_role;
INSERT INTO "Player" ("id", "clerkUserId", "displayName") VALUES
  ('player-a', 'clerk-a', 'Player A'),
  ('player-b', 'clerk-b', 'Player B');
INSERT INTO "Restaurant" ("id", "name") VALUES
  ('restaurant-a', 'Restaurant A'),
  ('restaurant-b', 'Restaurant B');
INSERT INTO "RestaurantMembership" ("id", "playerId", "restaurantId", "role") VALUES
  ('membership-a', 'player-a', 'restaurant-a', 'OWNER'),
  ('membership-b', 'player-b', 'restaurant-b', 'OWNER');
INSERT INTO "CompetitiveSave" (
  "id", "restaurantId", "ownerPlayerId", "mode", "openingScenario",
  "operatingMode", "servicePeriodPlan", "difficultyGroup", "demandSeed",
  "simulationRuleVersion", "openingSnapshot", "openingSnapshotHash"
) VALUES
  ('save-a', 'restaurant-a', 'player-a', 'COMPETITIVE', 'EMPTY_PREMISES',
   'STANDARD', 'TWO_PERIOD', 'NORMAL', 'seed-a', 'rules-v1', '{}', repeat('a', 64)),
  ('save-b', 'restaurant-b', 'player-b', 'COMPETITIVE', 'DEFAULT_SMALL_SHOP',
   'STANDARD', 'THREE_PERIOD', 'NORMAL', 'seed-b', 'rules-v1', '{}', repeat('b', 64));
INSERT INTO "Branch" ("id", "restaurantId", "name") VALUES
  ('branch-a', 'restaurant-a', 'Branch A'),
  ('branch-b', 'restaurant-b', 'Branch B');
INSERT INTO "MenuItem" ("id", "restaurantId", "branchId", "sku", "name", "basePrice") VALUES
  ('menu-a', 'restaurant-a', 'branch-a', 'SKU-A', 'Menu A', 10.00),
  ('menu-b', 'restaurant-b', 'branch-b', 'SKU-B', 'Menu B', 10.00);
INSERT INTO "Order" ("id", "restaurantId", "saveId", "branchId", "businessDay") VALUES
  ('order-a', 'restaurant-a', 'save-a', 'branch-a', 1);
INSERT INTO "Employee" (
  "id", "restaurantId", "saveId", "stableKey", "kind", "role", "displayName"
) VALUES
  ('employee-a', 'restaurant-a', 'save-a', 'employee:a', 'NPC', 'KITCHEN', 'Employee A'),
  ('employee-b', 'restaurant-b', 'save-b', 'employee:b', 'NPC', 'KITCHEN', 'Employee B');
INSERT INTO "WageContract" (
  "id", "restaurantId", "saveId", "employeeId", "version", "termsVersion",
  "currency", "salaryMinor", "salaryUnit", "shiftCoverage", "effectiveDay",
  "bonusType", "termsSnapshot"
) VALUES (
  'wage-b', 'restaurant-b', 'save-b', 'employee-b', 1, 'terms-v1',
  'USD', 100, 'PER_COMPLETED_SCHEDULED_DAY', 'ALL_LOCKED_SERVICE_PERIODS', 1,
  'NONE', '{}'
);
INSERT INTO "Loan" (
  "id", "restaurantId", "saveId", "stableKey", "termsVersion", "currency",
  "principalMinor", "interestRateBps", "lateFeeBps", "graceBusinessDays", "termsSnapshot"
) VALUES (
  'loan-b', 'restaurant-b', 'save-b', 'loan:b', 1, 'USD',
  1000, 0, 500, 1, '{}'
);
INSERT INTO "ReplayEvent" (
  "id", "restaurantId", "saveId", "eventId", "businessDay", "sequence",
  "eventType", "simulationRuleVersion", "payload", "eventHash"
) VALUES (
  'replay-a', 'restaurant-a', 'save-a', 'event-a', 1, 0,
  'OPENED', 'rules-v1', '{}', repeat('c', 64)
);
RESET ROLE;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'clerk-a', false);

DO $$
DECLARE
  visible_restaurants INTEGER;
  visible_own_save INTEGER;
  visible_foreign_save INTEGER;
BEGIN
  SELECT count(*) INTO visible_restaurants FROM "Restaurant";
  SELECT count(*) INTO visible_own_save FROM "CompetitiveSave" WHERE "id" = 'save-a';
  SELECT count(*) INTO visible_foreign_save FROM "CompetitiveSave" WHERE "id" = 'save-b';
  IF visible_restaurants <> 1 OR visible_own_save <> 1 OR visible_foreign_save <> 0 THEN
    RAISE EXCEPTION 'RLS membership isolation failed: restaurants %, own %, foreign %',
      visible_restaurants, visible_own_save, visible_foreign_save;
  END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    UPDATE "CompetitiveSave" SET "demandSeed" = 'client-forged' WHERE "id" = 'save-a';
    RAISE EXCEPTION 'authenticated UPDATE unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "Restaurant" ("id", "name") VALUES ('client-restaurant', 'Client Write');
    RAISE EXCEPTION 'authenticated INSERT unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;

SELECT set_config('request.jwt.claim.sub', '', false);
DO $$
DECLARE
  visible_rows INTEGER;
BEGIN
  SELECT count(*) INTO visible_rows FROM "Restaurant";
  IF visible_rows <> 0 THEN
    RAISE EXCEPTION 'missing JWT subject did not fail closed';
  END IF;
END;
$$;
RESET ROLE;

SET ROLE service_role;
DO $$
BEGIN
  IF to_regclass('public."ReplayEvent_restaurantId_businessDay_sequence_idx"') IS NULL
     OR to_regclass('public."DayEndSnapshot_restaurantId_businessDay_idx"') IS NULL
     OR to_regclass('public."RestaurantMembership_restaurantId_revokedAt_idx"') IS NULL THEN
    RAISE EXCEPTION 'required P0 tenant/history index is missing';
  END IF;

  BEGIN
    INSERT INTO "OrderItem" (
      "id", "restaurantId", "orderId", "menuItemId", "qty", "price"
    ) VALUES (
      'cross-tenant-order-item', 'restaurant-a', 'order-a', 'menu-b', 1, 10.00
    );
    RAISE EXCEPTION 'OrderItem accepted a MenuItem from another restaurant';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "WageContract" (
      "id", "restaurantId", "saveId", "employeeId", "version", "termsVersion",
      "currency", "salaryMinor", "salaryUnit", "shiftCoverage", "effectiveDay",
      "bonusType", "termsSnapshot", "supersedesId"
    ) VALUES (
      'cross-tenant-wage', 'restaurant-a', 'save-a', 'employee-a', 1, 'terms-v2',
      'USD', 100, 'PER_COMPLETED_SCHEDULED_DAY', 'ALL_LOCKED_SERVICE_PERIODS', 1,
      'NONE', '{}', 'wage-b'
    );
    RAISE EXCEPTION 'WageContract accepted a superseded contract from another restaurant/employee';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "EmployeeShift" (
      "id", "restaurantId", "saveId", "employeeId", "wageContractId",
      "businessDay", "servicePeriod", "shiftSnapshot"
    ) VALUES (
      'cross-tenant-shift', 'restaurant-a', 'save-a', 'employee-a', 'wage-b',
      1, 'DINNER', '{}'
    );
    RAISE EXCEPTION 'EmployeeShift accepted a WageContract from another restaurant/employee';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "Loan" (
      "id", "restaurantId", "saveId", "stableKey", "termsVersion", "currency",
      "principalMinor", "interestRateBps", "lateFeeBps", "graceBusinessDays",
      "termsSnapshot", "replacesLoanId"
    ) VALUES (
      'cross-tenant-loan', 'restaurant-a', 'save-a', 'loan:a', 1, 'USD',
      1000, 0, 500, 1, '{}', 'loan-b'
    );
    RAISE EXCEPTION 'Loan accepted a replacement from another restaurant/save';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "ReplayEvent" (
      "id", "restaurantId", "saveId", "eventId", "businessDay", "sequence",
      "eventType", "simulationRuleVersion", "payload", "eventHash"
    ) VALUES (
      'replay-a-duplicate-sequence', 'restaurant-a', 'save-a', 'event-a-duplicate', 1, 0,
      'DUPLICATE', 'rules-v1', '{}', repeat('e', 64)
    );
    RAISE EXCEPTION 'duplicate replay sequence unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "CompetitiveSave" (
      "id", "restaurantId", "ownerPlayerId", "mode", "openingScenario",
      "operatingMode", "servicePeriodPlan", "difficultyGroup", "demandSeed",
      "simulationRuleVersion", "openingSnapshot", "openingSnapshotHash"
    ) VALUES (
      'bad-cross-tenant-save', 'restaurant-b', 'player-a', 'COMPETITIVE', 'EMPTY_PREMISES',
      'STANDARD', 'TWO_PERIOD', 'NORMAL', 'seed-bad', 'rules-v1', '{}', repeat('d', 64)
    );
    RAISE EXCEPTION 'cross-tenant owner relation unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE "ReplayEvent" SET "eventType" = 'TAMPERED' WHERE "id" = 'replay-a';
    RAISE EXCEPTION 'append-only history UPDATE unexpectedly succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;

  BEGIN
    DELETE FROM "Restaurant" WHERE "id" = 'restaurant-a';
    RAISE EXCEPTION 'tenant root delete unexpectedly cascaded through history';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END;
$$;
RESET ROLE;

\ir ../../prisma/migrations/20260814000100_d01_p0_persistence/rollback.sql

DO $$
BEGIN
  IF to_regclass('public."Player"') IS NOT NULL
     OR to_regclass('public."ReplayEvent"') IS NOT NULL
     OR to_regclass('public."DayEndSnapshot"') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback left D01 tables behind';
  END IF;
END;
$$;
