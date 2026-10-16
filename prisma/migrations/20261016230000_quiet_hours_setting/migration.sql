-- Quiet hours become a club setting (Kemal, 2026-10-16).
-- See `quietHoursOf` in src/lib/message-hours.ts and the "Quiet hours" row
-- on /admin/settings.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- Organisation column on queries without a `select`, so code that knows
-- the columns fails against a database that does not have them yet.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261016230000_quiet_hours_setting/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. Three NOT NULL columns on "Organisation", each with a
-- constant default, which Postgres 11+ fills into every existing row as
-- the column is added (no table rewrite):
--   "quietHoursEnabled" BOOLEAN DEFAULT true
--   "quietHoursFrom"    TEXT    DEFAULT '23:00'
--   "quietHoursTo"      TEXT    DEFAULT '09:00'
-- So every existing club (Sutton FC cmnnwhdx30000zfr85q18lyy9, FNF, all of
-- them) and every new club keeps today's 09:00 to 22:59 London message
-- hours. Nothing changes for anyone until an organiser or the manager
-- changes the setting.
--
-- It drops, renames and rewrites nothing.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS is a no-op on a second run, so a
-- re-run never resets a club's chosen quiet hours. ONE transaction: it
-- applies whole or not at all. lock_timeout makes a busy table fail fast
-- instead of queueing every query behind the ALTER; if it fails on the
-- lock nothing was changed and it can simply be run again. There is no
-- session-level SET in this file.
--
-- Verify after applying (expect three rows: boolean NO true, text NO
-- '23:00'::text, text NO '09:00'::text; then 0):
--   SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
--    WHERE table_name = 'Organisation' AND column_name LIKE 'quietHours%' ORDER BY column_name;
--   SELECT count(*) FROM "Organisation"
--    WHERE NOT ("quietHoursEnabled" AND "quietHoursFrom" = '23:00' AND "quietHoursTo" = '09:00');
--
-- Then set the two clubs (dry run first, then --apply):
--   npx tsx scripts/set-quiet-hours.ts <FNF org id or slug> off --apply
--   npx tsx scripts/set-quiet-hours.ts cmnnwhdx30000zfr85q18lyy9 23:00 09:00 --apply
--
-- Rolling back (after the code that reads them is no longer deployed):
--   ALTER TABLE "Organisation" DROP COLUMN IF EXISTS "quietHoursEnabled",
--     DROP COLUMN IF EXISTS "quietHoursFrom", DROP COLUMN IF EXISTS "quietHoursTo";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. `db push` would add the same
-- columns with the same defaults, but apply this file on production.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Organisation"
  ADD COLUMN IF NOT EXISTS "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "quietHoursFrom" TEXT NOT NULL DEFAULT '23:00',
  ADD COLUMN IF NOT EXISTS "quietHoursTo" TEXT NOT NULL DEFAULT '09:00';

COMMIT;
