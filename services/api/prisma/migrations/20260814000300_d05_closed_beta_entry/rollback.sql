-- D05-S-01 rollback. D01/D04 and D05-S-02 are intentionally untouched.

DROP FUNCTION IF EXISTS d05_is_entrance_eligible(TEXT, TEXT, TIMESTAMP);
DROP FUNCTION IF EXISTS d05_effective_reward_eligibility(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS d05_record_reward_decision(TEXT, TEXT, TEXT, "RewardEligibilitySource", BOOLEAN, TEXT, TIMESTAMP, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS d05_record_consent_decision(TEXT, TEXT, "ConsentDecisionKind", TIMESTAMP, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS d05_redeem_invite(TEXT, TEXT, TIMESTAMP, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS d05_revoke_invite(TEXT, TEXT, TEXT, TIMESTAMP, TEXT, TEXT);

DROP TRIGGER IF EXISTS "RewardEligibility_append_only" ON "RewardEligibility";
DROP TRIGGER IF EXISTS "ConsentDecision_append_only" ON "ConsentDecision";
DROP FUNCTION IF EXISTS d05_reject_history_mutation();

ALTER TABLE IF EXISTS "TestCohort" DROP CONSTRAINT IF EXISTS "TestCohort_entryConsentPolicy_fkey";
DROP TABLE IF EXISTS "RewardEligibility";
DROP TABLE IF EXISTS "ConsentDecision";
DROP TABLE IF EXISTS "TestCohortMembership";
DROP TABLE IF EXISTS "TestCohortInvite";
DROP TABLE IF EXISTS "ConsentPolicy";
DROP TABLE IF EXISTS "TestCohort";

DROP TYPE IF EXISTS "RewardEligibilitySource";
DROP TYPE IF EXISTS "ConsentDecisionKind";
DROP TYPE IF EXISTS "CohortMembershipStatus";
DROP TYPE IF EXISTS "InviteStatus";
DROP TYPE IF EXISTS "TestCohortStatus";
