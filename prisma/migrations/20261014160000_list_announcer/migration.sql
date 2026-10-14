-- Who announces the list and teams (2026-10-14).
-- See src/lib/list-announcer.ts.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- Organisation column on queries without a `select` (the due-posts poll
-- among them), so code that knows the column fails against a database
-- that does not have it yet.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261014160000_list_announcer/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   * One NOT NULL column on "Organisation", "listAnnouncer", with the
--     constant default 'matchtime'. Postgres fills every existing row with
--     the default as the column is added (no table rewrite on PG 11+), so
--     Sutton FC (cmnnwhdx30000zfr85q18lyy9) and every other club keeps
--     MatchTime posting the list and the teams: today's behaviour.
--   * One CHECK constraint on that column.
--
-- It drops, renames and rewrites nothing.
--
-- IDEMPOTENT: the column is ADD COLUMN IF NOT EXISTS and the constraint is
-- dropped if present before it is added, so it can be run again safely.
-- It is ONE transaction: it applies whole or not at all. lock_timeout
-- makes a busy table fail the migration fast instead of queueing every
-- query behind the ALTER; if it fails on the lock, nothing was changed and
-- it can simply be run again. There is no session-level SET in this file.
--
-- Verify after applying (expect one row: listAnnouncer | text | NO; then 0):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'Organisation' AND column_name = 'listAnnouncer';
--   SELECT count(*) FROM "Organisation" WHERE "listAnnouncer" <> 'matchtime';
--
-- Rolling back (after the code that reads it is no longer deployed):
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_listAnnouncer_check";
--   ALTER TABLE "Organisation" DROP COLUMN IF EXISTS "listAnnouncer";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. `db push` would add the same
-- column but never the CHECK constraint.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Organisation"
  ADD COLUMN IF NOT EXISTS "listAnnouncer" TEXT NOT NULL DEFAULT 'matchtime';

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_listAnnouncer_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_listAnnouncer_check"
  CHECK ("listAnnouncer" IN ('matchtime', 'organisers'));

COMMIT;
