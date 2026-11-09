-- D03-S-02 rollback. Use only against an isolated/restored database after
-- backup verification; durable job and replay history is intentionally removed.

DROP FUNCTION IF EXISTS d03_assert_market_tick_materialized(TEXT, TEXT, INTEGER, TEXT);
DROP FUNCTION IF EXISTS d03_complete_simulation_job(TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS d03_record_simulation_job_failure(TEXT, TEXT, "SimulationJobErrorClass", TEXT, JSONB);
DROP FUNCTION IF EXISTS d03_renew_simulation_job_lease(TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS d03_claim_simulation_job(TEXT, TEXT, INTEGER);

DROP TRIGGER IF EXISTS "SimulationVersionArtifact_append_only" ON "SimulationVersionArtifact";
DROP TRIGGER IF EXISTS "SimulationJob_no_delete" ON "SimulationJob";
DROP TRIGGER IF EXISTS "SimulationJobAudit_append_only" ON "SimulationJobAudit";
DROP TRIGGER IF EXISTS "VersionedReplayExecution_append_only" ON "VersionedReplayExecution";
DROP TRIGGER IF EXISTS "MarketTick_append_only" ON "MarketTick";

DROP FUNCTION IF EXISTS d03_reject_simulation_job_delete();
DROP FUNCTION IF EXISTS d03_reject_simulation_history_mutation();

DROP INDEX IF EXISTS "OutboxEvent_simulation_dispatch_idx";

DROP TABLE IF EXISTS "MarketTick";
DROP TABLE IF EXISTS "VersionedReplayExecution";
DROP TABLE IF EXISTS "SimulationJobAudit";
DROP TABLE IF EXISTS "SimulationJob";
DROP TABLE IF EXISTS "SimulationVersionArtifact";

DROP TYPE IF EXISTS "SimulationJobErrorClass";
DROP TYPE IF EXISTS "SimulationJobStatus";
DROP TYPE IF EXISTS "SimulationArtifactKind";
