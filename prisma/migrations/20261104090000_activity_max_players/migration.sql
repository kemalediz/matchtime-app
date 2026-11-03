-- The most players a weekly game can be played with (2026-11-03).
-- The Vets play 7-a-side with 14 places, but 6, 7 or 8 a side depending on
-- numbers. "Activity"."maxPlayers" is the organiser's own maximum for this
-- game: with "minPlayers" 12 and "maxPlayers" 16 an organiser may switch any
-- one match to 6, 7 or 8 a side (that match's own "Match"."maxPlayers"), and
-- MatchTime suggests going up a size when two players are waiting on the
-- bench. NULL (every game today) keeps today's behaviour exactly: the game
-- is only ever its own format.
--
-- APPLY THIS BEFORE THE CODE IS DEPLOYED. Prisma reads every Activity
-- column wherever an activity is loaded without a select, so code that
-- knows "maxPlayers" running against a database without it fails those
-- reads. It needs 20261103210000_activity_min_players applied first only
-- in the sense that the code reads both; the two files are independent.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261104090000_activity_max_players/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One new nullable column on "Activity" with no
-- default, which Postgres records in the catalogue without rewriting any
-- row, so it takes only a brief lock.
--   * "Activity"."maxPlayers"  INTEGER NULL
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; a second run changes nothing.
-- ONE transaction; there is no session-level SET in this file.
--
-- Verify after applying (expect one row):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'Activity' AND column_name = 'maxPlayers';
--
-- Rolling back (only after the code that reads it is rolled back):
--   ALTER TABLE "Activity" DROP COLUMN IF EXISTS "maxPlayers";

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Activity" ADD COLUMN IF NOT EXISTS "maxPlayers" INTEGER;

COMMIT;
