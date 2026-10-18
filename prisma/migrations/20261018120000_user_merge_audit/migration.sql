-- Cross-club phone link audit (2026-10-18, FNF incident).
-- See src/lib/cross-club-link.ts and src/lib/cross-club-link-rules.ts.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- UserMerge column on queries without a `select` (submitRatings and
-- submitMoMVote read the tombstones), and the link action writes the new
-- columns, so code that knows them fails against a database without them.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261018120000_user_merge_audit/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. Two NULLABLE columns on "UserMerge", with no default:
--   "actorUserId" TEXT  who asked for the merge, when a person did;
--   "reason"      TEXT  "cross-club-phone-link" for a cross-club link.
-- Adding a nullable column with no default is a catalogue change only
-- (no table rewrite). Every existing row reads NULL for both, which is
-- what it was: a merge with no recorded actor. No index: the columns are
-- read only when somebody audits a merge, by its "oldUserId".
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS is a no-op on a second run. ONE
-- transaction. lock_timeout makes a busy table fail fast; if it fails on
-- the lock nothing was changed and it can simply be run again. There is
-- no session-level SET in this file.
--
-- Verify after applying (expect 2 rows):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'UserMerge' AND column_name IN ('actorUserId', 'reason');
--
-- Rolling back (after the code that writes them is no longer deployed):
--   ALTER TABLE "UserMerge" DROP COLUMN IF EXISTS "actorUserId", DROP COLUMN IF EXISTS "reason";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. Apply this file on production.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "UserMerge"
  ADD COLUMN IF NOT EXISTS "actorUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "reason" TEXT;

COMMIT;
