-- P0-PLAT E03 inventory-pool, cost, and market provenance authority.
--
-- This migration deliberately has no data backfill. Existing saves require an
-- operator-controlled market-seed manifest, while existing item-level capacity
-- cannot prove the two shared pool capacities or cost pools.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public."CompetitiveSave"') IS NULL
     OR to_regclass('public."InventoryItem"') IS NULL
     OR to_regclass('public."InventoryStock"') IS NULL
     OR to_regclass('public."InventoryTransaction"') IS NULL
     OR to_regclass('public."LedgerTransaction"') IS NULL
     OR to_regclass('public."OutboxEvent"') IS NULL
     OR to_regclass('public."MarketTick"') IS NULL
     OR to_regclass('public."BusinessDay"') IS NULL THEN
    RAISE EXCEPTION 'P0 E03 authority migration requires D01, generic D03, and BusinessDay baselines'
      USING ERRCODE = '0A000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'P0 E03 authority migration requires service_role BYPASSRLS plus anon and authenticated roles'
      USING ERRCODE = '0A000';
  END IF;

  IF EXISTS (SELECT 1 FROM "InventoryStock")
     OR EXISTS (SELECT 1 FROM "InventoryTransaction") THEN
    RAISE EXCEPTION 'P0 E03 authority migration refused: existing inventory cannot prove shared pool capacity or cost authority; no automatic backfill is permitted'
      USING ERRCODE = '23514', CONSTRAINT = 'InventoryPoolState_backfill_refused';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "MarketTick"
    WHERE "materializedByJobId" IS NULL
       OR "replayExecutionId" IS NULL
       OR "materializedByJobId" <> "replayExecutionId"
  ) THEN
    RAISE EXCEPTION 'P0 E03 authority migration refused: historical market tick lacks a complete matching job/replay pair'
      USING ERRCODE = '23514', CONSTRAINT = 'MarketTick_historical_provenance_check';
  END IF;

  IF EXISTS (SELECT 1 FROM "CompetitiveSave") THEN
    RAISE EXCEPTION 'P0 E03 authority migration refused: existing saves require a controlled independent market-seed manifest; no seed is generated or derived'
      USING ERRCODE = '23514', CONSTRAINT = 'MarketSeedAuthority_backfill_refused';
  END IF;
END;
$$;

CREATE TYPE "InventoryPool" AS ENUM ('DURABLE', 'PERISHABLE');
CREATE TYPE "MarketTickMaterializationSource" AS ENUM ('JOB', 'COMMAND');

CREATE TABLE "InventoryPoolState" (
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "pool" "InventoryPool" NOT NULL,
  "revision" INTEGER NOT NULL,
  "capacityPoints" BIGINT NOT NULL,
  "storageBundleVersion" TEXT NOT NULL,
  "storageBundleKind" TEXT NOT NULL,
  "updatedByCommandId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryPoolState_pkey" PRIMARY KEY ("restaurantId", "saveId", "pool"),
  CONSTRAINT "InventoryPoolState_saveId_pool_key" UNIQUE ("saveId", "pool"),
  CONSTRAINT "InventoryPoolState_updatedByCommandId_pool_key" UNIQUE ("updatedByCommandId", "pool"),
  CONSTRAINT "InventoryPoolState_restaurantId_fkey" FOREIGN KEY ("restaurantId")
    REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryPoolState_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId")
    REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryPoolState_values_check" CHECK (
    "revision" > 0
    AND "capacityPoints" >= 0
    AND length("storageBundleVersion") BETWEEN 1 AND 128
    AND length("storageBundleKind") BETWEEN 1 AND 128
    AND "updatedByCommandId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  )
);

CREATE TABLE "MarketSeedAuthority" (
  "restaurantId" TEXT NOT NULL,
  "saveId" TEXT NOT NULL,
  "seed" TEXT NOT NULL,
  "seedVersion" TEXT NOT NULL,
  "createdByCommandId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketSeedAuthority_pkey" PRIMARY KEY ("restaurantId", "saveId"),
  CONSTRAINT "MarketSeedAuthority_saveId_key" UNIQUE ("saveId"),
  CONSTRAINT "MarketSeedAuthority_createdByCommandId_key" UNIQUE ("createdByCommandId"),
  CONSTRAINT "MarketSeedAuthority_restaurantId_fkey" FOREIGN KEY ("restaurantId")
    REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MarketSeedAuthority_save_scope_fkey" FOREIGN KEY ("restaurantId", "saveId")
    REFERENCES "CompetitiveSave"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MarketSeedAuthority_values_check" CHECK (
    length("seed") BETWEEN 1 AND 300
    AND length("seedVersion") BETWEEN 1 AND 128
    AND "createdByCommandId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  )
);

ALTER TABLE "InventoryStock"
  DROP CONSTRAINT "InventoryStock_capacity_check",
  DROP COLUMN "capacity",
  ADD COLUMN "costPoolMinor" BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT "InventoryStock_state_check" CHECK (
    "version" > 0
    AND "onHand" >= 0
    AND "reservedUndelivered" >= 0
    AND "costPoolMinor" >= 0
    AND ("onHand" > 0 OR "costPoolMinor" = 0)
  );

ALTER TABLE "InventoryTransaction"
  ADD COLUMN "commandId" TEXT NOT NULL,
  ADD COLUMN "commandSequence" INTEGER NOT NULL,
  ADD COLUMN "ledgerTransactionId" TEXT,
  ADD COLUMN "amountMinor" BIGINT NOT NULL,
  ADD COLUMN "costPoolMinorAfter" BIGINT NOT NULL,
  ADD COLUMN "referenceId" TEXT NOT NULL,
  ADD CONSTRAINT "InventoryTransaction_provenance_check" CHECK (
    "commandId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "commandSequence" >= 0
    AND ("ledgerTransactionId" IS NULL OR "ledgerTransactionId" = "commandId")
    AND "amountMinor" >= 0
    AND "costPoolMinorAfter" >= 0
    AND length("referenceId") BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT "InventoryTransaction_commandId_commandSequence_key"
    UNIQUE ("commandId", "commandSequence");

ALTER TABLE "LedgerTransaction"
  ADD CONSTRAINT "LedgerTransaction_scope_id_command_key"
    UNIQUE ("restaurantId", "saveId", "id", "commandId");

ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_ledger_scope_command_fkey"
    FOREIGN KEY ("restaurantId", "saveId", "ledgerTransactionId", "commandId")
    REFERENCES "LedgerTransaction"("restaurantId", "saveId", "id", "commandId")
    ON DELETE RESTRICT ON UPDATE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "OutboxEvent"
  ADD CONSTRAINT "OutboxEvent_scope_id_causation_key"
    UNIQUE ("restaurantId", "saveId", "id", "causationCommandId");

ALTER TABLE "MarketTick"
  ADD COLUMN "materializationSource" "MarketTickMaterializationSource" NOT NULL DEFAULT 'JOB',
  ADD COLUMN "materializedByCommandId" TEXT,
  ADD COLUMN "sourceEventId" TEXT,
  ALTER COLUMN "materializedByJobId" DROP NOT NULL,
  ALTER COLUMN "replayExecutionId" DROP NOT NULL,
  DROP CONSTRAINT "MarketTick_job_scope_fkey",
  DROP CONSTRAINT "MarketTick_replay_scope_fkey",
  ADD CONSTRAINT "MarketTick_job_scope_fkey"
    FOREIGN KEY ("restaurantId", "materializedByJobId")
    REFERENCES "SimulationJob"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MarketTick_replay_scope_fkey"
    FOREIGN KEY ("restaurantId", "replayExecutionId")
    REFERENCES "VersionedReplayExecution"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MarketTick_materialization_check" CHECK (
    (
      "materializationSource" = 'JOB'
      AND "materializedByJobId" IS NOT NULL
      AND "replayExecutionId" IS NOT NULL
      AND "materializedByJobId" = "replayExecutionId"
      AND "materializedByCommandId" IS NULL
      AND "sourceEventId" IS NULL
    ) OR (
      "materializationSource" = 'COMMAND'
      AND "businessDay" = 1
      AND "materializedByJobId" IS NULL
      AND "replayExecutionId" IS NULL
      AND "materializedByCommandId" IS NOT NULL
      AND "materializedByCommandId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "sourceEventId" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "MarketTick_command_event_scope_fkey"
    FOREIGN KEY ("restaurantId", "saveId", "sourceEventId", "materializedByCommandId")
    REFERENCES "OutboxEvent"("restaurantId", "saveId", "id", "causationCommandId")
    ON DELETE RESTRICT ON UPDATE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "MarketTick"
  ADD CONSTRAINT "MarketTick_market_seed_authority_scope_fkey"
    FOREIGN KEY ("restaurantId", "saveId")
    REFERENCES "MarketSeedAuthority"("restaurantId", "saveId")
    ON DELETE RESTRICT ON UPDATE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX "MarketTick_sourceEventId_idx" ON "MarketTick" ("sourceEventId");

CREATE FUNCTION p0_e03_guard_pool_state() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'InventoryPoolState is durable authority and cannot be deleted'
      USING ERRCODE = '55000', CONSTRAINT = 'InventoryPoolState_no_delete';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."restaurantId" IS DISTINCT FROM OLD."restaurantId"
       OR NEW."saveId" IS DISTINCT FROM OLD."saveId"
       OR NEW."pool" IS DISTINCT FROM OLD."pool"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."revision" <> OLD."revision" + 1 THEN
      RAISE EXCEPTION 'InventoryPoolState identity is immutable and revision must advance exactly by one'
        USING ERRCODE = '23514', CONSTRAINT = 'InventoryPoolState_transition_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION p0_e03_guard_market_seed() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'MarketSeedAuthority is immutable server-only authority'
      USING ERRCODE = '55000', CONSTRAINT = 'MarketSeedAuthority_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION p0_e03_guard_inventory_item_pool() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."perishable" IS DISTINCT FROM OLD."perishable"
     AND EXISTS (
       SELECT 1 FROM "InventoryStock" stock
       WHERE stock."restaurantId" = OLD."restaurantId"
         AND stock."inventoryItemId" = OLD."id"
     ) THEN
    RAISE EXCEPTION 'InventoryItem pool cannot change after stock exists'
      USING ERRCODE = '23514', CONSTRAINT = 'InventoryItem_pool_immutable_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION p0_e03_guard_inventory_stock() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."version" <> 1 THEN
    RAISE EXCEPTION 'InventoryStock initial version must be one'
      USING ERRCODE = '23514', CONSTRAINT = 'InventoryStock_transition_check';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."restaurantId" IS DISTINCT FROM OLD."restaurantId"
    OR NEW."saveId" IS DISTINCT FROM OLD."saveId"
    OR NEW."inventoryItemId" IS DISTINCT FROM OLD."inventoryItemId"
    OR NEW."version" <> OLD."version" + 1
  ) THEN
    RAISE EXCEPTION 'InventoryStock identity is immutable and version must advance exactly by one'
      USING ERRCODE = '23514', CONSTRAINT = 'InventoryStock_transition_check';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE FUNCTION p0_e03_guard_inventory_transaction_insert() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  current_stock "InventoryStock"%ROWTYPE;
BEGIN
  SELECT * INTO current_stock
  FROM "InventoryStock"
  WHERE "restaurantId" = NEW."restaurantId"
    AND "saveId" = NEW."saveId"
    AND "id" = NEW."stockId"
  FOR KEY SHARE;

  IF NOT FOUND
     OR current_stock."version" <> NEW."stockVersion"
     OR current_stock."onHand" <> NEW."onHandAfter"
     OR current_stock."reservedUndelivered" <> NEW."reservedAfter"
     OR current_stock."costPoolMinor" <> NEW."costPoolMinorAfter" THEN
    RAISE EXCEPTION 'InventoryTransaction must snapshot the current stock version, quantities, and cost pool'
      USING ERRCODE = '23514', CONSTRAINT = 'InventoryTransaction_stock_snapshot_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION p0_e03_assert_save_authority(
  target_restaurant_id TEXT,
  target_save_id TEXT
) RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  pool_count INTEGER;
  revision_count INTEGER;
  bundle_version_count INTEGER;
  bundle_kind_count INTEGER;
  command_count INTEGER;
  seed_count INTEGER;
  durable_capacity BIGINT;
  perishable_capacity BIGINT;
  durable_occupancy BIGINT;
  perishable_occupancy BIGINT;
BEGIN
  PERFORM 1
  FROM "InventoryPoolState"
  WHERE "restaurantId" = target_restaurant_id AND "saveId" = target_save_id
  ORDER BY CASE "pool" WHEN 'DURABLE' THEN 0 ELSE 1 END
  FOR UPDATE;

  SELECT count(*), count(DISTINCT "revision"),
         count(DISTINCT "storageBundleVersion"), count(DISTINCT "storageBundleKind"),
         count(DISTINCT "updatedByCommandId"),
         max("capacityPoints") FILTER (WHERE "pool" = 'DURABLE'),
         max("capacityPoints") FILTER (WHERE "pool" = 'PERISHABLE')
  INTO pool_count, revision_count, bundle_version_count, bundle_kind_count,
       command_count, durable_capacity, perishable_capacity
  FROM "InventoryPoolState"
  WHERE "restaurantId" = target_restaurant_id AND "saveId" = target_save_id;

  SELECT count(*) INTO seed_count
  FROM "MarketSeedAuthority"
  WHERE "restaurantId" = target_restaurant_id AND "saveId" = target_save_id;

  IF pool_count <> 2 OR revision_count <> 1 OR bundle_version_count <> 1
     OR bundle_kind_count <> 1 OR command_count <> 1
     OR durable_capacity IS NULL OR perishable_capacity IS NULL THEN
    RAISE EXCEPTION 'each save requires matching DURABLE and PERISHABLE inventory pool authority rows'
      USING ERRCODE = '23514', CONSTRAINT = 'InventoryPoolState_exact_two_check';
  END IF;
  IF seed_count <> 1 THEN
    RAISE EXCEPTION 'each save requires exactly one independent market seed authority'
      USING ERRCODE = '23514', CONSTRAINT = 'MarketSeedAuthority_exact_one_check';
  END IF;

  SELECT
    COALESCE(sum(stock."onHand" + stock."reservedUndelivered") FILTER (WHERE NOT item."perishable"), 0),
    COALESCE(sum(stock."onHand" + stock."reservedUndelivered") FILTER (WHERE item."perishable"), 0)
  INTO durable_occupancy, perishable_occupancy
  FROM "InventoryStock" stock
  JOIN "InventoryItem" item
    ON item."restaurantId" = stock."restaurantId"
   AND item."id" = stock."inventoryItemId"
  WHERE stock."restaurantId" = target_restaurant_id AND stock."saveId" = target_save_id;

  IF durable_occupancy > durable_capacity OR perishable_occupancy > perishable_capacity THEN
    RAISE EXCEPTION 'inventory occupancy including reserved quantities exceeds shared pool capacity'
      USING ERRCODE = '23514', CONSTRAINT = 'InventoryPoolState_occupancy_check';
  END IF;
END;
$$;

CREATE FUNCTION p0_e03_validate_scoped_save_authority() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM p0_e03_assert_save_authority(
    COALESCE(NEW."restaurantId", OLD."restaurantId"),
    COALESCE(NEW."saveId", OLD."saveId")
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE FUNCTION p0_e03_validate_competitive_save_authority() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM p0_e03_assert_save_authority(NEW."restaurantId", NEW."id");
  RETURN NEW;
END;
$$;

CREATE FUNCTION p0_e03_guard_market_tick_insert() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."materializationSource" = 'COMMAND' AND NOT EXISTS (
    SELECT 1 FROM "BusinessDay" day
    WHERE day."restaurantId" = NEW."restaurantId"
      AND day."saveId" = NEW."saveId"
      AND day."businessDay" = 1
      AND day."status" = 'PREOPEN'
      AND day."simulationRuleVersion" = NEW."simulationRuleVersion"
    FOR KEY SHARE
  ) THEN
    RAISE EXCEPTION 'command-materialized Day-1 market tick requires matching PREOPEN BusinessDay and simulation rule version'
      USING ERRCODE = '23514', CONSTRAINT = 'MarketTick_command_preopen_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION p0_e03_validate_market_tick_seed() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  authority_seed TEXT;
BEGIN
  SELECT authority."seed" INTO authority_seed
  FROM "MarketSeedAuthority" authority
  WHERE authority."restaurantId" = NEW."restaurantId"
    AND authority."saveId" = NEW."saveId"
  FOR KEY SHARE;

  IF NOT FOUND OR authority_seed IS DISTINCT FROM NEW."marketSeed" THEN
    RAISE EXCEPTION 'MarketTick seed must equal the scoped immutable MarketSeedAuthority seed'
      USING ERRCODE = '23514', CONSTRAINT = 'MarketTick_market_seed_authority_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "InventoryPoolState_guard"
  BEFORE UPDATE OR DELETE ON "InventoryPoolState"
  FOR EACH ROW EXECUTE FUNCTION p0_e03_guard_pool_state();
CREATE TRIGGER "MarketSeedAuthority_guard"
  BEFORE UPDATE OR DELETE ON "MarketSeedAuthority"
  FOR EACH ROW EXECUTE FUNCTION p0_e03_guard_market_seed();
CREATE TRIGGER "InventoryItem_pool_guard"
  BEFORE UPDATE OF "perishable" ON "InventoryItem"
  FOR EACH ROW EXECUTE FUNCTION p0_e03_guard_inventory_item_pool();
CREATE TRIGGER "InventoryStock_guard"
  BEFORE INSERT OR UPDATE ON "InventoryStock"
  FOR EACH ROW EXECUTE FUNCTION p0_e03_guard_inventory_stock();
CREATE TRIGGER "InventoryTransaction_snapshot_guard"
  BEFORE INSERT ON "InventoryTransaction"
  FOR EACH ROW EXECUTE FUNCTION p0_e03_guard_inventory_transaction_insert();
CREATE TRIGGER "MarketTick_command_guard"
  BEFORE INSERT ON "MarketTick"
  FOR EACH ROW EXECUTE FUNCTION p0_e03_guard_market_tick_insert();
CREATE CONSTRAINT TRIGGER "MarketTick_market_seed_authority"
  AFTER INSERT ON "MarketTick"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION p0_e03_validate_market_tick_seed();

CREATE CONSTRAINT TRIGGER "CompetitiveSave_e03_authority_complete"
  AFTER INSERT OR UPDATE ON "CompetitiveSave"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION p0_e03_validate_competitive_save_authority();
CREATE CONSTRAINT TRIGGER "InventoryPoolState_authority_complete"
  AFTER INSERT OR UPDATE OR DELETE ON "InventoryPoolState"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION p0_e03_validate_scoped_save_authority();
CREATE CONSTRAINT TRIGGER "MarketSeedAuthority_authority_complete"
  AFTER INSERT OR UPDATE OR DELETE ON "MarketSeedAuthority"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION p0_e03_validate_scoped_save_authority();
CREATE CONSTRAINT TRIGGER "InventoryStock_pool_occupancy"
  AFTER INSERT OR UPDATE OR DELETE ON "InventoryStock"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION p0_e03_validate_scoped_save_authority();

ALTER TABLE "InventoryPoolState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryPoolState" FORCE ROW LEVEL SECURITY;
ALTER TABLE "MarketSeedAuthority" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MarketSeedAuthority" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "InventoryPoolState" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE "MarketSeedAuthority" FROM PUBLIC, anon, authenticated, service_role;
REVOKE DELETE ON TABLE "InventoryStock" FROM service_role;
REVOKE UPDATE, DELETE ON TABLE "InventoryTransaction" FROM service_role;

CREATE POLICY "InventoryPoolState_select_member" ON "InventoryPoolState"
FOR SELECT TO authenticated USING (d01_is_restaurant_member("restaurantId"));

GRANT SELECT ON TABLE "InventoryPoolState" TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE "InventoryPoolState" TO service_role;
GRANT SELECT, INSERT ON TABLE "MarketSeedAuthority" TO service_role;

REVOKE ALL ON FUNCTION p0_e03_guard_pool_state() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION p0_e03_guard_market_seed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION p0_e03_guard_inventory_item_pool() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION p0_e03_guard_inventory_stock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION p0_e03_guard_inventory_transaction_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION p0_e03_assert_save_authority(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION p0_e03_validate_scoped_save_authority() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION p0_e03_validate_competitive_save_authority() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION p0_e03_guard_market_tick_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION p0_e03_validate_market_tick_seed() FROM PUBLIC, anon, authenticated;

COMMIT;
