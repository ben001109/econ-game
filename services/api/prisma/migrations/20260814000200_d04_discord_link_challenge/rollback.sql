REVOKE ALL ON FUNCTION d04_compensate_discord_link_unique_race(TEXT, TEXT, TEXT, TIMESTAMP, TEXT) FROM service_role;
REVOKE ALL ON FUNCTION d04_consume_discord_link_challenge(TEXT, TEXT, TEXT, TEXT, TIMESTAMP, TIMESTAMP, TEXT, TEXT) FROM service_role;
DROP FUNCTION IF EXISTS d04_compensate_discord_link_unique_race(TEXT, TEXT, TEXT, TIMESTAMP, TEXT);
DROP FUNCTION IF EXISTS d04_consume_discord_link_challenge(TEXT, TEXT, TEXT, TEXT, TIMESTAMP, TIMESTAMP, TEXT, TEXT);
DROP FUNCTION IF EXISTS d04_write_discord_link_audit(TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMP);
DROP TABLE IF EXISTS "DiscordLinkChallenge";
