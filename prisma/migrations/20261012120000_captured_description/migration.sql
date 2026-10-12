-- The WhatsApp group description, captured at the add (2026-10-12).
-- See src/lib/group-description.ts and src/lib/captured-chat.ts.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive: ONE nullable column.
--   * "ClubConnect"."capturedDescription" TEXT NULL: the description of the
--     group MatchTime was added to, with bank details and phone numbers
--     masked out before it is written. NULL on every existing row. Stored
--     only for a self-join club's connect request, beside "capturedHistory",
--     and set back to NULL wherever that is (MatchTime removed, club
--     rejected, learned setup done, 7 days old). Nothing reads it yet.
--
-- No default, no NOT NULL, no index, no constraint: adding it is a
-- catalogue change only (no table rewrite, no scan). It does NOT drop,
-- rename or rewrite anything. No approved club (Sutton FC included) has a
-- row that this code ever writes the column on.
--
-- IDEMPOTENT: `ADD COLUMN IF NOT EXISTS`, so applying it twice is a no-op
-- the second time (Postgres prints a NOTICE and carries on).
--
-- APPLY IT BEFORE THE CODE IS DEPLOYED. The server's Prisma client names
-- every column of "ClubConnect" in any query that has no explicit `select`,
-- so new code against a database without the column fails those queries.
-- The old code is unaffected by the extra column.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261012120000_captured_description/migration.sql
--
-- Verify after applying (expect one row: capturedDescription | text | YES;
-- then 0):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'ClubConnect' AND column_name = 'capturedDescription';
--   SELECT count(*) FROM "ClubConnect" WHERE "capturedDescription" IS NOT NULL;
--
-- Rolling back (after the code that writes it is no longer deployed):
--   ALTER TABLE "ClubConnect" DROP COLUMN IF EXISTS "capturedDescription";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. Apply THIS file (it carries its
-- own BEGIN/COMMIT). lock_timeout makes a busy table fail the migration
-- fast instead of queueing every query behind the ALTER; if it does fail
-- on the lock, nothing was changed and it can simply be run again.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "ClubConnect" ADD COLUMN IF NOT EXISTS "capturedDescription" TEXT;

COMMIT;
