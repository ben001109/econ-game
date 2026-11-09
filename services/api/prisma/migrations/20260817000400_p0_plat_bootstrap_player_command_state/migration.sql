-- P0-PLAT Player-scoped bootstrap command version. Idempotency receipts remain
-- in the existing IdempotencyRecord table and are wired by a later adapter batch.
DO $$
BEGIN
  IF to_regclass('public."Player"') IS NULL
     OR to_regclass('public."BootstrapProvisioningEpoch"') IS NULL THEN
    RAISE EXCEPTION 'bootstrap Player command state requires T3-A bootstrap persistence';
  END IF;
  IF EXISTS (SELECT 1 FROM "BootstrapProvisioningEpoch") THEN
    RAISE EXCEPTION 'cannot introduce Player command versions after bootstrap epoch evidence exists';
  END IF;
END;
$$;

CREATE TABLE "BootstrapPlayerCommandState" (
  "playerId" TEXT PRIMARY KEY,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BootstrapPlayerCommandState_version_check" CHECK ("version" >= 0),
  CONSTRAINT "BootstrapPlayerCommandState_playerId_fkey"
    FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "BootstrapProvisioningEpoch"
  ADD COLUMN "playerCommandVersion" INTEGER NOT NULL,
  ADD CONSTRAINT "BootstrapProvisioningEpoch_playerCommandVersion_check"
    CHECK ("playerCommandVersion" > 0),
  ADD CONSTRAINT "BootstrapProvisioningEpoch_player_command_state_fkey"
    FOREIGN KEY ("playerId") REFERENCES "BootstrapPlayerCommandState"("playerId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BootstrapProvisioningEpoch_player_command_version_key"
    UNIQUE ("playerId", "playerCommandVersion");

CREATE FUNCTION p0_plat_guard_bootstrap_player_command_state() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bootstrap Player command state cannot be deleted or reset'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."version" <> 0 THEN
      RAISE EXCEPTION 'bootstrap Player command state must start at version zero'
        USING ERRCODE = '23514';
    END IF;
    NEW."createdAt" := CURRENT_TIMESTAMP;
    NEW."updatedAt" := CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;

  IF NEW."playerId" IS DISTINCT FROM OLD."playerId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'bootstrap Player command version must advance by exactly one'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "BootstrapProvisioningEpoch" epoch
    WHERE epoch."playerId" = NEW."playerId"
      AND epoch."playerCommandVersion" = NEW."version"
  ) THEN
    RAISE EXCEPTION 'bootstrap Player command version requires its matching epoch'
      USING ERRCODE = '23514';
  END IF;
  NEW."updatedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BootstrapPlayerCommandState_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "BootstrapPlayerCommandState"
FOR EACH ROW EXECUTE FUNCTION p0_plat_guard_bootstrap_player_command_state();

CREATE FUNCTION p0_plat_guard_epoch_player_command_version() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  current_version INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT state."version" INTO current_version
    FROM "BootstrapPlayerCommandState" state
    WHERE state."playerId" = NEW."playerId"
    FOR UPDATE;
    IF NOT FOUND OR NEW."playerCommandVersion" <> current_version + 1 THEN
      RAISE EXCEPTION 'epoch Player command version must equal locked Player state next version'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."playerCommandVersion" IS DISTINCT FROM OLD."playerCommandVersion" THEN
    RAISE EXCEPTION 'epoch Player command version is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "BootstrapProvisioningEpoch_player_command_version_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "BootstrapProvisioningEpoch"
FOR EACH ROW EXECUTE FUNCTION p0_plat_guard_epoch_player_command_version();

CREATE FUNCTION p0_plat_verify_epoch_player_command_version() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "BootstrapPlayerCommandState" state
    WHERE state."playerId" = NEW."playerId"
      AND state."version" = NEW."playerCommandVersion"
  ) THEN
    RAISE EXCEPTION 'committed epoch must match durable Player command version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "BootstrapProvisioningEpoch_player_command_version_committed"
AFTER INSERT ON "BootstrapProvisioningEpoch"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION p0_plat_verify_epoch_player_command_version();

ALTER TABLE "BootstrapPlayerCommandState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BootstrapPlayerCommandState" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "BootstrapPlayerCommandState" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "BootstrapPlayerCommandState" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "BootstrapPlayerCommandState" FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "BootstrapPlayerCommandState" TO service_role;
  END IF;
END;
$$;
