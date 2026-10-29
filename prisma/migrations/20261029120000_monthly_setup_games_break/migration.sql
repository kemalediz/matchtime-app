-- Monthly squad, Vets MNF fixes (2026-10-29): starting next month from a
-- pasted list, "4 only" regulars, and a season break.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261029120000_monthly_setup_games_break/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. Nothing is dropped, renamed or rewritten.
--   * "SquadMonthMember"."gamesCommitted" INTEGER NULL: a regular who
--     commits to fewer games than the month has ("4 only"). NULL on every
--     existing row, which means every game, exactly today's behaviour.
--     CHECK: NULL or 1 to 10 (MAX_GAMES_IN_MONTH).
--   * "Organisation"."seasonBreakMonths" TEXT[] NOT NULL DEFAULT '{}': the
--     months ("YYYY-MM") a club plays no games. Empty on every existing
--     row, so nothing changes until an organiser ticks a month off.
--     CHECK: every entry is "YYYY-MM".
--   * "AdminSquadProposal"."monthStart" TEXT NULL and "monthSeed" JSONB
--     NULL: a month's list pasted in the admin group, waiting for YES.
--     NULL on every existing row (a weekly squad list, as today).
-- Adding a nullable column, or one with a constant default, is a
-- metadata-only change in Postgres 11+: no table rewrite, a brief lock.
-- The CHECKs cannot fail on existing rows (all NULL or empty).
--
-- Verify after applying (expect 0, 0, 0):
--   SELECT count(*) FROM "SquadMonthMember" WHERE "gamesCommitted" IS NOT NULL;
--   SELECT count(*) FROM "Organisation" WHERE cardinality("seasonBreakMonths") > 0;
--   SELECT count(*) FROM "AdminSquadProposal" WHERE "monthSeed" IS NOT NULL;
--
-- Rolling back:
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   ALTER TABLE "SquadMonthMember" DROP COLUMN "gamesCommitted";
--   ALTER TABLE "Organisation" DROP COLUMN "seasonBreakMonths";
--   ALTER TABLE "AdminSquadProposal" DROP COLUMN "monthStart", DROP COLUMN "monthSeed";
--   COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "SquadMonthMember" ADD COLUMN "gamesCommitted" INTEGER;
ALTER TABLE "SquadMonthMember" ADD CONSTRAINT "SquadMonthMember_gamesCommitted_check"
  CHECK ("gamesCommitted" IS NULL OR "gamesCommitted" BETWEEN 1 AND 10);

ALTER TABLE "Organisation" ADD COLUMN "seasonBreakMonths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_seasonBreakMonths_check"
  CHECK (array_to_string("seasonBreakMonths", ',') ~ '^([0-9]{4}-(0[1-9]|1[0-2])(,|$))*$');

ALTER TABLE "AdminSquadProposal" ADD COLUMN "monthStart" TEXT;
ALTER TABLE "AdminSquadProposal" ADD COLUMN "monthSeed" JSONB;

COMMIT;
