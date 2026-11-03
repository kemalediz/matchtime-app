-- The fewest players a weekly game is played with (2026-11-03).
-- The Vets play 7-a-side with 14 places and happily play one down (6 v 7),
-- but with 13 confirmed the day before MatchTime told the organiser the
-- match was "in trouble" and offered to cancel it. "Activity"."minPlayers"
-- is the organiser's own minimum for this game. NULL (every game today)
-- keeps today's behaviour exactly: the minimum is two full sides of the
-- club's smallest format of that sport. The places stay the format's
-- (Match.maxPlayers); this only decides when MatchTime calls the numbers
-- short.
--
-- APPLY THIS BEFORE THE CODE IS DEPLOYED. Prisma reads every Activity
-- column wherever an activity is loaded without a select, so code that
-- knows "minPlayers" running against a database without it fails those
-- reads.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261103210000_activity_min_players/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One new nullable column on "Activity" with no
-- default, which Postgres records in the catalogue without rewriting any
-- row, so it takes only a brief lock.
--   * "Activity"."minPlayers"  INTEGER NULL
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; a second run changes nothing.
-- ONE transaction; there is no session-level SET in this file.
--
-- Verify after applying (expect one row):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'Activity' AND column_name = 'minPlayers';
--
-- Rolling back (only after the code that reads it is rolled back):
--   ALTER TABLE "Activity" DROP COLUMN IF EXISTS "minPlayers";

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Activity" ADD COLUMN IF NOT EXISTS "minPlayers" INTEGER;

COMMIT;
