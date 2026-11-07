-- D04 durable Discord identity-link challenge and atomic activation boundary.
-- This migration is intentionally separate from the immutable D01 baseline.

DO $$
BEGIN
  IF to_regclass('public."Player"') IS NULL
     OR to_regclass('public."IdentityLink"') IS NULL
     OR to_regclass('public."AuditLog"') IS NULL THEN
    RAISE EXCEPTION 'D04 migration requires the D01 identity and audit tables';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls) THEN
    RAISE EXCEPTION 'D04 migration requires the Supabase service_role with BYPASSRLS';
  END IF;
END;
$$;

CREATE TABLE "DiscordLinkChallenge" (
  "id" TEXT PRIMARY KEY,
  "tokenDigest" VARCHAR(64) NOT NULL UNIQUE,
  "discordUserId" TEXT NOT NULL,
  "correlationId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "consumedByPlayerId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DiscordLinkChallenge_tokenDigest_check"
    CHECK ("tokenDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "DiscordLinkChallenge_ttl_check"
    CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '10 minutes'),
  CONSTRAINT "DiscordLinkChallenge_consumption_check"
    CHECK (("consumedAt" IS NULL) = ("consumedByPlayerId" IS NULL)),
  CONSTRAINT "DiscordLinkChallenge_consumedByPlayerId_fkey"
    FOREIGN KEY ("consumedByPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "DiscordLinkChallenge_discordUserId_consumedAt_idx"
  ON "DiscordLinkChallenge" ("discordUserId", "consumedAt");
CREATE INDEX "DiscordLinkChallenge_expiresAt_consumedAt_idx"
  ON "DiscordLinkChallenge" ("expiresAt", "consumedAt");
CREATE INDEX "DiscordLinkChallenge_consumedByPlayerId_consumedAt_idx"
  ON "DiscordLinkChallenge" ("consumedByPlayerId", "consumedAt");

ALTER TABLE "DiscordLinkChallenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscordLinkChallenge" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "DiscordLinkChallenge" FROM PUBLIC;
REVOKE ALL ON TABLE "DiscordLinkChallenge" FROM anon;
REVOKE ALL ON TABLE "DiscordLinkChallenge" FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "DiscordLinkChallenge" TO service_role;

CREATE FUNCTION d04_write_discord_link_audit(
  audit_id TEXT,
  player_id TEXT,
  discord_user_id TEXT,
  stored_correlation_id TEXT,
  result_code TEXT,
  occurred_at TIMESTAMP(3)
) RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO "AuditLog" (
    "id", "actorPlayerId", "actorType", "action", "targetType", "targetId",
    "metadata", "correlationId", "createdAt"
  ) VALUES (
    audit_id, player_id, 'clerk_user', 'discord_identity_link', 'IdentityLink',
    discord_user_id, jsonb_build_object('provider', 'discord', 'result', result_code),
    stored_correlation_id, occurred_at
  )
$$;

CREATE FUNCTION d04_consume_discord_link_challenge(
  token_digest TEXT,
  discord_user_id TEXT,
  player_id TEXT,
  clerk_user_id TEXT,
  confirmed_at TIMESTAMP(3),
  reauthenticated_at TIMESTAMP(3),
  identity_link_id TEXT,
  audit_id TEXT
) RETURNS TABLE (status TEXT, "correlationId" TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  challenge "DiscordLinkChallenge"%ROWTYPE;
  link_by_discord "IdentityLink"%ROWTYPE;
  link_by_clerk "IdentityLink"%ROWTYPE;
  result_code TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Player"
    WHERE "id" = player_id AND "clerkUserId" = clerk_user_id
  ) THEN
    RETURN QUERY SELECT 'challenge_invalid'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO challenge
  FROM "DiscordLinkChallenge"
  WHERE "tokenDigest" = token_digest AND "discordUserId" = discord_user_id
  FOR UPDATE;

  IF NOT FOUND OR challenge."consumedAt" IS NOT NULL OR challenge."expiresAt" <= confirmed_at THEN
    RETURN QUERY SELECT 'challenge_invalid'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO link_by_discord
  FROM "IdentityLink"
  WHERE "provider" = 'discord' AND "providerUserId" = discord_user_id;

  SELECT * INTO link_by_clerk
  FROM "IdentityLink"
  WHERE "provider" = 'discord' AND "clerkUserId" = clerk_user_id;

  IF (link_by_discord."id" IS NOT NULL AND link_by_discord."playerId" <> player_id)
     OR (link_by_clerk."id" IS NOT NULL AND link_by_clerk."providerUserId" <> discord_user_id) THEN
    result_code := 'recovery_required';
  ELSIF COALESCE(link_by_discord."id", link_by_clerk."id") IS NOT NULL THEN
    IF COALESCE(link_by_discord."revokedAt", link_by_clerk."revokedAt") IS NULL THEN
      result_code := 'already_linked';
    ELSIF reauthenticated_at IS NULL
       OR reauthenticated_at > confirmed_at
       OR reauthenticated_at < confirmed_at - INTERVAL '5 minutes' THEN
      PERFORM d04_write_discord_link_audit(
        audit_id, player_id, discord_user_id, challenge."correlationId",
        'recovery_required', confirmed_at
      );
      RETURN QUERY SELECT 'recovery_required'::TEXT, challenge."correlationId";
      RETURN;
    ELSE
      UPDATE "IdentityLink"
      SET "verifiedAt" = confirmed_at, "revokedAt" = NULL
      WHERE "id" = COALESCE(link_by_discord."id", link_by_clerk."id");
      result_code := 'linked';
    END IF;
  ELSE
    BEGIN
      INSERT INTO "IdentityLink" (
        "id", "playerId", "clerkUserId", "provider", "providerUserId", "verifiedAt", "createdAt"
      ) VALUES (
        identity_link_id, player_id, clerk_user_id, 'discord', discord_user_id,
        confirmed_at, confirmed_at
      );
      result_code := 'linked';
    EXCEPTION WHEN unique_violation THEN
      result_code := 'recovery_required';
    END;
  END IF;

  UPDATE "DiscordLinkChallenge"
  SET "consumedAt" = confirmed_at, "consumedByPlayerId" = player_id
  WHERE "id" = challenge."id";

  PERFORM d04_write_discord_link_audit(
    audit_id, player_id, discord_user_id, challenge."correlationId", result_code, confirmed_at
  );
  RETURN QUERY SELECT result_code, challenge."correlationId";
END;
$$;

CREATE FUNCTION d04_compensate_discord_link_unique_race(
  token_digest TEXT,
  discord_user_id TEXT,
  player_id TEXT,
  occurred_at TIMESTAMP(3),
  audit_id TEXT
) RETURNS TABLE (status TEXT, "correlationId" TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  challenge "DiscordLinkChallenge"%ROWTYPE;
BEGIN
  SELECT * INTO challenge
  FROM "DiscordLinkChallenge"
  WHERE "tokenDigest" = token_digest AND "discordUserId" = discord_user_id
  FOR UPDATE;

  IF NOT FOUND OR challenge."consumedAt" IS NOT NULL OR challenge."expiresAt" <= occurred_at THEN
    RETURN QUERY SELECT 'challenge_invalid'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  UPDATE "DiscordLinkChallenge"
  SET "consumedAt" = occurred_at, "consumedByPlayerId" = player_id
  WHERE "id" = challenge."id";
  PERFORM d04_write_discord_link_audit(
    audit_id, player_id, discord_user_id, challenge."correlationId",
    'recovery_required', occurred_at
  );
  RETURN QUERY SELECT 'recovery_required'::TEXT, challenge."correlationId";
END;
$$;

REVOKE ALL ON FUNCTION d04_write_discord_link_audit(TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMP) FROM PUBLIC;
REVOKE ALL ON FUNCTION d04_consume_discord_link_challenge(TEXT, TEXT, TEXT, TEXT, TIMESTAMP, TIMESTAMP, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION d04_compensate_discord_link_unique_race(TEXT, TEXT, TEXT, TIMESTAMP, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION d04_consume_discord_link_challenge(TEXT, TEXT, TEXT, TEXT, TIMESTAMP, TIMESTAMP, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION d04_compensate_discord_link_unique_race(TEXT, TEXT, TEXT, TIMESTAMP, TEXT) TO service_role;
