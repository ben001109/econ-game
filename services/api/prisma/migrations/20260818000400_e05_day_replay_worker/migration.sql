-- E05-S-03: immutable worker rule selection for durable Day replay evidence.
-- The payload is canonical JSON and its hash is SHA-256 over that canonical form.

DO $$
DECLARE
  expected_payload CONSTANT JSONB := jsonb_build_object(
    'evidenceVersion', 'mvp-release-evidence-v1',
    'locatorSchemaVersion', 'p0-day-replay-locator/v1',
    'resultSchemaVersion', 'e05-day-replay-verification/v1'
  );
  expected_hash CONSTANT TEXT := 'ce780a297faaf2a925870e62e0db9b8daffb7b79ec8f5045547b993ef4d8925b';
  artifact_exists BOOLEAN;
BEGIN
  IF to_regclass('public."SimulationVersionArtifact"') IS NULL
     OR to_regclass('public."SimulationJob"') IS NULL
     OR to_regclass('public."VersionedReplayExecution"') IS NULL THEN
    RAISE EXCEPTION 'E05 Day replay migration requires the D03 simulation tables';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "SimulationVersionArtifact"
    WHERE "artifactKind" = 'RULE'
      AND "artifactKey" = 'DAY_REPLAY_EVIDENCE'
      AND "version" = 'mvp-release-evidence-v1'
  ) INTO artifact_exists;

  IF artifact_exists AND EXISTS (
    SELECT 1
    FROM "SimulationVersionArtifact"
    WHERE "artifactKind" = 'RULE'
      AND "artifactKey" = 'DAY_REPLAY_EVIDENCE'
      AND "version" = 'mvp-release-evidence-v1'
      AND (
        "id" <> 'RULE:DAY_REPLAY_EVIDENCE:mvp-release-evidence-v1'
        OR "processorId" IS DISTINCT FROM 'E05_DAY_REPLAY_SHA256_V1'
        OR "payload" IS DISTINCT FROM expected_payload
        OR "payloadHash" IS DISTINCT FROM expected_hash
      )
  ) THEN
    RAISE EXCEPTION 'conflicting DAY_REPLAY_EVIDENCE artifact already exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "VersionedReplayExecution"
    WHERE ("replayKind" = 'DAY_REPLAY')
      AND (
        "ruleArtifactKey" IS DISTINCT FROM 'DAY_REPLAY_EVIDENCE'
        OR "ruleVersion" IS DISTINCT FROM 'mvp-release-evidence-v1'
        OR NOT artifact_exists
      )
  ) OR EXISTS (
    SELECT 1
    FROM "VersionedReplayExecution"
    WHERE "ruleArtifactKey" = 'DAY_REPLAY_EVIDENCE'
      AND "ruleVersion" = 'mvp-release-evidence-v1'
      AND "replayKind" <> 'DAY_REPLAY'
  ) THEN
    RAISE EXCEPTION 'conflicting versioned replay execution history exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SimulationJob"
    WHERE "inputPayload"->>'replayKind' = 'DAY_REPLAY'
      AND (
        "inputPayload"#>>'{rule,key}' IS DISTINCT FROM 'DAY_REPLAY_EVIDENCE'
        OR "inputPayload"#>>'{rule,version}' IS DISTINCT FROM 'mvp-release-evidence-v1'
        OR NOT artifact_exists
      )
  ) OR EXISTS (
    SELECT 1
    FROM "SimulationJob"
    WHERE "inputPayload"#>>'{rule,key}' = 'DAY_REPLAY_EVIDENCE'
      AND "inputPayload"#>>'{rule,version}' = 'mvp-release-evidence-v1'
      AND "inputPayload"->>'replayKind' <> 'DAY_REPLAY'
  ) THEN
    RAISE EXCEPTION 'conflicting simulation job history exists';
  END IF;
END;
$$;

INSERT INTO "SimulationVersionArtifact" (
  "id", "artifactKind", "artifactKey", "version", "processorId", "payload", "payloadHash"
) VALUES (
  'RULE:DAY_REPLAY_EVIDENCE:mvp-release-evidence-v1',
  'RULE',
  'DAY_REPLAY_EVIDENCE',
  'mvp-release-evidence-v1',
  'E05_DAY_REPLAY_SHA256_V1',
  '{"evidenceVersion":"mvp-release-evidence-v1","locatorSchemaVersion":"p0-day-replay-locator/v1","resultSchemaVersion":"e05-day-replay-verification/v1"}'::jsonb,
  'ce780a297faaf2a925870e62e0db9b8daffb7b79ec8f5045547b993ef4d8925b'
)
ON CONFLICT ("artifactKind", "artifactKey", "version") DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "SimulationVersionArtifact"
    WHERE "id" = 'RULE:DAY_REPLAY_EVIDENCE:mvp-release-evidence-v1'
      AND "artifactKind" = 'RULE'
      AND "artifactKey" = 'DAY_REPLAY_EVIDENCE'
      AND "version" = 'mvp-release-evidence-v1'
      AND "processorId" = 'E05_DAY_REPLAY_SHA256_V1'
      AND "payload" = '{"evidenceVersion":"mvp-release-evidence-v1","locatorSchemaVersion":"p0-day-replay-locator/v1","resultSchemaVersion":"e05-day-replay-verification/v1"}'::jsonb
      AND "payloadHash" = 'ce780a297faaf2a925870e62e0db9b8daffb7b79ec8f5045547b993ef4d8925b'
  ) THEN
    RAISE EXCEPTION 'DAY_REPLAY_EVIDENCE artifact was not provisioned exactly';
  END IF;
END;
$$;
