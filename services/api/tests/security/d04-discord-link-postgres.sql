\set ON_ERROR_STOP on

CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;

\ir ../../prisma/migrations/20260814000100_d01_p0_persistence/migration.sql
\ir ../../prisma/migrations/20260814000200_d04_discord_link_challenge/migration.sql

SET ROLE service_role;
INSERT INTO "Player" ("id", "clerkUserId", "displayName") VALUES
  ('player-a', 'clerk-a', 'Player A'),
  ('player-b', 'clerk-b', 'Player B');

INSERT INTO "DiscordLinkChallenge" (
  "id", "tokenDigest", "discordUserId", "correlationId", "createdAt", "expiresAt"
) VALUES (
  'challenge-a', repeat('a', 64), 'discord-a', 'stored-correlation-a',
  TIMESTAMP '2030-01-01 00:00:00', TIMESTAMP '2030-01-01 00:10:00'
);

DO $$
DECLARE
  result_code TEXT;
  result_correlation TEXT;
  link_count INTEGER;
  audit_count INTEGER;
BEGIN
  SELECT status, "correlationId" INTO result_code, result_correlation
  FROM d04_consume_discord_link_challenge(
    repeat('a', 64), 'discord-a', 'player-a', 'clerk-a',
    TIMESTAMP '2030-01-01 00:01:00', NULL, 'link-a', 'audit-a'
  );
  IF result_code <> 'linked' OR result_correlation <> 'stored-correlation-a' THEN
    RAISE EXCEPTION 'atomic link returned unexpected result %, %', result_code, result_correlation;
  END IF;
  SELECT count(*) INTO link_count FROM "IdentityLink"
  WHERE "id" = 'link-a' AND "playerId" = 'player-a' AND "providerUserId" = 'discord-a';
  SELECT count(*) INTO audit_count FROM "AuditLog"
  WHERE "id" = 'audit-a' AND "correlationId" = 'stored-correlation-a'
    AND "metadata"->>'result' = 'linked';
  IF link_count <> 1 OR audit_count <> 1 THEN
    RAISE EXCEPTION 'atomic link or stored-correlation audit missing';
  END IF;

  SELECT status INTO result_code
  FROM d04_consume_discord_link_challenge(
    repeat('a', 64), 'discord-a', 'player-a', 'clerk-a',
    TIMESTAMP '2030-01-01 00:02:00', NULL, 'unused-link', 'unused-audit'
  );
  IF result_code <> 'challenge_invalid' THEN
    RAISE EXCEPTION 'consumed challenge was reusable: %', result_code;
  END IF;
END;
$$;

UPDATE "IdentityLink" SET "revokedAt" = TIMESTAMP '2030-01-01 00:03:00' WHERE "id" = 'link-a';
INSERT INTO "DiscordLinkChallenge" (
  "id", "tokenDigest", "discordUserId", "correlationId", "createdAt", "expiresAt"
) VALUES (
  'challenge-relink', repeat('b', 64), 'discord-a', 'stored-relink-correlation',
  TIMESTAMP '2030-01-01 00:03:00', TIMESTAMP '2030-01-01 00:09:00'
);

DO $$
DECLARE
  result_code TEXT;
  consumed_at TIMESTAMP;
  revoked_at TIMESTAMPTZ;
BEGIN
  SELECT status INTO result_code
  FROM d04_consume_discord_link_challenge(
    repeat('b', 64), 'discord-a', 'player-a', 'clerk-a',
    TIMESTAMP '2030-01-01 00:04:00', NULL, 'unused-link', 'audit-relink-denied'
  );
  SELECT "consumedAt" INTO consumed_at FROM "DiscordLinkChallenge" WHERE "id" = 'challenge-relink';
  SELECT "revokedAt" INTO revoked_at FROM "IdentityLink" WHERE "id" = 'link-a';
  IF result_code <> 'recovery_required' OR consumed_at IS NOT NULL OR revoked_at IS NULL THEN
    RAISE EXCEPTION 'revoked link reactivated without reauthentication';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "AuditLog"
    WHERE "id" = 'audit-relink-denied'
      AND "correlationId" = 'stored-relink-correlation'
      AND "metadata"->>'result' = 'recovery_required'
  ) THEN
    RAISE EXCEPTION 'denied relink recovery audit missing';
  END IF;

  SELECT status INTO result_code
  FROM d04_consume_discord_link_challenge(
    repeat('b', 64), 'discord-a', 'player-a', 'clerk-a',
    TIMESTAMP '2030-01-01 00:05:00', TIMESTAMP '2030-01-01 00:04:30',
    'unused-link', 'audit-relink-success'
  );
  IF result_code <> 'linked' OR NOT EXISTS (
    SELECT 1 FROM "IdentityLink" WHERE "id" = 'link-a' AND "revokedAt" IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM "DiscordLinkChallenge"
    WHERE "id" = 'challenge-relink' AND "consumedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'recent reauthentication did not atomically relink';
  END IF;
END;
$$;

INSERT INTO "IdentityLink" (
  "id", "playerId", "clerkUserId", "provider", "providerUserId", "verifiedAt"
) VALUES (
  'link-b', 'player-b', 'clerk-b', 'discord', 'discord-b', TIMESTAMP '2030-01-01 00:00:00'
);
INSERT INTO "DiscordLinkChallenge" (
  "id", "tokenDigest", "discordUserId", "correlationId", "createdAt", "expiresAt"
) VALUES (
  'challenge-conflict', repeat('c', 64), 'discord-b', 'stored-conflict-correlation',
  TIMESTAMP '2030-01-01 00:00:00', TIMESTAMP '2030-01-01 00:10:00'
);

DO $$
DECLARE result_code TEXT;
BEGIN
  SELECT status INTO result_code
  FROM d04_consume_discord_link_challenge(
    repeat('c', 64), 'discord-b', 'player-a', 'clerk-a',
    TIMESTAMP '2030-01-01 00:01:00', NULL, 'race-link', 'audit-conflict'
  );
  IF result_code <> 'recovery_required' OR NOT EXISTS (
    SELECT 1 FROM "DiscordLinkChallenge"
    WHERE "id" = 'challenge-conflict' AND "consumedAt" IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM "AuditLog"
    WHERE "id" = 'audit-conflict' AND "correlationId" = 'stored-conflict-correlation'
  ) THEN
    RAISE EXCEPTION 'ownership conflict was not consumed and audited atomically';
  END IF;

  BEGIN
    INSERT INTO "DiscordLinkChallenge" (
      "id", "tokenDigest", "discordUserId", "correlationId", "createdAt", "expiresAt"
    ) VALUES (
      'bad-ttl', repeat('d', 64), 'discord-d', 'correlation-d',
      TIMESTAMP '2030-01-01 00:00:00', TIMESTAMP '2030-01-01 00:10:01'
    );
    RAISE EXCEPTION 'challenge TTL over ten minutes unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;
RESET ROLE;

SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM "DiscordLinkChallenge";
    RAISE EXCEPTION 'authenticated client unexpectedly read durable challenges';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
RESET ROLE;

\ir ../../prisma/migrations/20260814000200_d04_discord_link_challenge/rollback.sql
DO $$
BEGIN
  IF to_regclass('public."DiscordLinkChallenge"') IS NOT NULL
     OR to_regprocedure('public.d04_consume_discord_link_challenge(text,text,text,text,timestamp without time zone,timestamp without time zone,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'D04 rollback left durable challenge artifacts behind';
  END IF;
END;
$$;
\ir ../../prisma/migrations/20260814000100_d01_p0_persistence/rollback.sql
