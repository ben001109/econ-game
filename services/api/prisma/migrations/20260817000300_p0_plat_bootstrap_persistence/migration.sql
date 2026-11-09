-- P0-PLAT T3-A: persistence only. Runtime provisioning and transitions are
-- intentionally deferred; this migration adds no Restaurant or save defaults.
DO $$
BEGIN
  IF to_regclass('public."Player"') IS NULL
     OR to_regclass('public."Restaurant"') IS NULL
     OR to_regclass('public."RestaurantMembership"') IS NULL
     OR to_regclass('public."CompetitiveSave"') IS NULL
     OR to_regclass('public."AuditLog"') IS NULL
     OR to_regclass('public."TestCohort"') IS NULL
     OR to_regclass('public."TestCohortInvite"') IS NULL
     OR to_regclass('public."TestCohortMembership"') IS NULL
     OR to_regclass('public."ConsentPolicy"') IS NULL
     OR to_regclass('public."ConsentDecision"') IS NULL THEN
    RAISE EXCEPTION 'P0-PLAT bootstrap persistence requires D01 and D05 entry migrations';
  END IF;
END;
$$;

CREATE TYPE "BootstrapProvisioningStatus" AS ENUM ('ACTIVE', 'RETIRED', 'CLEARED');

CREATE TABLE "BootstrapAuthority" (
  "id" TEXT PRIMARY KEY,
  "playerId" TEXT NOT NULL UNIQUE,
  "cohortId" TEXT NOT NULL,
  "cohortMembershipId" TEXT NOT NULL UNIQUE,
  "inviteId" TEXT NOT NULL UNIQUE,
  "consentDecisionId" TEXT NOT NULL UNIQUE,
  "sourceEligibilityRestaurantId" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "policyDigest" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BootstrapAuthority_policyDigest_check"
    CHECK ("policyDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "BootstrapAuthority_playerId_fkey"
    FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BootstrapAuthority_cohortId_fkey"
    FOREIGN KEY ("cohortId") REFERENCES "TestCohort"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BootstrapAuthority_cohortMembershipId_fkey"
    FOREIGN KEY ("cohortMembershipId") REFERENCES "TestCohortMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BootstrapAuthority_inviteId_fkey"
    FOREIGN KEY ("inviteId") REFERENCES "TestCohortInvite"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BootstrapAuthority_consentDecisionId_fkey"
    FOREIGN KEY ("consentDecisionId") REFERENCES "ConsentDecision"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BootstrapAuthority_sourceEligibilityRestaurantId_fkey"
    FOREIGN KEY ("sourceEligibilityRestaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "BootstrapAuthority_cohortId_playerId_idx"
  ON "BootstrapAuthority" ("cohortId", "playerId");
CREATE INDEX "BootstrapAuthority_sourceEligibilityRestaurantId_idx"
  ON "BootstrapAuthority" ("sourceEligibilityRestaurantId");

CREATE TABLE "BootstrapProvisioningEpoch" (
  "id" TEXT PRIMARY KEY,
  "authorityId" TEXT NOT NULL,
  "playerId" TEXT NOT NULL,
  "epochNumber" INTEGER NOT NULL,
  "predecessorEpochId" TEXT UNIQUE,
  "status" "BootstrapProvisioningStatus" NOT NULL DEFAULT 'ACTIVE',
  "provisionedRestaurantId" TEXT NOT NULL UNIQUE,
  "ownerMembershipId" TEXT NOT NULL UNIQUE,
  "saveId" TEXT NOT NULL UNIQUE,
  "ownerAuditLogId" TEXT NOT NULL UNIQUE,
  "commandId" TEXT NOT NULL UNIQUE,
  "requestFingerprint" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retiredAt" TIMESTAMPTZ,
  "clearedAt" TIMESTAMPTZ,
  CONSTRAINT "BootstrapProvisioningEpoch_epochNumber_check" CHECK ("epochNumber" > 0),
  CONSTRAINT "BootstrapProvisioningEpoch_requestFingerprint_check"
    CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "BootstrapProvisioningEpoch_status_time_check" CHECK (
    ("status" = 'ACTIVE' AND "retiredAt" IS NULL AND "clearedAt" IS NULL)
    OR ("status" = 'RETIRED' AND "retiredAt" IS NOT NULL AND "clearedAt" IS NULL)
    OR ("status" = 'CLEARED' AND "retiredAt" IS NOT NULL AND "clearedAt" IS NOT NULL
        AND "clearedAt" >= "retiredAt")
  ),
  CONSTRAINT "BootstrapProvisioningEpoch_authority_epoch_key"
    UNIQUE ("authorityId", "epochNumber"),
  CONSTRAINT "BootstrapProvisioningEpoch_authorityId_fkey"
    FOREIGN KEY ("authorityId") REFERENCES "BootstrapAuthority"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BootstrapProvisioningEpoch_playerId_fkey"
    FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BootstrapProvisioningEpoch_predecessorEpochId_fkey"
    FOREIGN KEY ("predecessorEpochId") REFERENCES "BootstrapProvisioningEpoch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BootstrapProvisioningEpoch_provisionedRestaurantId_fkey"
    FOREIGN KEY ("provisionedRestaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BootstrapProvisioningEpoch_ownerMembershipId_fkey"
    FOREIGN KEY ("ownerMembershipId") REFERENCES "RestaurantMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BootstrapProvisioningEpoch_saveId_fkey"
    FOREIGN KEY ("saveId") REFERENCES "CompetitiveSave"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BootstrapProvisioningEpoch_ownerAuditLogId_fkey"
    FOREIGN KEY ("ownerAuditLogId") REFERENCES "AuditLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "BootstrapProvisioningEpoch_one_active_per_player_key"
  ON "BootstrapProvisioningEpoch" ("playerId") WHERE "status" = 'ACTIVE';
CREATE INDEX "BootstrapProvisioningEpoch_playerId_status_idx"
  ON "BootstrapProvisioningEpoch" ("playerId", "status");
CREATE INDEX "BootstrapProvisioningEpoch_authorityId_createdAt_idx"
  ON "BootstrapProvisioningEpoch" ("authorityId", "createdAt");

CREATE FUNCTION p0_plat_validate_bootstrap_authority() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'bootstrap authority provenance is immutable'
      USING ERRCODE = '55000';
  END IF;

  NEW."createdAt" := CURRENT_TIMESTAMP;
  IF NOT EXISTS (
    SELECT 1
    FROM "TestCohortMembership" membership
    JOIN "TestCohortInvite" invitation
      ON invitation."id" = membership."inviteId"
     AND invitation."cohortId" = membership."cohortId"
    JOIN "TestCohort" cohort ON cohort."id" = membership."cohortId"
    JOIN "ConsentPolicy" policy
      ON policy."cohortId" = cohort."id"
     AND policy."id" = cohort."entryConsentPolicyId"
    JOIN "ConsentDecision" decision
      ON decision."id" = NEW."consentDecisionId"
     AND decision."cohortId" = cohort."id"
     AND decision."playerId" = membership."playerId"
     AND decision."policyId" = policy."id"
    WHERE membership."id" = NEW."cohortMembershipId"
      AND membership."cohortId" = NEW."cohortId"
      AND membership."playerId" = NEW."playerId"
      AND membership."status" = 'ACTIVE'
      AND membership."revokedAt" IS NULL
      AND invitation."id" = NEW."inviteId"
      AND invitation."status" = 'CONSUMED'
      AND invitation."invitedPlayerId" = NEW."playerId"
      AND invitation."consumedByPlayerId" = NEW."playerId"
      AND cohort."restaurantId" = NEW."sourceEligibilityRestaurantId"
      AND cohort."status" = 'OPEN'
      AND cohort."opensAt" <= CURRENT_TIMESTAMP
      AND cohort."closesAt" > CURRENT_TIMESTAMP
      AND policy."requiredForEntry" = TRUE
      AND policy."retiredAt" IS NULL
      AND decision."decision" = 'ACCEPTED'
      AND decision."acceptedAt" IS NOT NULL
      AND decision."retentionUntil" > CURRENT_TIMESTAMP
      AND decision."policyVersion" = NEW."policyVersion"
      AND decision."policyDigest" = NEW."policyDigest"
      AND NOT EXISTS (
        SELECT 1 FROM "ConsentDecision" later
        WHERE later."cohortId" = decision."cohortId"
          AND later."playerId" = decision."playerId"
          AND later."policyId" = decision."policyId"
          AND later."decisionSequence" > decision."decisionSequence"
      )
  ) THEN
    RAISE EXCEPTION 'bootstrap authority does not match one active invite and accepted consent context'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BootstrapAuthority_validate_insert"
BEFORE INSERT ON "BootstrapAuthority"
FOR EACH ROW EXECUTE FUNCTION p0_plat_validate_bootstrap_authority();

CREATE TRIGGER "BootstrapAuthority_reject_mutation"
BEFORE UPDATE OR DELETE ON "BootstrapAuthority"
FOR EACH ROW EXECUTE FUNCTION p0_plat_validate_bootstrap_authority();

CREATE FUNCTION p0_plat_guard_bootstrap_epoch() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  predecessor "BootstrapProvisioningEpoch"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bootstrap provisioning epochs are durable evidence'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := CURRENT_TIMESTAMP;
    IF NEW."status" <> 'ACTIVE' OR NEW."retiredAt" IS NOT NULL OR NEW."clearedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'new bootstrap epoch must start ACTIVE'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "BootstrapAuthority" authority
      WHERE authority."id" = NEW."authorityId"
        AND authority."playerId" = NEW."playerId"
        AND authority."sourceEligibilityRestaurantId" <> NEW."provisionedRestaurantId"
    ) THEN
      RAISE EXCEPTION 'bootstrap epoch player mismatch or provisioned restaurant is not isolated from eligibility source'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM "RestaurantMembership" membership
      JOIN "CompetitiveSave" save_row
        ON save_row."id" = NEW."saveId"
       AND save_row."restaurantId" = membership."restaurantId"
       AND save_row."ownerPlayerId" = membership."playerId"
      JOIN "AuditLog" owner_audit ON owner_audit."id" = NEW."ownerAuditLogId"
      WHERE membership."id" = NEW."ownerMembershipId"
        AND membership."playerId" = NEW."playerId"
        AND membership."restaurantId" = NEW."provisionedRestaurantId"
        AND membership."role" = 'OWNER'
        AND membership."revokedAt" IS NULL
        AND save_row."restaurantId" = NEW."provisionedRestaurantId"
        AND save_row."ownerPlayerId" = NEW."playerId"
        AND save_row."mode" = 'COMPETITIVE'
        AND save_row."version" = 1
        AND save_row."retiredAt" IS NULL
        AND owner_audit."restaurantId" = NEW."provisionedRestaurantId"
        AND owner_audit."actorPlayerId" = NEW."playerId"
        AND owner_audit."targetType" = 'RestaurantMembership'
        AND owner_audit."targetId" = NEW."ownerMembershipId"
    ) THEN
      RAISE EXCEPTION 'bootstrap epoch must bind an active audited OWNER and competitive save in one restaurant'
        USING ERRCODE = '23514';
    END IF;

    IF NEW."epochNumber" = 1 THEN
      IF NEW."predecessorEpochId" IS NOT NULL OR EXISTS (
        SELECT 1 FROM "BootstrapProvisioningEpoch" existing
        WHERE existing."authorityId" = NEW."authorityId"
      ) THEN
        RAISE EXCEPTION 'first bootstrap epoch cannot have a predecessor'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW."predecessorEpochId" IS NULL THEN
        RAISE EXCEPTION 're-entry bootstrap epoch requires a predecessor'
          USING ERRCODE = '23514';
      END IF;
      SELECT * INTO predecessor FROM "BootstrapProvisioningEpoch"
      WHERE "id" = NEW."predecessorEpochId" FOR SHARE;
      IF NOT FOUND
         OR predecessor."authorityId" <> NEW."authorityId"
         OR predecessor."playerId" <> NEW."playerId"
         OR predecessor."epochNumber" <> NEW."epochNumber" - 1
         OR predecessor."status" <> 'CLEARED' THEN
        RAISE EXCEPTION 're-entry must follow the same cleared authority lineage'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."authorityId" IS DISTINCT FROM OLD."authorityId"
     OR NEW."playerId" IS DISTINCT FROM OLD."playerId"
     OR NEW."epochNumber" IS DISTINCT FROM OLD."epochNumber"
     OR NEW."predecessorEpochId" IS DISTINCT FROM OLD."predecessorEpochId"
     OR NEW."provisionedRestaurantId" IS DISTINCT FROM OLD."provisionedRestaurantId"
     OR NEW."ownerMembershipId" IS DISTINCT FROM OLD."ownerMembershipId"
     OR NEW."saveId" IS DISTINCT FROM OLD."saveId"
     OR NEW."ownerAuditLogId" IS DISTINCT FROM OLD."ownerAuditLogId"
     OR NEW."commandId" IS DISTINCT FROM OLD."commandId"
     OR NEW."requestFingerprint" IS DISTINCT FROM OLD."requestFingerprint"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'bootstrap epoch provenance is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "CompetitiveSave"
      WHERE "id" = OLD."saveId"
        AND "restaurantId" = OLD."provisionedRestaurantId"
        AND "retiredAt" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'bootstrap epoch cannot retire before its save is retired'
        USING ERRCODE = '23514';
    END IF;
    NEW."retiredAt" := CURRENT_TIMESTAMP;
    NEW."clearedAt" := NULL;
  ELSIF OLD."status" = 'RETIRED' AND NEW."status" = 'CLEARED' THEN
    NEW."retiredAt" := OLD."retiredAt";
    NEW."clearedAt" := CURRENT_TIMESTAMP;
  ELSE
    RAISE EXCEPTION 'bootstrap epoch transitions are forward-only ACTIVE to RETIRED to CLEARED'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "BootstrapProvisioningEpoch_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "BootstrapProvisioningEpoch"
FOR EACH ROW EXECUTE FUNCTION p0_plat_guard_bootstrap_epoch();

ALTER TABLE "BootstrapAuthority" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BootstrapAuthority" FORCE ROW LEVEL SECURITY;
ALTER TABLE "BootstrapProvisioningEpoch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BootstrapProvisioningEpoch" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "BootstrapAuthority" FROM PUBLIC;
REVOKE ALL ON TABLE "BootstrapProvisioningEpoch" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "BootstrapAuthority" FROM anon;
    REVOKE ALL ON TABLE "BootstrapProvisioningEpoch" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "BootstrapAuthority" FROM authenticated;
    REVOKE ALL ON TABLE "BootstrapProvisioningEpoch" FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT ON TABLE "BootstrapAuthority" TO service_role;
    GRANT SELECT, INSERT, UPDATE ON TABLE "BootstrapProvisioningEpoch" TO service_role;
  END IF;
END;
$$;
