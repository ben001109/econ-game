-- Player command versions are durable aggregate evidence. Removal is permitted
-- only before any state or provisioning epoch has been recorded.
DO $$
BEGIN
  IF to_regclass('public."BootstrapPlayerCommandState"') IS NOT NULL
     AND EXISTS (SELECT 1 FROM "BootstrapPlayerCommandState") THEN
    RAISE EXCEPTION 'rollback refused: BootstrapPlayerCommandState evidence exists';
  END IF;
  IF to_regclass('public."BootstrapProvisioningEpoch"') IS NOT NULL
     AND EXISTS (SELECT 1 FROM "BootstrapProvisioningEpoch") THEN
    RAISE EXCEPTION 'rollback refused: versioned BootstrapProvisioningEpoch evidence exists';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS "BootstrapProvisioningEpoch_player_command_version_committed"
  ON "BootstrapProvisioningEpoch";
DROP TRIGGER IF EXISTS "BootstrapProvisioningEpoch_player_command_version_guard"
  ON "BootstrapProvisioningEpoch";
DROP TRIGGER IF EXISTS "BootstrapPlayerCommandState_guard"
  ON "BootstrapPlayerCommandState";

ALTER TABLE "BootstrapProvisioningEpoch"
  DROP CONSTRAINT IF EXISTS "BootstrapProvisioningEpoch_player_command_version_key",
  DROP CONSTRAINT IF EXISTS "BootstrapProvisioningEpoch_player_command_state_fkey",
  DROP CONSTRAINT IF EXISTS "BootstrapProvisioningEpoch_playerCommandVersion_check",
  DROP COLUMN IF EXISTS "playerCommandVersion";

DROP TABLE IF EXISTS "BootstrapPlayerCommandState";
DROP FUNCTION IF EXISTS p0_plat_verify_epoch_player_command_version();
DROP FUNCTION IF EXISTS p0_plat_guard_epoch_player_command_version();
DROP FUNCTION IF EXISTS p0_plat_guard_bootstrap_player_command_state();
