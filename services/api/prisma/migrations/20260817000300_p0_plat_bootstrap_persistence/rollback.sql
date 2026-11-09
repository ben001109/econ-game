-- Refuse to erase bootstrap provenance. This rollback is available only before
-- any authority marker or provisioning epoch has been recorded.
DO $$
BEGIN
  IF to_regclass('public."BootstrapAuthority"') IS NOT NULL
     AND EXISTS (SELECT 1 FROM "BootstrapAuthority") THEN
    RAISE EXCEPTION 'rollback refused: BootstrapAuthority evidence exists';
  END IF;
  IF to_regclass('public."BootstrapProvisioningEpoch"') IS NOT NULL
     AND EXISTS (SELECT 1 FROM "BootstrapProvisioningEpoch") THEN
    RAISE EXCEPTION 'rollback refused: BootstrapProvisioningEpoch evidence exists';
  END IF;
END;
$$;

DROP TABLE IF EXISTS "BootstrapProvisioningEpoch";
DROP TABLE IF EXISTS "BootstrapAuthority";
DROP FUNCTION IF EXISTS p0_plat_guard_bootstrap_epoch();
DROP FUNCTION IF EXISTS p0_plat_validate_bootstrap_authority();
DROP TYPE IF EXISTS "BootstrapProvisioningStatus";
