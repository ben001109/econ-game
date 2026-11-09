-- Fail-closed rollback for P0-PLAT E03 inventory and market authority.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "InventoryPoolState")
     OR EXISTS (SELECT 1 FROM "InventoryStock")
     OR EXISTS (SELECT 1 FROM "InventoryTransaction")
     OR EXISTS (SELECT 1 FROM "MarketSeedAuthority")
     OR EXISTS (SELECT 1 FROM "MarketTick" WHERE "materializationSource" = 'COMMAND') THEN
    RAISE EXCEPTION 'P0 E03 authority rollback refused: durable pool, inventory, seed, or command market evidence exists'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "MarketTick"
    WHERE "materializationSource" <> 'JOB'
       OR "materializedByJobId" IS NULL
       OR "replayExecutionId" IS NULL
       OR "materializedByJobId" <> "replayExecutionId"
       OR "materializedByCommandId" IS NOT NULL
       OR "sourceEventId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'P0 E03 authority rollback refused: market provenance cannot return to job-only shape'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS "InventoryStock_pool_occupancy" ON "InventoryStock";
DROP TRIGGER IF EXISTS "MarketTick_market_seed_authority" ON "MarketTick";
DROP TRIGGER IF EXISTS "MarketSeedAuthority_authority_complete" ON "MarketSeedAuthority";
DROP TRIGGER IF EXISTS "InventoryPoolState_authority_complete" ON "InventoryPoolState";
DROP TRIGGER IF EXISTS "CompetitiveSave_e03_authority_complete" ON "CompetitiveSave";
DROP TRIGGER IF EXISTS "MarketTick_command_guard" ON "MarketTick";
DROP TRIGGER IF EXISTS "InventoryTransaction_snapshot_guard" ON "InventoryTransaction";
DROP TRIGGER IF EXISTS "InventoryStock_guard" ON "InventoryStock";
DROP TRIGGER IF EXISTS "InventoryItem_pool_guard" ON "InventoryItem";
DROP TRIGGER IF EXISTS "MarketSeedAuthority_guard" ON "MarketSeedAuthority";
DROP TRIGGER IF EXISTS "InventoryPoolState_guard" ON "InventoryPoolState";

DROP FUNCTION IF EXISTS p0_e03_guard_market_tick_insert();
DROP FUNCTION IF EXISTS p0_e03_validate_market_tick_seed();
DROP FUNCTION IF EXISTS p0_e03_validate_competitive_save_authority();
DROP FUNCTION IF EXISTS p0_e03_validate_scoped_save_authority();
DROP FUNCTION IF EXISTS p0_e03_assert_save_authority(TEXT, TEXT);
DROP FUNCTION IF EXISTS p0_e03_guard_inventory_transaction_insert();
DROP FUNCTION IF EXISTS p0_e03_guard_inventory_stock();
DROP FUNCTION IF EXISTS p0_e03_guard_inventory_item_pool();
DROP FUNCTION IF EXISTS p0_e03_guard_market_seed();
DROP FUNCTION IF EXISTS p0_e03_guard_pool_state();

DROP INDEX IF EXISTS "MarketTick_sourceEventId_idx";

ALTER TABLE "MarketTick"
  DROP CONSTRAINT "MarketTick_market_seed_authority_scope_fkey",
  DROP CONSTRAINT "MarketTick_command_event_scope_fkey",
  DROP CONSTRAINT "MarketTick_materialization_check",
  DROP CONSTRAINT "MarketTick_replay_scope_fkey",
  DROP CONSTRAINT "MarketTick_job_scope_fkey",
  ALTER COLUMN "materializedByJobId" SET NOT NULL,
  ALTER COLUMN "replayExecutionId" SET NOT NULL,
  ADD CONSTRAINT "MarketTick_job_scope_fkey"
    FOREIGN KEY ("restaurantId", "materializedByJobId")
    REFERENCES "SimulationJob"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MarketTick_replay_scope_fkey"
    FOREIGN KEY ("restaurantId", "replayExecutionId")
    REFERENCES "VersionedReplayExecution"("restaurantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP COLUMN "sourceEventId",
  DROP COLUMN "materializedByCommandId",
  DROP COLUMN "materializationSource";

ALTER TABLE "OutboxEvent"
  DROP CONSTRAINT "OutboxEvent_scope_id_causation_key";

ALTER TABLE "InventoryTransaction"
  DROP CONSTRAINT "InventoryTransaction_ledger_scope_command_fkey",
  DROP CONSTRAINT "InventoryTransaction_commandId_commandSequence_key",
  DROP CONSTRAINT "InventoryTransaction_provenance_check",
  DROP COLUMN "referenceId",
  DROP COLUMN "costPoolMinorAfter",
  DROP COLUMN "amountMinor",
  DROP COLUMN "ledgerTransactionId",
  DROP COLUMN "commandSequence",
  DROP COLUMN "commandId";

ALTER TABLE "LedgerTransaction"
  DROP CONSTRAINT "LedgerTransaction_scope_id_command_key";

ALTER TABLE "InventoryStock"
  DROP CONSTRAINT "InventoryStock_state_check",
  DROP COLUMN "costPoolMinor",
  ADD COLUMN "capacity" BIGINT NOT NULL,
  ADD CONSTRAINT "InventoryStock_capacity_check" CHECK (
    "version" > 0 AND "onHand" >= 0 AND "reservedUndelivered" >= 0
    AND "capacity" >= 0 AND "onHand" + "reservedUndelivered" <= "capacity"
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "InventoryStock" TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "InventoryTransaction" TO service_role;

DROP TABLE "MarketSeedAuthority";
DROP TABLE "InventoryPoolState";
DROP TYPE "MarketTickMaterializationSource";
DROP TYPE "InventoryPool";

COMMIT;
