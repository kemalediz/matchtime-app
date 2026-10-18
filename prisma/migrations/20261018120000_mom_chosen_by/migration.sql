-- Who chooses Man of the Match becomes a club setting (2026-10-18).
-- See `OrgFeatures.momChosenBy` (src/lib/mom-chooser.ts) and
-- src/lib/mom-pick.ts.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- Organisation column on queries without a `select`, so code that knows
-- the column fails against a database that does not have it yet.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261018120000_mom_chosen_by/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   1. One NOT NULL column on "Organisation", "momChosenBy", added with
--      the constant default 'players'. Postgres 11+ fills every existing
--      row with it as the column is added (no table rewrite), so every
--      club keeps the players' vote: today's behaviour.
--   2. A CHECK constraint naming the two values the code knows.
--
-- It drops, renames and rewrites nothing.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS is a no-op on a second run, and the
-- constraint is dropped and re-added. ONE transaction: it applies whole or
-- not at all. lock_timeout makes a busy table fail fast instead of queueing
-- every query behind the ALTER; if it fails on the lock nothing was changed
-- and it can simply be run again. There is no session-level SET in this file.
--
-- Verify after applying (expect one row: momChosenBy | text | NO; then 0):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'Organisation' AND column_name = 'momChosenBy';
--   SELECT count(*) FROM "Organisation" WHERE "momChosenBy" <> 'players';
--
-- Rolling back (after the code that reads it is no longer deployed):
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_momChosenBy_check";
--   ALTER TABLE "Organisation" DROP COLUMN IF EXISTS "momChosenBy";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. `db push` would add the same
-- column but never the CHECK constraint.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Organisation"
  ADD COLUMN IF NOT EXISTS "momChosenBy" TEXT NOT NULL DEFAULT 'players';

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_momChosenBy_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_momChosenBy_check"
  CHECK ("momChosenBy" IN ('players', 'organisers'));

COMMIT;
