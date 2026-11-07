-- D05-S-01 durable closed-beta entry governance.
-- This migration is intentionally separate from the immutable D01/D04 baselines.

DO $$
BEGIN
  IF to_regclass('public."Player"') IS NULL
     OR to_regclass('public."Restaurant"') IS NULL
     OR to_regclass('public."RestaurantMembership"') IS NULL
     OR to_regclass('public."AuditLog"') IS NULL THEN
    RAISE EXCEPTION 'D05 migration requires the D01 identity, tenant, membership, and audit tables';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls) THEN
    RAISE EXCEPTION 'D05 migration requires the Supabase service_role with BYPASSRLS';
  END IF;
END;
$$;

CREATE TYPE "TestCohortStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'REVOKED');
CREATE TYPE "InviteStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CONSUMED', 'EXPIRED', 'REVOKED');
CREATE TYPE "CohortMembershipStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "ConsentDecisionKind" AS ENUM ('ACCEPTED', 'WITHDRAWN');
CREATE TYPE "RewardEligibilitySource" AS ENUM ('SERVER_EVENT', 'MANUAL_ADJUSTMENT', 'REVOCATION');

CREATE TABLE "TestCohort" (
  "id" TEXT PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "status" "TestCohortStatus" NOT NULL DEFAULT 'DRAFT',
  "quota" INTEGER NOT NULL,
  "opensAt" TIMESTAMP(3) NOT NULL,
  "closesAt" TIMESTAMP(3) NOT NULL,
  "featureFlags" JSONB NOT NULL,
  "eligibilityPolicyVersion" TEXT NOT NULL,
  "eligibilityPolicyDigest" VARCHAR(64) NOT NULL,
  "entryConsentPolicyId" TEXT,
  "createdByPlayerId" TEXT NOT NULL,
  "openedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TestCohort_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TestCohort_createdByPlayerId_fkey" FOREIGN KEY ("createdByPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TestCohort_restaurantId_id_key" UNIQUE ("restaurantId", "id"),
  CONSTRAINT "TestCohort_text_check" CHECK (
    length("name") BETWEEN 1 AND 200
    AND length("purpose") BETWEEN 1 AND 500
    AND length("environment") BETWEEN 1 AND 100
    AND length("eligibilityPolicyVersion") BETWEEN 1 AND 200
  ),
  CONSTRAINT "TestCohort_quota_check" CHECK ("quota" BETWEEN 1 AND 100000),
  CONSTRAINT "TestCohort_window_check" CHECK ("opensAt" < "closesAt"),
  CONSTRAINT "TestCohort_digest_check" CHECK ("eligibilityPolicyDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "TestCohort_state_check" CHECK (
    ("status" = 'DRAFT' AND "openedAt" IS NULL AND "closedAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'OPEN' AND "openedAt" IS NOT NULL AND "closedAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'CLOSED' AND "openedAt" IS NOT NULL AND "closedAt" IS NOT NULL AND "revokedAt" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
  )
);

CREATE INDEX "TestCohort_restaurantId_status_window_idx"
  ON "TestCohort" ("restaurantId", "status", "opensAt", "closesAt");

CREATE TABLE "ConsentPolicy" (
  "id" TEXT PRIMARY KEY,
  "cohortId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "policyDigest" VARCHAR(64) NOT NULL,
  "scope" JSONB NOT NULL,
  "dataCategories" JSONB NOT NULL,
  "retentionDays" INTEGER NOT NULL,
  "requiredForEntry" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdByPlayerId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retiredAt" TIMESTAMP(3),
  CONSTRAINT "ConsentPolicy_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "TestCohort"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ConsentPolicy_createdByPlayerId_fkey" FOREIGN KEY ("createdByPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ConsentPolicy_cohortId_id_key" UNIQUE ("cohortId", "id"),
  CONSTRAINT "ConsentPolicy_cohort_purpose_version_key" UNIQUE ("cohortId", "purpose", "version"),
  CONSTRAINT "ConsentPolicy_text_check" CHECK (length("purpose") BETWEEN 1 AND 200 AND length("version") BETWEEN 1 AND 200),
  CONSTRAINT "ConsentPolicy_digest_check" CHECK ("policyDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ConsentPolicy_retention_check" CHECK ("retentionDays" BETWEEN 1 AND 3650)
);

CREATE INDEX "ConsentPolicy_cohort_required_retired_idx"
  ON "ConsentPolicy" ("cohortId", "requiredForEntry", "retiredAt");

ALTER TABLE "TestCohort"
  ADD CONSTRAINT "TestCohort_entryConsentPolicy_fkey"
  FOREIGN KEY ("id", "entryConsentPolicyId")
  REFERENCES "ConsentPolicy"("cohortId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "TestCohortInvite" (
  "id" TEXT PRIMARY KEY,
  "cohortId" TEXT NOT NULL,
  "invitedPlayerId" TEXT NOT NULL,
  "issuedByPlayerId" TEXT NOT NULL,
  "tokenDigest" VARCHAR(64) NOT NULL UNIQUE,
  "status" "InviteStatus" NOT NULL DEFAULT 'DRAFT',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "activatedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "consumedByPlayerId" TEXT,
  "revokedAt" TIMESTAMP(3),
  "revokedByPlayerId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TestCohortInvite_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "TestCohort"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TestCohortInvite_invitedPlayerId_fkey" FOREIGN KEY ("invitedPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TestCohortInvite_issuedByPlayerId_fkey" FOREIGN KEY ("issuedByPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TestCohortInvite_consumedByPlayerId_fkey" FOREIGN KEY ("consumedByPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TestCohortInvite_revokedByPlayerId_fkey" FOREIGN KEY ("revokedByPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TestCohortInvite_cohortId_id_key" UNIQUE ("cohortId", "id"),
  CONSTRAINT "TestCohortInvite_digest_check" CHECK ("tokenDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "TestCohortInvite_ttl_check" CHECK (
    "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '7 days'
  ),
  CONSTRAINT "TestCohortInvite_target_check" CHECK (
    "consumedByPlayerId" IS NULL OR "consumedByPlayerId" = "invitedPlayerId"
  ),
  CONSTRAINT "TestCohortInvite_state_check" CHECK (
    ("status" = 'DRAFT' AND "activatedAt" IS NULL AND "consumedAt" IS NULL AND "consumedByPlayerId" IS NULL AND "revokedAt" IS NULL AND "revokedByPlayerId" IS NULL)
    OR ("status" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "consumedAt" IS NULL AND "consumedByPlayerId" IS NULL AND "revokedAt" IS NULL AND "revokedByPlayerId" IS NULL)
    OR ("status" = 'CONSUMED' AND "activatedAt" IS NOT NULL AND "consumedAt" IS NOT NULL AND "consumedByPlayerId" IS NOT NULL AND "revokedAt" IS NULL AND "revokedByPlayerId" IS NULL)
    OR ("status" = 'EXPIRED' AND "activatedAt" IS NOT NULL AND "consumedAt" IS NULL AND "consumedByPlayerId" IS NULL AND "revokedAt" IS NULL AND "revokedByPlayerId" IS NULL)
    OR ("status" = 'REVOKED' AND "consumedAt" IS NULL AND "consumedByPlayerId" IS NULL AND "revokedAt" IS NOT NULL AND "revokedByPlayerId" IS NOT NULL)
  )
);

CREATE INDEX "TestCohortInvite_cohort_status_expiry_idx"
  ON "TestCohortInvite" ("cohortId", "status", "expiresAt");
CREATE INDEX "TestCohortInvite_player_status_idx"
  ON "TestCohortInvite" ("invitedPlayerId", "status");

CREATE TABLE "TestCohortMembership" (
  "id" TEXT PRIMARY KEY,
  "cohortId" TEXT NOT NULL,
  "playerId" TEXT NOT NULL,
  "inviteId" TEXT NOT NULL UNIQUE,
  "status" "CohortMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "revokedByPlayerId" TEXT,
  "revokeReason" TEXT,
  CONSTRAINT "TestCohortMembership_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "TestCohort"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TestCohortMembership_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TestCohortMembership_invite_fkey" FOREIGN KEY ("cohortId", "inviteId") REFERENCES "TestCohortInvite"("cohortId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TestCohortMembership_revokedByPlayerId_fkey" FOREIGN KEY ("revokedByPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TestCohortMembership_cohort_player_key" UNIQUE ("cohortId", "playerId"),
  CONSTRAINT "TestCohortMembership_cohort_invite_key" UNIQUE ("cohortId", "inviteId"),
  CONSTRAINT "TestCohortMembership_state_check" CHECK (
    ("status" = 'ACTIVE' AND "revokedAt" IS NULL AND "revokedByPlayerId" IS NULL AND "revokeReason" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL AND "revokedByPlayerId" IS NOT NULL AND length("revokeReason") BETWEEN 1 AND 500)
  )
);

CREATE INDEX "TestCohortMembership_player_status_idx"
  ON "TestCohortMembership" ("playerId", "status");
CREATE INDEX "TestCohortMembership_cohort_status_idx"
  ON "TestCohortMembership" ("cohortId", "status");

CREATE TABLE "ConsentDecision" (
  "id" TEXT PRIMARY KEY,
  "decisionSequence" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL UNIQUE,
  "cohortId" TEXT NOT NULL,
  "playerId" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "actorPlayerId" TEXT NOT NULL,
  "decision" "ConsentDecisionKind" NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "policyDigest" VARCHAR(64) NOT NULL,
  "purpose" TEXT NOT NULL,
  "scope" JSONB NOT NULL,
  "dataCategories" JSONB NOT NULL,
  "retentionUntil" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "withdrawnAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConsentDecision_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "TestCohort"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ConsentDecision_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ConsentDecision_actorPlayerId_fkey" FOREIGN KEY ("actorPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ConsentDecision_policy_fkey" FOREIGN KEY ("cohortId", "policyId") REFERENCES "ConsentPolicy"("cohortId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ConsentDecision_self_actor_check" CHECK ("actorPlayerId" = "playerId"),
  CONSTRAINT "ConsentDecision_digest_check" CHECK ("policyDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ConsentDecision_state_check" CHECK (
    ("decision" = 'ACCEPTED' AND "acceptedAt" IS NOT NULL AND "withdrawnAt" IS NULL AND "retentionUntil" > "acceptedAt")
    OR ("decision" = 'WITHDRAWN' AND "acceptedAt" IS NULL AND "withdrawnAt" IS NOT NULL)
  )
);

CREATE INDEX "ConsentDecision_cohort_player_policy_sequence_idx"
  ON "ConsentDecision" ("cohortId", "playerId", "policyId", "decisionSequence" DESC);
CREATE INDEX "ConsentDecision_player_purpose_sequence_idx"
  ON "ConsentDecision" ("playerId", "purpose", "decisionSequence" DESC);

CREATE TABLE "RewardEligibility" (
  "id" TEXT PRIMARY KEY,
  "cohortId" TEXT NOT NULL,
  "playerId" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "policyDigest" VARCHAR(64) NOT NULL,
  "milestoneEventId" TEXT NOT NULL,
  "evidenceSnapshot" JSONB NOT NULL,
  "evidenceHash" VARCHAR(64) NOT NULL,
  "eligible" BOOLEAN NOT NULL,
  "rewardKind" TEXT NOT NULL,
  "source" "RewardEligibilitySource" NOT NULL,
  "reason" TEXT NOT NULL,
  "decidedByPlayerId" TEXT,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "supersedesEligibilityId" TEXT,
  CONSTRAINT "RewardEligibility_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "TestCohort"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RewardEligibility_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RewardEligibility_decidedByPlayerId_fkey" FOREIGN KEY ("decidedByPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RewardEligibility_chain_target_key" UNIQUE ("cohortId", "playerId", "rewardKind", "id"),
  CONSTRAINT "RewardEligibility_supersession_key" UNIQUE ("cohortId", "playerId", "rewardKind", "supersedesEligibilityId"),
  CONSTRAINT "RewardEligibility_supersedes_fkey" FOREIGN KEY (
    "cohortId", "playerId", "rewardKind", "supersedesEligibilityId"
  ) REFERENCES "RewardEligibility"("cohortId", "playerId", "rewardKind", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RewardEligibility_policy_digest_check" CHECK ("policyDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "RewardEligibility_evidence_hash_check" CHECK ("evidenceHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "RewardEligibility_reward_kind_check" CHECK ("rewardKind" IN ('TITLE', 'COSMETIC', 'NON_COMPETITIVE_STARTER_PACK')),
  CONSTRAINT "RewardEligibility_reason_check" CHECK (length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "RewardEligibility_actor_check" CHECK (
    ("source" = 'SERVER_EVENT' AND "decidedByPlayerId" IS NULL AND "supersedesEligibilityId" IS NULL)
    OR ("source" IN ('MANUAL_ADJUSTMENT', 'REVOCATION') AND "decidedByPlayerId" IS NOT NULL AND "supersedesEligibilityId" IS NOT NULL)
  ),
  CONSTRAINT "RewardEligibility_revocation_check" CHECK (
    ("source" = 'REVOCATION' AND "eligible" = FALSE AND "revokedAt" = "decidedAt")
    OR ("source" <> 'REVOCATION' AND "revokedAt" IS NULL)
  )
);

CREATE INDEX "RewardEligibility_player_eligible_revoked_idx"
  ON "RewardEligibility" ("playerId", "eligible", "revokedAt");
CREATE INDEX "RewardEligibility_cohort_decided_idx"
  ON "RewardEligibility" ("cohortId", "decidedAt");
CREATE INDEX "RewardEligibility_cohort_player_event_idx"
  ON "RewardEligibility" ("cohortId", "playerId", "milestoneEventId");
CREATE UNIQUE INDEX "RewardEligibility_server_event_key"
  ON "RewardEligibility" ("cohortId", "playerId", "milestoneEventId")
  WHERE "source" = 'SERVER_EVENT';

CREATE FUNCTION d05_reject_history_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'D05 history is append-only';
END;
$$;

CREATE TRIGGER "ConsentDecision_append_only"
  BEFORE UPDATE OR DELETE ON "ConsentDecision"
  FOR EACH ROW EXECUTE FUNCTION d05_reject_history_mutation();
CREATE TRIGGER "RewardEligibility_append_only"
  BEFORE UPDATE OR DELETE ON "RewardEligibility"
  FOR EACH ROW EXECUTE FUNCTION d05_reject_history_mutation();

CREATE FUNCTION d05_revoke_invite(
  invite_id TEXT,
  cohort_id TEXT,
  actor_player_id TEXT,
  revoked_at TIMESTAMP(3),
  audit_id TEXT,
  correlation_id TEXT
) RETURNS TABLE (result TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  invitation "TestCohortInvite"%ROWTYPE;
  cohort "TestCohort"%ROWTYPE;
  owner_membership_id TEXT;
BEGIN
  IF correlation_id IS NULL OR length(correlation_id) NOT BETWEEN 1 AND 500
     OR correlation_id ~ '[[:cntrl:]]' THEN
    RETURN QUERY SELECT 'invalid'::TEXT;
    RETURN;
  END IF;

  -- Every existing-invite transition locks invite before cohort. This order must
  -- remain aligned with d05_redeem_invite so revoke and redeem cannot deadlock.
  SELECT * INTO invitation FROM "TestCohortInvite"
  WHERE "id" = invite_id AND "cohortId" = cohort_id
  FOR UPDATE;

  IF NOT FOUND OR invitation."status" NOT IN ('DRAFT', 'ACTIVE') THEN
    RETURN QUERY SELECT 'invalid'::TEXT;
    RETURN;
  END IF;

  SELECT * INTO cohort FROM "TestCohort"
  WHERE "id" = invitation."cohortId"
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::TEXT;
    RETURN;
  END IF;

  SELECT "id" INTO owner_membership_id FROM "RestaurantMembership"
  WHERE "playerId" = actor_player_id
    AND "restaurantId" = cohort."restaurantId"
    AND "role" = 'OWNER'
    AND "revokedAt" IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::TEXT;
    RETURN;
  END IF;

  UPDATE "TestCohortInvite"
  SET "status" = 'REVOKED', "revokedAt" = revoked_at, "revokedByPlayerId" = actor_player_id
  WHERE "id" = invitation."id";
  INSERT INTO "AuditLog" (
    "id", "restaurantId", "actorPlayerId", "actorType", "action", "targetType",
    "targetId", "metadata", "correlationId", "createdAt"
  ) VALUES (
    audit_id, cohort."restaurantId", actor_player_id, 'clerk_user', 'closed_beta_invite_revoked',
    'TestCohortInvite', invitation."id",
    jsonb_build_object('cohortId', cohort."id", 'inviteId', invitation."id", 'status', 'REVOKED'),
    correlation_id, revoked_at
  );
  RETURN QUERY SELECT 'revoked'::TEXT;
END;
$$;

CREATE FUNCTION d05_redeem_invite(
  presented_token_digest TEXT,
  actor_player_id TEXT,
  redeemed_at TIMESTAMP(3),
  membership_id TEXT,
  audit_id TEXT,
  correlation_id TEXT
) RETURNS TABLE (result TEXT, "cohortId" TEXT, "membershipId" TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  invitation "TestCohortInvite"%ROWTYPE;
  cohort "TestCohort"%ROWTYPE;
  occupied INTEGER;
BEGIN
  IF presented_token_digest !~ '^[0-9a-f]{64}$' OR actor_player_id IS NULL
     OR correlation_id IS NULL OR length(correlation_id) NOT BETWEEN 1 AND 500
     OR correlation_id ~ '[[:cntrl:]]' THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO invitation FROM "TestCohortInvite"
  WHERE "tokenDigest" = presented_token_digest
  FOR UPDATE;

  IF NOT FOUND OR invitation."status" <> 'ACTIVE' OR invitation."invitedPlayerId" <> actor_player_id THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF invitation."expiresAt" <= redeemed_at THEN
    UPDATE "TestCohortInvite" SET "status" = 'EXPIRED' WHERE "id" = invitation."id";
    SELECT * INTO cohort FROM "TestCohort" WHERE "id" = invitation."cohortId";
    INSERT INTO "AuditLog" (
      "id", "restaurantId", "actorPlayerId", "actorType", "action", "targetType",
      "targetId", "metadata", "correlationId", "createdAt"
    ) VALUES (
      audit_id, cohort."restaurantId", actor_player_id, 'clerk_user',
      'closed_beta_invite_expired_on_redeem', 'TestCohortInvite', invitation."id",
      jsonb_build_object('cohortId', invitation."cohortId", 'inviteId', invitation."id", 'status', 'EXPIRED'),
      correlation_id, redeemed_at
    );
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO cohort FROM "TestCohort"
  WHERE "id" = invitation."cohortId"
  FOR UPDATE;

  IF NOT FOUND OR cohort."status" <> 'OPEN'
     OR cohort."opensAt" > redeemed_at OR cohort."closesAt" <= redeemed_at
     OR cohort."entryConsentPolicyId" IS NULL THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "TestCohortMembership" existing_membership
    WHERE existing_membership."cohortId" = cohort."id"
      AND existing_membership."playerId" = actor_player_id
  ) THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT count(*) INTO occupied FROM "TestCohortMembership" occupied_membership
  WHERE occupied_membership."cohortId" = cohort."id"
    AND occupied_membership."status" = 'ACTIVE';
  IF occupied >= cohort."quota" THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  INSERT INTO "TestCohortMembership" (
    "id", "cohortId", "playerId", "inviteId", "status", "joinedAt"
  ) VALUES (
    membership_id, cohort."id", actor_player_id, invitation."id", 'ACTIVE', redeemed_at
  );
  UPDATE "TestCohortInvite"
  SET "status" = 'CONSUMED', "consumedAt" = redeemed_at, "consumedByPlayerId" = actor_player_id
  WHERE "id" = invitation."id";
  INSERT INTO "AuditLog" (
    "id", "restaurantId", "actorPlayerId", "actorType", "action", "targetType",
    "targetId", "metadata", "correlationId", "createdAt"
  ) VALUES (
    audit_id, cohort."restaurantId", actor_player_id, 'clerk_user', 'closed_beta_invite_redeemed',
    'TestCohortMembership', membership_id,
    jsonb_build_object('cohortId', cohort."id", 'inviteId', invitation."id"), correlation_id, redeemed_at
  );
  RETURN QUERY SELECT 'redeemed'::TEXT, cohort."id", membership_id;
END;
$$;

CREATE FUNCTION d05_record_consent_decision(
  policy_id TEXT,
  actor_player_id TEXT,
  decision_kind "ConsentDecisionKind",
  decided_at TIMESTAMP(3),
  decision_id TEXT,
  audit_id TEXT,
  correlation_id TEXT
) RETURNS TABLE (result TEXT, "cohortId" TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  policy "ConsentPolicy"%ROWTYPE;
  membership "TestCohortMembership"%ROWTYPE;
  previous "ConsentDecision"%ROWTYPE;
  retention_until TIMESTAMP(3);
  tenant_id TEXT;
BEGIN
  IF correlation_id IS NULL OR length(correlation_id) NOT BETWEEN 1 AND 500
     OR correlation_id ~ '[[:cntrl:]]' THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO policy FROM "ConsentPolicy" WHERE "id" = policy_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO membership FROM "TestCohortMembership" consent_membership
  WHERE consent_membership."cohortId" = policy."cohortId"
    AND consent_membership."playerId" = actor_player_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO previous FROM "ConsentDecision" prior_decision
  WHERE prior_decision."cohortId" = policy."cohortId"
    AND prior_decision."playerId" = actor_player_id
    AND prior_decision."policyId" = policy."id"
  ORDER BY prior_decision."decisionSequence" DESC LIMIT 1;

  IF decision_kind = 'ACCEPTED' THEN
    IF membership."status" <> 'ACTIVE' OR policy."retiredAt" IS NOT NULL
       OR previous."decision" = 'ACCEPTED' THEN
      RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT;
      RETURN;
    END IF;
    retention_until := decided_at + make_interval(days => policy."retentionDays");
  ELSE
    IF previous."decision" IS DISTINCT FROM 'ACCEPTED' THEN
      RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT;
      RETURN;
    END IF;
    retention_until := previous."retentionUntil";
  END IF;

  INSERT INTO "ConsentDecision" (
    "id", "cohortId", "playerId", "policyId", "actorPlayerId", "decision",
    "policyVersion", "policyDigest", "purpose", "scope", "dataCategories",
    "retentionUntil", "acceptedAt", "withdrawnAt", "createdAt"
  ) VALUES (
    decision_id, policy."cohortId", actor_player_id, policy."id", actor_player_id, decision_kind,
    policy."version", policy."policyDigest", policy."purpose", policy."scope", policy."dataCategories",
    retention_until,
    CASE WHEN decision_kind = 'ACCEPTED' THEN decided_at ELSE NULL END,
    CASE WHEN decision_kind = 'WITHDRAWN' THEN decided_at ELSE NULL END,
    decided_at
  );
  SELECT "restaurantId" INTO tenant_id FROM "TestCohort" WHERE "id" = policy."cohortId";
  INSERT INTO "AuditLog" (
    "id", "restaurantId", "actorPlayerId", "actorType", "action", "targetType",
    "targetId", "metadata", "correlationId", "createdAt"
  ) VALUES (
    audit_id, tenant_id, actor_player_id, 'clerk_user',
    CASE WHEN decision_kind = 'ACCEPTED' THEN 'closed_beta_consent_accepted' ELSE 'closed_beta_consent_withdrawn' END,
    'ConsentDecision', decision_id,
    jsonb_build_object(
      'cohortId', policy."cohortId", 'policyId', policy."id", 'purpose', policy."purpose",
      'policyVersion', policy."version", 'policyDigest', policy."policyDigest"
    ), correlation_id, decided_at
  );
  RETURN QUERY SELECT lower(decision_kind::TEXT), policy."cohortId";
END;
$$;

CREATE FUNCTION d05_is_entrance_eligible(
  actor_player_id TEXT,
  tenant_id TEXT,
  checked_at TIMESTAMP(3)
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "TestCohortMembership" membership
    JOIN "TestCohort" cohort ON cohort."id" = membership."cohortId"
    JOIN "ConsentPolicy" policy
      ON policy."cohortId" = cohort."id" AND policy."id" = cohort."entryConsentPolicyId"
    JOIN LATERAL (
      SELECT decision."decision", decision."retentionUntil"
      FROM "ConsentDecision" decision
      WHERE decision."cohortId" = cohort."id"
        AND decision."playerId" = membership."playerId"
        AND decision."policyId" = policy."id"
      ORDER BY decision."decisionSequence" DESC
      LIMIT 1
    ) latest ON TRUE
    WHERE membership."playerId" = actor_player_id
      AND membership."status" = 'ACTIVE'
      AND cohort."restaurantId" = tenant_id
      AND cohort."status" = 'OPEN'
      AND cohort."opensAt" <= checked_at
      AND cohort."closesAt" > checked_at
      AND policy."requiredForEntry" = TRUE
      AND policy."retiredAt" IS NULL
      AND latest."decision" = 'ACCEPTED'
      AND latest."retentionUntil" > checked_at
  )
$$;

CREATE FUNCTION d05_record_reward_decision(
  cohort_id TEXT,
  target_eligibility_id TEXT,
  actor_player_id TEXT,
  decision_source "RewardEligibilitySource",
  decision_eligible BOOLEAN,
  decision_reason TEXT,
  decided_at TIMESTAMP(3),
  eligibility_id TEXT,
  audit_id TEXT,
  correlation_id TEXT
) RETURNS TABLE (result TEXT, "eligibilityId" TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target "RewardEligibility"%ROWTYPE;
  tenant_id TEXT;
BEGIN
  IF decision_source IS NULL OR decision_eligible IS NULL
     OR decision_source NOT IN ('MANUAL_ADJUSTMENT', 'REVOCATION')
     OR (decision_source = 'REVOCATION' AND decision_eligible)
     OR decision_reason IS NULL OR length(decision_reason) NOT BETWEEN 1 AND 500
     OR correlation_id IS NULL OR length(correlation_id) NOT BETWEEN 1 AND 500
     OR correlation_id ~ '[[:cntrl:]]' THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT cohort."restaurantId" INTO tenant_id
  FROM "TestCohort" cohort WHERE cohort."id" = cohort_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "RestaurantMembership" owner_membership
    WHERE owner_membership."playerId" = actor_player_id
      AND owner_membership."restaurantId" = tenant_id
      AND owner_membership."role" = 'OWNER'
      AND owner_membership."revokedAt" IS NULL
  ) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT reward.*
  INTO target
  FROM "RewardEligibility" reward
  WHERE reward."id" = target_eligibility_id
    AND reward."cohortId" = cohort_id
  FOR UPDATE OF reward;
  IF NOT FOUND OR target."source" = 'REVOCATION' THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "RewardEligibility" successor
    WHERE successor."supersedesEligibilityId" = target."id"
  ) THEN
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  INSERT INTO "RewardEligibility" (
    "id", "cohortId", "playerId", "policyVersion", "policyDigest", "milestoneEventId",
    "evidenceSnapshot", "evidenceHash", "eligible", "rewardKind", "source", "reason",
    "decidedByPlayerId", "decidedAt", "revokedAt", "supersedesEligibilityId"
  ) VALUES (
    eligibility_id, target."cohortId", target."playerId", target."policyVersion",
    target."policyDigest", target."milestoneEventId", target."evidenceSnapshot",
    target."evidenceHash", decision_eligible, target."rewardKind", decision_source,
    decision_reason, actor_player_id, decided_at,
    CASE WHEN decision_source = 'REVOCATION' THEN decided_at ELSE NULL END,
    target."id"
  );
  INSERT INTO "AuditLog" (
    "id", "restaurantId", "actorPlayerId", "actorType", "action", "targetType",
    "targetId", "metadata", "correlationId", "createdAt"
  ) VALUES (
    audit_id, tenant_id, actor_player_id, 'clerk_user',
    CASE WHEN decision_source = 'REVOCATION'
      THEN 'closed_beta_reward_eligibility_revoked'
      ELSE 'closed_beta_reward_eligibility_adjusted'
    END,
    'RewardEligibility', eligibility_id,
    jsonb_build_object(
      'cohortId', target."cohortId", 'playerId', target."playerId",
      'milestoneEventId', target."milestoneEventId", 'rewardKind', target."rewardKind",
      'evidenceHash', target."evidenceHash", 'eligible', decision_eligible,
      'source', decision_source, 'reason', decision_reason,
      'supersedesEligibilityId', target."id"
    ), correlation_id, decided_at
  );
  RETURN QUERY SELECT 'recorded'::TEXT, eligibility_id;
END;
$$;

CREATE FUNCTION d05_effective_reward_eligibility(
  cohort_id TEXT,
  player_id TEXT,
  milestone_event_id TEXT
) RETURNS TABLE (
  "eligibilityId" TEXT,
  "rewardKind" TEXT,
  eligible BOOLEAN,
  source "RewardEligibilitySource",
  "supersedesEligibilityId" TEXT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT current_reward."id", current_reward."rewardKind", current_reward."eligible",
         current_reward."source", current_reward."supersedesEligibilityId"
  FROM "RewardEligibility" current_reward
  WHERE current_reward."cohortId" = cohort_id
    AND current_reward."playerId" = player_id
    AND current_reward."milestoneEventId" = milestone_event_id
    AND NOT EXISTS (
      SELECT 1 FROM "RewardEligibility" successor
      WHERE successor."supersedesEligibilityId" = current_reward."id"
    )
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION d05_reject_history_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION d05_revoke_invite(TEXT, TEXT, TEXT, TIMESTAMP, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION d05_redeem_invite(TEXT, TEXT, TIMESTAMP, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION d05_record_consent_decision(TEXT, TEXT, "ConsentDecisionKind", TIMESTAMP, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION d05_is_entrance_eligible(TEXT, TEXT, TIMESTAMP) FROM PUBLIC;
REVOKE ALL ON FUNCTION d05_record_reward_decision(TEXT, TEXT, TEXT, "RewardEligibilitySource", BOOLEAN, TEXT, TIMESTAMP, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION d05_effective_reward_eligibility(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION d05_revoke_invite(TEXT, TEXT, TEXT, TIMESTAMP, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION d05_redeem_invite(TEXT, TEXT, TIMESTAMP, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION d05_record_consent_decision(TEXT, TEXT, "ConsentDecisionKind", TIMESTAMP, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION d05_is_entrance_eligible(TEXT, TEXT, TIMESTAMP) TO service_role;
GRANT EXECUTE ON FUNCTION d05_record_reward_decision(TEXT, TEXT, TEXT, "RewardEligibilitySource", BOOLEAN, TEXT, TIMESTAMP, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION d05_effective_reward_eligibility(TEXT, TEXT, TEXT) TO service_role;
GRANT USAGE, SELECT ON SEQUENCE "ConsentDecision_decisionSequence_seq" TO service_role;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'TestCohort', 'ConsentPolicy', 'TestCohortInvite', 'TestCohortMembership',
    'ConsentDecision', 'RewardEligibility'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO service_role', table_name);
  END LOOP;
END;
$$;
