-- Real WhatsApp tags on a queued post (2026-11-03).
-- A "group" or "admin-group" BotJob can now tag people: the phones (E.164
-- without the +) are stored here, the text carries each one inline as
-- "@<phone>", and the Pi sends the post with sendTextWithMentions, so the
-- tagged person gets a notification and the tag is clickable. Empty means a
-- plain post, exactly as before.
--
-- APPLY THIS BEFORE THE CODE IS DEPLOYED. Prisma reads every BotJob column
-- (the scheduler's findMany has no select), so code that knows "mentions"
-- running against a database without it fails every BotJob read and write.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261103180000_botjob_mentions/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One new column on "BotJob" with a constant default,
-- which Postgres records in the catalogue without rewriting any row, so it
-- takes only a brief lock.
--   * "BotJob"."mentions"  TEXT[] DEFAULT ARRAY[]::TEXT[]
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; a second run changes nothing.
-- ONE transaction; there is no session-level SET in this file.
--
-- Verify after applying (expect one row):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'BotJob' AND column_name = 'mentions';
--
-- Rolling back (only after the code that reads it is rolled back):
--   ALTER TABLE "BotJob" DROP COLUMN IF EXISTS "mentions";

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "BotJob" ADD COLUMN IF NOT EXISTS "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[];

COMMIT;
