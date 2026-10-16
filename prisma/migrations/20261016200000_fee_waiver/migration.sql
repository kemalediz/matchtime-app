-- Free places (2026-10-16): a player's fee for one match can be waived.
-- See src/lib/fee-waiver.ts and src/lib/fee-waiver-rules.ts.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- Attendance column on queries without a `select`, so code that knows the
-- new columns fails against a database that does not have them yet.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261016200000_fee_waiver/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. Three NULLABLE columns on "Attendance", with no
-- default: "feeWaivedAt" TIMESTAMP(3), "feeWaivedReason" TEXT,
-- "feeWaivedByUserId" TEXT. Adding a nullable column with no default is a
-- catalogue change only (no table rewrite). NULL on every existing row:
-- nobody has a free place, so every club, Sutton FC
-- (cmnnwhdx30000zfr85q18lyy9) and FNF included, behaves exactly as today.
-- The FNF stopgap rows (#299, marked "received" on /collect) stay paid.
--
-- It drops, renames and rewrites nothing. No index: every reader already
-- loads the match's attendances by "matchId".
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS is a no-op on a second run. ONE
-- transaction: it applies whole or not at all. lock_timeout makes a busy
-- table fail fast instead of queueing every query behind the ALTER; if it
-- fails on the lock nothing was changed and it can simply be run again.
-- There is no session-level SET in this file.
--
-- Verify after applying (expect 3 rows, then 0):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'Attendance' AND column_name LIKE 'feeWaived%';
--   SELECT count(*) FROM "Attendance" WHERE "feeWaivedAt" IS NOT NULL;
--
-- Rolling back (after the code that reads them is no longer deployed):
--   ALTER TABLE "Attendance" DROP COLUMN IF EXISTS "feeWaivedAt",
--     DROP COLUMN IF EXISTS "feeWaivedReason", DROP COLUMN IF EXISTS "feeWaivedByUserId";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. `db push` would add the same
-- three columns, but apply this file on production.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Attendance"
  ADD COLUMN IF NOT EXISTS "feeWaivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "feeWaivedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "feeWaivedByUserId" TEXT;

COMMIT;
