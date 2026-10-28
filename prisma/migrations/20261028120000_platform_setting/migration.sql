-- The platform owner's switches, as database rows (2026-10-28). First and
-- only row so far: "pool-offers", the MatchTime player pool for every club
-- (the kill switch). Decisions P.1 to P.3 in
-- MDs/local-player-pool-decisions-log.md.
--
-- Until now the pool's master switch was the Vercel environment variable
-- POOL_OFFERS_ENABLED (ON in production since 25 Oct, decision K.1), which
-- needs a redeploy to change. Kemal (28 Oct): the owner page has one switch
-- for the whole platform. The code reads this row on every request and
-- every Pi poll; POOL_OFFERS_ENABLED stays only as an emergency override
-- that can force the pool OFF.
--
-- APPLY IT BEFORE THE CODE IS DEPLOYED. The new code reads the pool as
-- CLOSED when the row is missing (and logs the read failure when the table
-- is missing), so deploying first would close every club's pool until this
-- runs:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261028120000_platform_setting/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One new table, one new row. No existing row or column
-- is touched. The code deployed today does not know the table.
--   * "PlatformSetting" (key TEXT primary key, on BOOLEAN default false,
--     updatedById TEXT NULL, updatedAt TIMESTAMP(3)).
--   * The row ('pool-offers', on = true): the pool stays ON, as the
--     environment variable has it in production today.
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS, and the row is inserted only if
-- absent (a second run never turns a switch the owner turned off back on).
-- ONE transaction; there is no session-level SET in this file.
--
-- Verify after applying (expect one row, on = t):
--   SELECT key, "on", "updatedAt" FROM "PlatformSetting";
--
-- Rolling back (after the code that reads it is no longer deployed):
--   DROP TABLE IF EXISTS "PlatformSetting";

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "PlatformSetting" (
  "key"         TEXT NOT NULL,
  "on"          BOOLEAN NOT NULL DEFAULT false,
  "updatedById" TEXT,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

INSERT INTO "PlatformSetting" ("key", "on", "updatedById", "updatedAt")
VALUES ('pool-offers', true, NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

COMMIT;
