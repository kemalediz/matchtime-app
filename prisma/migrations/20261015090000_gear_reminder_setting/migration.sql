-- The match-day gear reminder becomes a club setting (2026-10-15).
-- See `OrgFeatures.gearReminder` (src/lib/org-features.ts) and section 5a
-- of src/lib/bot-scheduler.ts.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- Organisation column on queries without a `select`, so code that knows
-- the column fails against a database that does not have it yet.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261015090000_gear_reminder_setting/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   1. One NOT NULL column on "Organisation", "featureGearReminder", added
--      with the constant default TRUE. Postgres 11+ fills every existing
--      row with it as the column is added (no table rewrite), so Sutton FC
--      (cmnnwhdx30000zfr85q18lyy9) and every other existing club keeps
--      the gear reminder: today's behaviour.
--   2. The column default is then changed to FALSE, so a club created
--      from now on starts with the reminder off. Changing a default
--      touches no existing row.
--
-- It drops, renames and rewrites nothing.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS is a no-op on a second run, so a
-- re-run never turns the setting back on for a club created in between
-- (those keep FALSE); the SET DEFAULT is the same each time. ONE
-- transaction: it applies whole or not at all. lock_timeout makes a busy
-- table fail fast instead of queueing every query behind the ALTER; if it
-- fails on the lock nothing was changed and it can simply be run again.
-- There is no session-level SET in this file.
--
-- Verify after applying (expect: featureGearReminder | boolean | NO | false; then 0):
--   SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
--    WHERE table_name = 'Organisation' AND column_name = 'featureGearReminder';
--   SELECT count(*) FROM "Organisation" WHERE "featureGearReminder" = false;
--
-- Rolling back (after the code that reads it is no longer deployed):
--   ALTER TABLE "Organisation" DROP COLUMN IF EXISTS "featureGearReminder";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. `db push` alone would add the
-- column with default FALSE for EVERY row, turning the reminder off for
-- existing clubs: apply this file, not `db push`, on production.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Organisation"
  ADD COLUMN IF NOT EXISTS "featureGearReminder" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Organisation" ALTER COLUMN "featureGearReminder" SET DEFAULT false;

COMMIT;
