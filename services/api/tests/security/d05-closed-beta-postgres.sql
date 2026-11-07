\set ON_ERROR_STOP on

CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE EXTENSION dblink;

\ir ../../prisma/migrations/20260814000100_d01_p0_persistence/migration.sql
\ir ../../prisma/migrations/20260814000300_d05_closed_beta_entry/migration.sql

SET ROLE service_role;
INSERT INTO "Player" ("id", "clerkUserId", "displayName") VALUES
  ('owner-a', 'clerk-owner-a', 'Owner A'),
  ('owner-b', 'clerk-owner-b', 'Owner B'),
  ('player-a', 'clerk-player-a', 'Player A'),
  ('player-b', 'clerk-player-b', 'Player B'),
  ('player-c', 'clerk-player-c', 'Player C'),
  ('player-d', 'clerk-player-d', 'Player D'),
  ('player-e', 'clerk-player-e', 'Player E');
INSERT INTO "Restaurant" ("id", "name") VALUES
  ('tenant-a', 'Tenant A'),
  ('tenant-b', 'Tenant B');
INSERT INTO "RestaurantMembership" ("id", "playerId", "restaurantId", "role") VALUES
  ('owner-membership-a', 'owner-a', 'tenant-a', 'OWNER'),
  ('owner-membership-b', 'owner-b', 'tenant-b', 'OWNER');

INSERT INTO "TestCohort" (
  "id", "restaurantId", "name", "purpose", "environment", "status", "quota",
  "opensAt", "closesAt", "featureFlags", "eligibilityPolicyVersion",
  "eligibilityPolicyDigest", "createdByPlayerId", "openedAt", "createdAt", "updatedAt"
) VALUES (
  'cohort-main', 'tenant-a', 'Main Cohort', 'D05 integration', 'local', 'OPEN', 4,
  TIMESTAMP '2030-01-01 00:00:00', TIMESTAMP '2030-01-08 00:00:00',
  '{"core":true,"ai":false}', 'milestone-v1', repeat('a', 64), 'owner-a',
  TIMESTAMP '2030-01-01 00:00:00', TIMESTAMP '2029-12-31 23:00:00',
  TIMESTAMP '2030-01-01 00:00:00'
);
INSERT INTO "ConsentPolicy" (
  "id", "cohortId", "purpose", "version", "policyDigest", "scope", "dataCategories",
  "retentionDays", "requiredForEntry", "createdByPlayerId", "createdAt"
) VALUES (
  'policy-main', 'cohort-main', 'closed_beta_participation', 'consent-v1', repeat('b', 64),
  '{"collection":"minimum-required"}', '["identity_reference","security_audit"]',
  1, TRUE, 'owner-a', TIMESTAMP '2029-12-31 23:00:00'
);
UPDATE "TestCohort" SET "entryConsentPolicyId" = 'policy-main' WHERE "id" = 'cohort-main';

INSERT INTO "TestCohort" (
  "id", "restaurantId", "name", "purpose", "environment", "status", "quota",
  "opensAt", "closesAt", "featureFlags", "eligibilityPolicyVersion",
  "eligibilityPolicyDigest", "createdByPlayerId", "createdAt", "updatedAt"
) VALUES (
  'cohort-other-tenant', 'tenant-b', 'Other Tenant Cohort', 'cross-tenant proof', 'local',
  'DRAFT', 1, TIMESTAMP '2030-01-01 00:00:00', TIMESTAMP '2030-01-08 00:00:00', '{}',
  'milestone-v1', repeat('9',64), 'owner-b', TIMESTAMP '2029-12-31 23:00:00',
  TIMESTAMP '2029-12-31 23:00:00'
);
INSERT INTO "RewardEligibility" (
  "id", "cohortId", "playerId", "policyVersion", "policyDigest", "milestoneEventId",
  "evidenceSnapshot", "evidenceHash", "eligible", "rewardKind", "source", "reason", "decidedAt"
) VALUES (
  'reward-other-tenant', 'cohort-other-tenant', 'player-a', 'milestone-v1', repeat('9',64),
  'event-other-tenant', '{"verified":true}', repeat('9',64), TRUE, 'TITLE', 'SERVER_EVENT',
  'other tenant server event', TIMESTAMP '2030-01-01 00:00:00'
);

INSERT INTO "TestCohortInvite" (
  "id", "cohortId", "invitedPlayerId", "issuedByPlayerId", "tokenDigest", "status",
  "expiresAt", "activatedAt", "revokedAt", "revokedByPlayerId", "createdAt"
) VALUES
  ('invite-a', 'cohort-main', 'player-a', 'owner-a', repeat('1', 64), 'ACTIVE',
   TIMESTAMP '2030-01-02 00:00:00', TIMESTAMP '2030-01-01 00:00:00', NULL, NULL,
   TIMESTAMP '2029-12-31 23:30:00'),
  ('invite-wrong-user', 'cohort-main', 'player-b', 'owner-a', repeat('2', 64), 'ACTIVE',
   TIMESTAMP '2030-01-02 00:00:00', TIMESTAMP '2030-01-01 00:00:00', NULL, NULL,
   TIMESTAMP '2029-12-31 23:30:00'),
  ('invite-revoked', 'cohort-main', 'player-c', 'owner-a', repeat('3', 64), 'REVOKED',
   TIMESTAMP '2030-01-02 00:00:00', NULL, TIMESTAMP '2030-01-01 00:00:30', 'owner-a',
   TIMESTAMP '2029-12-31 23:30:00'),
  ('invite-expired', 'cohort-main', 'player-d', 'owner-a', repeat('7', 64), 'ACTIVE',
   TIMESTAMP '2030-01-01 00:00:30', TIMESTAMP '2030-01-01 00:00:00', NULL, NULL,
   TIMESTAMP '2029-12-31 23:30:00'),
  ('invite-cross-tenant-active', 'cohort-other-tenant', 'player-e', 'owner-b', repeat('8', 64), 'ACTIVE',
   TIMESTAMP '2030-01-02 00:00:00', TIMESTAMP '2030-01-01 00:00:00', NULL, NULL,
   TIMESTAMP '2029-12-31 23:30:00'),
  ('invite-valid-owner-revoke', 'cohort-main', 'player-e', 'owner-a', repeat('9', 64), 'DRAFT',
   TIMESTAMP '2030-01-02 00:00:00', NULL, NULL, NULL,
   TIMESTAMP '2029-12-31 23:30:00');

DO $$
DECLARE
  missing_outcome TEXT;
  terminal_outcome TEXT;
  cross_tenant_outcome TEXT;
  owner_outcome TEXT;
BEGIN
  SELECT result INTO missing_outcome FROM d05_revoke_invite(
    'invite-missing', 'cohort-main', 'owner-a', TIMESTAMP '2030-01-01 00:00:10',
    'audit-missing-probe', 'pg-missing-probe'
  );
  SELECT result INTO terminal_outcome FROM d05_revoke_invite(
    'invite-revoked', 'cohort-main', 'owner-a', TIMESTAMP '2030-01-01 00:00:10',
    'audit-terminal-probe', 'pg-terminal-probe'
  );
  SELECT result INTO cross_tenant_outcome FROM d05_revoke_invite(
    'invite-cross-tenant-active', 'cohort-other-tenant', 'owner-a',
    TIMESTAMP '2030-01-01 00:00:10', 'audit-cross-tenant-probe', 'pg-cross-tenant-probe'
  );
  IF missing_outcome <> 'invalid' OR terminal_outcome <> missing_outcome
     OR cross_tenant_outcome <> missing_outcome
     OR EXISTS (SELECT 1 FROM "AuditLog"
                WHERE "id" IN ('audit-missing-probe', 'audit-terminal-probe', 'audit-cross-tenant-probe'))
     OR NOT EXISTS (SELECT 1 FROM "TestCohortInvite"
                    WHERE "id" = 'invite-cross-tenant-active' AND "status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'revoke probes were distinguishable or mutated unauthorized state';
  END IF;

  SELECT result INTO owner_outcome FROM d05_revoke_invite(
    'invite-valid-owner-revoke', 'cohort-main', 'owner-a', TIMESTAMP '2030-01-01 00:00:10',
    'audit-valid-owner-revoke', 'pg-valid-owner-revoke'
  );
  IF owner_outcome <> 'revoked'
     OR NOT EXISTS (SELECT 1 FROM "TestCohortInvite"
                    WHERE "id" = 'invite-valid-owner-revoke' AND "status" = 'REVOKED')
     OR NOT EXISTS (SELECT 1 FROM "AuditLog"
                    WHERE "id" = 'audit-valid-owner-revoke'
                      AND "action" = 'closed_beta_invite_revoked'
                      AND "correlationId" = 'pg-valid-owner-revoke') THEN
    RAISE EXCEPTION 'valid owner revoke outcome or audit changed';
  END IF;
END;
$$;

DO $$
DECLARE
  outcome TEXT;
BEGIN
  SELECT result INTO outcome FROM d05_redeem_invite(
    repeat('1', 64), 'player-b', TIMESTAMP '2030-01-01 00:01:00', 'wrong-member', 'wrong-audit',
    'pg-wrong-correlation'
  );
  IF outcome <> 'invalid' OR EXISTS (
    SELECT 1 FROM "TestCohortMembership" WHERE "id" = 'wrong-member'
  ) THEN
    RAISE EXCEPTION 'cross-user invite redemption did not fail closed';
  END IF;

  SELECT result INTO outcome FROM d05_redeem_invite(
    repeat('3', 64), 'player-c', TIMESTAMP '2030-01-01 00:01:00', 'revoked-member', 'revoked-audit',
    'pg-revoked-correlation'
  );
  IF outcome <> 'invalid' THEN
    RAISE EXCEPTION 'revoked invite redemption unexpectedly succeeded';
  END IF;

  SELECT result INTO outcome FROM d05_redeem_invite(
    repeat('7', 64), 'player-d', TIMESTAMP '2030-01-01 00:01:00', 'expired-member',
    'audit-expired-redeem', 'pg-expired-correlation'
  );
  IF outcome <> 'invalid'
     OR NOT EXISTS (
       SELECT 1 FROM "TestCohortInvite" WHERE "id" = 'invite-expired' AND "status" = 'EXPIRED'
     ) OR NOT EXISTS (
       SELECT 1 FROM "AuditLog"
       WHERE "id" = 'audit-expired-redeem'
         AND "action" = 'closed_beta_invite_expired_on_redeem'
         AND "targetId" = 'invite-expired'
         AND "correlationId" = 'pg-expired-correlation'
         AND NOT ("metadata" ? 'tokenDigest')
         AND "metadata"::text NOT LIKE '%' || repeat('7', 64) || '%'
     ) THEN
    RAISE EXCEPTION 'expired redemption was not atomically audited without its digest';
  END IF;

  SELECT result INTO outcome FROM d05_redeem_invite(
    repeat('1', 64), 'player-a', TIMESTAMP '2030-01-01 00:01:00', 'membership-a', 'audit-redeem-a',
    'pg-redeem-correlation'
  );
  IF outcome <> 'redeemed' OR NOT EXISTS (
    SELECT 1 FROM "TestCohortInvite" WHERE "id" = 'invite-a' AND "status" = 'CONSUMED'
  ) OR NOT EXISTS (
    SELECT 1 FROM "TestCohortMembership"
    WHERE "id" = 'membership-a' AND "playerId" = 'player-a' AND "status" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'valid atomic invite redemption failed';
  END IF;

  SELECT result INTO outcome FROM d05_redeem_invite(
    repeat('1', 64), 'player-a', TIMESTAMP '2030-01-01 00:02:00', 'duplicate-member', 'duplicate-audit',
    'pg-duplicate-correlation'
  );
  IF outcome <> 'invalid' THEN
    RAISE EXCEPTION 'consumed invite was reusable';
  END IF;

  IF d05_is_entrance_eligible('player-a', 'tenant-a', TIMESTAMP '2030-01-01 00:02:00') THEN
    RAISE EXCEPTION 'membership became eligible before consent acceptance';
  END IF;
  IF d05_is_entrance_eligible('player-a', 'tenant-b', TIMESTAMP '2030-01-01 00:02:00') THEN
    RAISE EXCEPTION 'cross-tenant eligibility leaked';
  END IF;

  SELECT result INTO outcome FROM d05_record_consent_decision(
    'policy-main', 'player-a', 'ACCEPTED', TIMESTAMP '2030-01-01 00:03:00',
    'consent-accept-a', 'audit-consent-accept-a', 'pg-consent-accept-correlation'
  );
  IF outcome <> 'accepted'
     OR NOT d05_is_entrance_eligible('player-a', 'tenant-a', TIMESTAMP '2030-01-01 00:04:00') THEN
    RAISE EXCEPTION 'durable consent acceptance did not precede eligibility';
  END IF;
  IF d05_is_entrance_eligible('player-a', 'tenant-a', TIMESTAMP '2030-01-02 00:03:01') THEN
    RAISE EXCEPTION 'expired consent remained eligible';
  END IF;

  SELECT result INTO outcome FROM d05_record_consent_decision(
    'policy-main', 'player-a', 'WITHDRAWN', TIMESTAMP '2030-01-01 00:05:00',
    'consent-withdraw-a', 'audit-consent-withdraw-a', 'pg-consent-withdraw-correlation'
  );
  IF outcome <> 'withdrawn'
     OR d05_is_entrance_eligible('player-a', 'tenant-a', TIMESTAMP '2030-01-01 00:06:00') THEN
    RAISE EXCEPTION 'consent withdrawal did not immediately fail closed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "ConsentDecision"
    WHERE "id" = 'consent-accept-a' AND "actorPlayerId" = 'player-a'
      AND "acceptedAt" = TIMESTAMP '2030-01-01 00:03:00'
      AND "policyVersion" = 'consent-v1' AND "policyDigest" = repeat('b', 64)
      AND "scope" = '{"collection":"minimum-required"}'::jsonb
  ) OR NOT EXISTS (
    SELECT 1 FROM "AuditLog"
    WHERE "id" = 'audit-consent-accept-a'
      AND "correlationId" = 'pg-consent-accept-correlation'
      AND "metadata"->>'policyDigest' = repeat('b', 64)
  ) THEN
    RAISE EXCEPTION 'consent proof or audit snapshot missing';
  END IF;

  BEGIN
    UPDATE "ConsentDecision" SET "purpose" = 'tampered' WHERE "id" = 'consent-accept-a';
    RAISE EXCEPTION 'append-only consent history was mutable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'D05 history is append-only' THEN RAISE; END IF;
  END;

  SELECT result INTO outcome FROM d05_redeem_invite(
    repeat('2', 64), 'player-b', TIMESTAMP '2030-01-01 00:06:00', 'membership-b',
    'audit-redeem-b', 'pg-redeem-b-correlation'
  );
  IF outcome <> 'redeemed' THEN RAISE EXCEPTION 'player-b setup redemption failed'; END IF;

  SELECT result INTO outcome FROM d05_record_consent_decision(
    'policy-main', 'player-b', 'ACCEPTED', TIMESTAMP '2030-01-01 00:06:30',
    'zzz-consent-accept-b', 'audit-consent-accept-b', 'pg-consent-sequence-1'
  );
  IF outcome <> 'accepted' THEN RAISE EXCEPTION 'same-time accept failed'; END IF;
  SELECT result INTO outcome FROM d05_record_consent_decision(
    'policy-main', 'player-b', 'WITHDRAWN', TIMESTAMP '2030-01-01 00:06:30',
    'mmm-consent-withdraw-b', 'audit-consent-withdraw-b', 'pg-consent-sequence-2'
  );
  IF outcome <> 'withdrawn' THEN RAISE EXCEPTION 'same-time withdrawal failed'; END IF;
  SELECT result INTO outcome FROM d05_record_consent_decision(
    'policy-main', 'player-b', 'ACCEPTED', TIMESTAMP '2030-01-01 00:06:30',
    'aaa-consent-reaccept-b', 'audit-consent-reaccept-b', 'pg-consent-sequence-3'
  );
  IF outcome <> 'accepted'
     OR NOT d05_is_entrance_eligible('player-b', 'tenant-a', TIMESTAMP '2030-01-01 00:06:31')
     OR NOT EXISTS (
       SELECT 1
       FROM "ConsentDecision" first_decision
       JOIN "ConsentDecision" second_decision ON second_decision."id" = 'mmm-consent-withdraw-b'
       JOIN "ConsentDecision" third_decision ON third_decision."id" = 'aaa-consent-reaccept-b'
       WHERE first_decision."id" = 'zzz-consent-accept-b'
         AND first_decision."createdAt" = second_decision."createdAt"
         AND second_decision."createdAt" = third_decision."createdAt"
         AND first_decision."decisionSequence" < second_decision."decisionSequence"
         AND second_decision."decisionSequence" < third_decision."decisionSequence"
     ) THEN
    RAISE EXCEPTION 'database-monotonic same-time consent ordering failed';
  END IF;

  BEGIN
    INSERT INTO "RewardEligibility" (
      "id", "cohortId", "playerId", "policyVersion", "policyDigest", "milestoneEventId",
      "evidenceSnapshot", "evidenceHash", "eligible", "rewardKind", "source", "reason", "decidedAt"
    ) VALUES (
      'reward-bad', 'cohort-main', 'player-a', 'milestone-v1', repeat('a',64), 'event-bad',
      '{"completed":true}', repeat('c',64), TRUE, 'CASH', 'SERVER_EVENT', 'invalid',
      TIMESTAMP '2030-01-01 00:07:00'
    );
    RAISE EXCEPTION 'competitive reward kind unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  INSERT INTO "RewardEligibility" (
    "id", "cohortId", "playerId", "policyVersion", "policyDigest", "milestoneEventId",
    "evidenceSnapshot", "evidenceHash", "eligible", "rewardKind", "source", "reason", "decidedAt"
  ) VALUES (
    'reward-title', 'cohort-main', 'player-a', 'milestone-v1', repeat('a',64), 'event-title',
    '{"businessDay":3,"completed":true}', repeat('d',64), TRUE, 'TITLE', 'SERVER_EVENT',
    'server milestone satisfied', TIMESTAMP '2030-01-01 00:07:00'
  );

  SELECT result INTO outcome FROM d05_record_reward_decision(
    'cohort-main', 'missing-reward', 'owner-a', 'MANUAL_ADJUSTMENT', TRUE,
    'missing target', TIMESTAMP '2030-01-01 00:08:00', 'reward-missing-adjustment',
    'audit-reward-missing', 'pg-reward-missing-correlation'
  );
  IF outcome <> 'invalid' THEN RAISE EXCEPTION 'missing reward target was accepted'; END IF;

  SELECT result INTO outcome FROM d05_record_reward_decision(
    'cohort-main', 'reward-other-tenant', 'owner-a', 'MANUAL_ADJUSTMENT', TRUE,
    'cross tenant target', TIMESTAMP '2030-01-01 00:08:00', 'reward-cross-target-adjustment',
    'audit-reward-cross', 'pg-reward-cross-correlation'
  );
  IF outcome <> 'invalid' THEN RAISE EXCEPTION 'cross-tenant reward target was accepted'; END IF;

  SELECT result INTO outcome FROM d05_record_reward_decision(
    'cohort-main', 'reward-title', 'owner-b', 'MANUAL_ADJUSTMENT', TRUE,
    'cross tenant actor', TIMESTAMP '2030-01-01 00:08:00', 'reward-cross-actor-adjustment',
    'audit-reward-cross-actor', 'pg-reward-cross-actor-correlation'
  );
  IF outcome <> 'forbidden' THEN RAISE EXCEPTION 'cross-tenant reward actor was accepted'; END IF;

  SELECT result INTO outcome FROM d05_record_reward_decision(
    'cohort-main', 'reward-title', 'owner-a', 'MANUAL_ADJUSTMENT', TRUE,
    'verified adjustment', TIMESTAMP '2030-01-01 00:08:00', 'reward-title-adjusted',
    'audit-reward-adjusted', 'pg-reward-adjust-correlation'
  );
  IF outcome <> 'recorded' THEN RAISE EXCEPTION 'reward adjustment failed'; END IF;

  SELECT result INTO outcome FROM d05_record_reward_decision(
    'cohort-main', 'reward-title', 'owner-a', 'REVOCATION', FALSE,
    'duplicate target', TIMESTAMP '2030-01-01 00:09:00', 'reward-title-duplicate',
    'audit-reward-duplicate', 'pg-reward-duplicate-correlation'
  );
  IF outcome <> 'invalid' THEN RAISE EXCEPTION 'duplicate reward target was accepted'; END IF;

  SELECT result INTO outcome FROM d05_record_reward_decision(
    'cohort-main', 'reward-title-adjusted', 'owner-a', 'REVOCATION', FALSE,
    'security revoke', TIMESTAMP '2030-01-01 00:09:00', 'reward-title-revoked',
    'audit-reward-revoked', 'pg-reward-revoke-correlation'
  );
  IF outcome <> 'recorded' THEN RAISE EXCEPTION 'reward revocation failed'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM d05_effective_reward_eligibility('cohort-main', 'player-a', 'event-title') effective
    WHERE effective."eligibilityId" = 'reward-title-revoked'
      AND effective.eligible = FALSE AND effective.source = 'REVOCATION'
      AND effective."supersedesEligibilityId" = 'reward-title-adjusted'
  ) OR NOT EXISTS (
    SELECT 1 FROM "AuditLog"
    WHERE "id" = 'audit-reward-revoked'
      AND "correlationId" = 'pg-reward-revoke-correlation'
      AND "metadata"->>'supersedesEligibilityId' = 'reward-title-adjusted'
      AND "metadata"->>'milestoneEventId' = 'event-title'
  ) THEN
    RAISE EXCEPTION 'effective reward revoke or exact-target audit missing';
  END IF;

  SELECT result INTO outcome FROM d05_record_reward_decision(
    'cohort-main', 'reward-title-revoked', 'owner-a', 'MANUAL_ADJUSTMENT', TRUE,
    'cannot revive revoke', TIMESTAMP '2030-01-01 00:10:00', 'reward-title-revived',
    'audit-reward-revived', 'pg-reward-revive-correlation'
  );
  IF outcome <> 'invalid' THEN RAISE EXCEPTION 'revoked target was revived'; END IF;
END;
$$;

-- Concurrency proof: same token may create only one membership/audit.
INSERT INTO "TestCohortInvite" (
  "id", "cohortId", "invitedPlayerId", "issuedByPlayerId", "tokenDigest", "status",
  "expiresAt", "activatedAt", "createdAt"
) VALUES (
  'invite-concurrent', 'cohort-main', 'player-c', 'owner-a', repeat('4', 64), 'ACTIVE',
  TIMESTAMP '2030-01-02 00:00:00', TIMESTAMP '2030-01-01 00:00:00', TIMESTAMP '2029-12-31 23:30:00'
);
RESET ROLE;

SELECT dblink_connect('d05_same_1', 'dbname=d05_test user=postgres');
SELECT dblink_connect('d05_same_2', 'dbname=d05_test user=postgres');
SELECT dblink_send_query(
  'd05_same_1',
  $$SELECT result FROM d05_redeem_invite(
    repeat('4',64), 'player-c', TIMESTAMP '2030-01-01 00:10:00',
    'membership-concurrent-1', 'audit-concurrent-1', 'pg-same-token-correlation-1'
  )$$
);
SELECT dblink_send_query(
  'd05_same_2',
  $$SELECT result FROM d05_redeem_invite(
    repeat('4',64), 'player-c', TIMESTAMP '2030-01-01 00:10:00',
    'membership-concurrent-2', 'audit-concurrent-2', 'pg-same-token-correlation-2'
  )$$
);
CREATE TEMP TABLE concurrent_results (result TEXT);
INSERT INTO concurrent_results SELECT result FROM dblink_get_result('d05_same_1') AS response(result TEXT);
INSERT INTO concurrent_results SELECT result FROM dblink_get_result('d05_same_2') AS response(result TEXT);
DO $$
BEGIN
  IF (SELECT count(*) FROM concurrent_results WHERE result = 'redeemed') <> 1
     OR (SELECT count(*) FROM concurrent_results WHERE result = 'invalid') <> 1
     OR (SELECT count(*) FROM "TestCohortMembership" WHERE "playerId" = 'player-c') <> 1 THEN
    RAISE EXCEPTION 'same-token concurrency was not exactly-once';
  END IF;
END;
$$;
SELECT dblink_disconnect('d05_same_1');
SELECT dblink_disconnect('d05_same_2');

-- Two-session terminal-transition proof: revoke and redeem share invite -> cohort lock order.
SET ROLE service_role;
INSERT INTO "TestCohortInvite" (
  "id", "cohortId", "invitedPlayerId", "issuedByPlayerId", "tokenDigest", "status",
  "expiresAt", "activatedAt", "createdAt"
) VALUES (
  'invite-revoke-race', 'cohort-main', 'player-e', 'owner-a', repeat('0', 64), 'ACTIVE',
  TIMESTAMP '2030-01-02 00:00:00', TIMESTAMP '2030-01-01 00:00:00', TIMESTAMP '2029-12-31 23:30:00'
);
RESET ROLE;

SELECT dblink_connect('d05_revoke_race', 'dbname=d05_test user=postgres');
SELECT dblink_connect('d05_redeem_race', 'dbname=d05_test user=postgres');
SELECT dblink_exec('d05_revoke_race', $$SET statement_timeout = '5s'$$);
SELECT dblink_exec('d05_redeem_race', $$SET statement_timeout = '5s'$$);
SELECT dblink_send_query(
  'd05_revoke_race',
  $$SELECT result FROM d05_revoke_invite(
    'invite-revoke-race', 'cohort-main', 'owner-a', TIMESTAMP '2030-01-01 00:10:30',
    'audit-revoke-race', 'pg-revoke-race-correlation'
  )$$
);
SELECT dblink_send_query(
  'd05_redeem_race',
  $$SELECT result FROM d05_redeem_invite(
    repeat('0',64), 'player-e', TIMESTAMP '2030-01-01 00:10:30',
    'membership-revoke-race', 'audit-redeem-race', 'pg-redeem-race-correlation'
  )$$
);
TRUNCATE concurrent_results;
INSERT INTO concurrent_results
SELECT result FROM dblink_get_result('d05_revoke_race') AS response(result TEXT);
INSERT INTO concurrent_results
SELECT result FROM dblink_get_result('d05_redeem_race') AS response(result TEXT);
DO $$
DECLARE
  terminal_status "InviteStatus";
  active_memberships INTEGER;
BEGIN
  SELECT "status" INTO terminal_status FROM "TestCohortInvite"
  WHERE "id" = 'invite-revoke-race';
  SELECT count(*) INTO active_memberships FROM "TestCohortMembership"
  WHERE "cohortId" = 'cohort-main' AND "status" = 'ACTIVE';

  IF terminal_status NOT IN ('CONSUMED', 'REVOKED')
     OR (SELECT count(*) FROM concurrent_results WHERE result IN ('redeemed', 'revoked')) <> 1
     OR (SELECT count(*) FROM concurrent_results WHERE result = 'invalid') <> 1
     OR (SELECT count(*) FROM "AuditLog"
         WHERE "action" IN ('closed_beta_invite_redeemed', 'closed_beta_invite_revoked')
           AND "metadata"->>'inviteId' = 'invite-revoke-race') <> 1
     OR (terminal_status = 'CONSUMED' AND (
           NOT EXISTS (SELECT 1 FROM "TestCohortMembership"
                       WHERE "id" = 'membership-revoke-race' AND "status" = 'ACTIVE')
           OR NOT EXISTS (SELECT 1 FROM "AuditLog"
                          WHERE "id" = 'audit-redeem-race'
                            AND "action" = 'closed_beta_invite_redeemed'
                            AND "correlationId" = 'pg-redeem-race-correlation'
                            AND "metadata"->>'inviteId' = 'invite-revoke-race')
           OR active_memberships <> 4
         ))
     OR (terminal_status = 'REVOKED' AND (
           EXISTS (SELECT 1 FROM "TestCohortMembership" WHERE "id" = 'membership-revoke-race')
           OR NOT EXISTS (SELECT 1 FROM "AuditLog"
                          WHERE "id" = 'audit-revoke-race'
                            AND "action" = 'closed_beta_invite_revoked'
                            AND "correlationId" = 'pg-revoke-race-correlation'
                            AND "targetId" = 'invite-revoke-race')
           OR active_memberships <> 3
         ))
     OR active_memberships > (SELECT "quota" FROM "TestCohort" WHERE "id" = 'cohort-main') THEN
    RAISE EXCEPTION 'revoke-vs-redeem was not deadlock-free, exactly-once, and quota-consistent';
  END IF;
END;
$$;
SELECT dblink_disconnect('d05_revoke_race');
SELECT dblink_disconnect('d05_redeem_race');

-- Reward-chain concurrency proof: one current target can have only one successor.
SET ROLE service_role;
INSERT INTO "RewardEligibility" (
  "id", "cohortId", "playerId", "policyVersion", "policyDigest", "milestoneEventId",
  "evidenceSnapshot", "evidenceHash", "eligible", "rewardKind", "source", "reason", "decidedAt"
) VALUES (
  'reward-race', 'cohort-main', 'player-a', 'milestone-v1', repeat('a',64), 'event-race',
  '{"verified":true}', repeat('8',64), TRUE, 'TITLE', 'SERVER_EVENT',
  'server race event', TIMESTAMP '2030-01-01 00:11:00'
);
RESET ROLE;

SELECT dblink_connect('d05_reward_1', 'dbname=d05_test user=postgres');
SELECT dblink_connect('d05_reward_2', 'dbname=d05_test user=postgres');
SELECT dblink_send_query(
  'd05_reward_1',
  $$SELECT result FROM d05_record_reward_decision(
    'cohort-main', 'reward-race', 'owner-a', 'MANUAL_ADJUSTMENT', FALSE,
    'concurrent adjustment', TIMESTAMP '2030-01-01 00:12:00', 'reward-race-adjustment',
    'audit-reward-race-adjustment', 'pg-reward-race-correlation-1'
  )$$
);
SELECT dblink_send_query(
  'd05_reward_2',
  $$SELECT result FROM d05_record_reward_decision(
    'cohort-main', 'reward-race', 'owner-a', 'REVOCATION', FALSE,
    'concurrent revocation', TIMESTAMP '2030-01-01 00:12:00', 'reward-race-revocation',
    'audit-reward-race-revocation', 'pg-reward-race-correlation-2'
  )$$
);
TRUNCATE concurrent_results;
INSERT INTO concurrent_results SELECT result FROM dblink_get_result('d05_reward_1') AS response(result TEXT);
INSERT INTO concurrent_results SELECT result FROM dblink_get_result('d05_reward_2') AS response(result TEXT);
DO $$
BEGIN
  IF (SELECT count(*) FROM concurrent_results WHERE result = 'recorded') <> 1
     OR (SELECT count(*) FROM concurrent_results WHERE result = 'invalid') <> 1
     OR (SELECT count(*) FROM "RewardEligibility" WHERE "supersedesEligibilityId" = 'reward-race') <> 1
     OR (SELECT count(*) FROM "AuditLog" WHERE "metadata"->>'supersedesEligibilityId' = 'reward-race') <> 1 THEN
    RAISE EXCEPTION 'reward target concurrency did not produce exactly one successor and audit';
  END IF;
END;
$$;
SELECT dblink_disconnect('d05_reward_1');
SELECT dblink_disconnect('d05_reward_2');

-- Independent quota proof on a one-seat cohort with two distinct users/tokens.
SET ROLE service_role;
INSERT INTO "TestCohort" (
  "id", "restaurantId", "name", "purpose", "environment", "status", "quota",
  "opensAt", "closesAt", "featureFlags", "eligibilityPolicyVersion",
  "eligibilityPolicyDigest", "createdByPlayerId", "openedAt", "createdAt", "updatedAt"
) VALUES (
  'cohort-quota', 'tenant-a', 'Quota Cohort', 'quota race', 'local', 'OPEN', 1,
  TIMESTAMP '2030-01-01 00:00:00', TIMESTAMP '2030-01-08 00:00:00', '{}',
  'milestone-v1', repeat('e',64), 'owner-a', TIMESTAMP '2030-01-01 00:00:00',
  TIMESTAMP '2029-12-31 23:00:00', TIMESTAMP '2030-01-01 00:00:00'
);
INSERT INTO "ConsentPolicy" (
  "id", "cohortId", "purpose", "version", "policyDigest", "scope", "dataCategories",
  "retentionDays", "requiredForEntry", "createdByPlayerId"
) VALUES (
  'policy-quota', 'cohort-quota', 'entry', 'v1', repeat('f',64), '{}', '["minimum"]',
  1, TRUE, 'owner-a'
);
UPDATE "TestCohort" SET "entryConsentPolicyId" = 'policy-quota' WHERE "id" = 'cohort-quota';
INSERT INTO "TestCohortInvite" (
  "id", "cohortId", "invitedPlayerId", "issuedByPlayerId", "tokenDigest", "status",
  "expiresAt", "activatedAt", "createdAt"
) VALUES
  ('invite-quota-c', 'cohort-quota', 'player-c', 'owner-a', repeat('5',64), 'ACTIVE',
   TIMESTAMP '2030-01-02 00:00:00', TIMESTAMP '2030-01-01 00:00:00', TIMESTAMP '2029-12-31 23:30:00'),
  ('invite-quota-d', 'cohort-quota', 'player-d', 'owner-a', repeat('6',64), 'ACTIVE',
   TIMESTAMP '2030-01-02 00:00:00', TIMESTAMP '2030-01-01 00:00:00', TIMESTAMP '2029-12-31 23:30:00');
RESET ROLE;

SELECT dblink_connect('d05_quota_1', 'dbname=d05_test user=postgres');
SELECT dblink_connect('d05_quota_2', 'dbname=d05_test user=postgres');
SELECT dblink_send_query(
  'd05_quota_1',
  $$SELECT result FROM d05_redeem_invite(
    repeat('5',64), 'player-c', TIMESTAMP '2030-01-01 00:20:00', 'quota-member-c', 'quota-audit-c',
    'pg-quota-correlation-c'
  )$$
);
SELECT dblink_send_query(
  'd05_quota_2',
  $$SELECT result FROM d05_redeem_invite(
    repeat('6',64), 'player-d', TIMESTAMP '2030-01-01 00:20:00', 'quota-member-d', 'quota-audit-d',
    'pg-quota-correlation-d'
  )$$
);
TRUNCATE concurrent_results;
INSERT INTO concurrent_results SELECT result FROM dblink_get_result('d05_quota_1') AS response(result TEXT);
INSERT INTO concurrent_results SELECT result FROM dblink_get_result('d05_quota_2') AS response(result TEXT);
DO $$
BEGIN
  IF (SELECT count(*) FROM concurrent_results WHERE result = 'redeemed') <> 1
     OR (SELECT count(*) FROM "TestCohortMembership" WHERE "cohortId" = 'cohort-quota' AND "status" = 'ACTIVE') <> 1 THEN
    RAISE EXCEPTION 'cohort quota concurrency admitted more than one player';
  END IF;
END;
$$;
SELECT dblink_disconnect('d05_quota_1');
SELECT dblink_disconnect('d05_quota_2');

SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM "TestCohortInvite";
    RAISE EXCEPTION 'authenticated client unexpectedly read invite digests';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM d05_redeem_invite(repeat('1',64), 'player-a', CURRENT_TIMESTAMP::TIMESTAMP, 'x', 'y', 'z');
    RAISE EXCEPTION 'authenticated client unexpectedly executed invite redemption';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM d05_revoke_invite('invite-a', 'cohort-main', 'owner-a', CURRENT_TIMESTAMP::TIMESTAMP, 'x', 'z');
    RAISE EXCEPTION 'authenticated client unexpectedly executed invite revocation';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
RESET ROLE;

\ir ../../prisma/migrations/20260814000300_d05_closed_beta_entry/rollback.sql
DO $$
BEGIN
  IF to_regclass('public."TestCohort"') IS NOT NULL
     OR to_regclass('public."ConsentDecision"') IS NOT NULL
     OR to_regprocedure('public.d05_redeem_invite(text,text,timestamp without time zone,text,text,text)') IS NOT NULL
     OR to_regprocedure('public.d05_revoke_invite(text,text,text,timestamp without time zone,text,text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InviteStatus') THEN
    RAISE EXCEPTION 'D05 rollback left durable artifacts behind';
  END IF;
END;
$$;
\ir ../../prisma/migrations/20260814000100_d01_p0_persistence/rollback.sql
