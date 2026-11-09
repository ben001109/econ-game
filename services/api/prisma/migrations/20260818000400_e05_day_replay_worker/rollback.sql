-- SimulationVersionArtifact is retained immutable evidence under D05. This
-- rollback therefore validates all references and then fails closed; it never
-- disables the append-only trigger or deletes the artifact or replay evidence.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "SimulationJob"
    WHERE "inputPayload"#>>'{rule,kind}' = 'RULE'
      AND "inputPayload"#>>'{rule,key}' = 'DAY_REPLAY_EVIDENCE'
      AND "inputPayload"#>>'{rule,version}' = 'mvp-release-evidence-v1'
  ) THEN
    RAISE EXCEPTION 'rollback refused: SimulationJob references DAY_REPLAY_EVIDENCE';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "VersionedReplayExecution"
    WHERE "ruleArtifactKey" = 'DAY_REPLAY_EVIDENCE'
      AND "ruleVersion" = 'mvp-release-evidence-v1'
  ) THEN
    RAISE EXCEPTION 'rollback refused: VersionedReplayExecution references DAY_REPLAY_EVIDENCE';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "SimulationVersionArtifact"
    WHERE "id" = 'RULE:DAY_REPLAY_EVIDENCE:mvp-release-evidence-v1'
      AND "artifactKind" = 'RULE'
      AND "artifactKey" = 'DAY_REPLAY_EVIDENCE'
      AND "version" = 'mvp-release-evidence-v1'
      AND "processorId" = 'E05_DAY_REPLAY_SHA256_V1'
      AND "payloadHash" = 'ce780a297faaf2a925870e62e0db9b8daffb7b79ec8f5045547b993ef4d8925b'
  ) THEN
    RAISE EXCEPTION 'rollback refused: DAY_REPLAY_EVIDENCE artifact is missing or conflicts';
  END IF;
  RAISE EXCEPTION 'rollback refused: DAY_REPLAY_EVIDENCE is retained immutable evidence';
END;
$$;
