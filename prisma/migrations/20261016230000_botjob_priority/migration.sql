-- Conversational replies before bulk sends (FNF, 2026-10-16).
-- See src/lib/dm-reply-priority.ts and the BotJob block of
-- src/lib/bot-scheduler.ts.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- BotJob column on queries without a `select` (the scheduler's BotJob read
-- is one) and returns every column from `create`, so code that knows the
-- column fails against a database that does not have it yet. Every DM and
-- group post queued as a BotJob would stop.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261016230000_botjob_priority/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One NOT NULL INTEGER column on "BotJob", "priority",
-- with the constant default 0. Postgres 11+ fills every existing row with
-- it as the column is added (no table rewrite). The code deployed today
-- does not know the column and keeps working unchanged; nothing reads it
-- until the new code is deployed AND DM_REPLY_PRIORITY_ENABLED is on.
--
-- It drops, renames and rewrites nothing. No index: the reads that use it
-- are already narrowed by "orgId" and "sentAt" IS NULL on the existing
-- ("orgId", "sentAt") index, a handful of rows.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS is a no-op on a second run. ONE
-- transaction. lock_timeout makes a busy table fail fast instead of
-- queueing every query behind the ALTER; if it fails on the lock nothing
-- was changed and it can simply be run again. There is no session-level
-- SET in this file.
--
-- Verify after applying (expect: priority | integer | NO | 0; then 0):
--   SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
--    WHERE table_name = 'BotJob' AND column_name = 'priority';
--   SELECT count(*) FROM "BotJob" WHERE "priority" <> 0;
--
-- Rolling back (after the code that reads it is no longer deployed):
--   ALTER TABLE "BotJob" DROP COLUMN IF EXISTS "priority";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. `db push` would add the same
-- column, but apply this file on production.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "BotJob"
  ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 0;

COMMIT;
