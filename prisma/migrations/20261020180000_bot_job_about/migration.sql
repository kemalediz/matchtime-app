-- Quoted-reply context, review of #339 (2026-10-20). What a queued DM is
-- about, so a swipe-reply to the money collector's fee question ("Got it:
-- £8 per player ... Reply ✅") resolves to ITS match. See
-- src/lib/reply-context.ts (`resolveQuotedBotMessage`) and
-- src/app/api/whatsapp/dm-reply/route.ts (the collector-fee block).
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- BotJob column on queries without a `select`, and the dm-reply route now
-- writes "matchId" and "aboutKey", so code that knows the columns fails
-- against a database that does not have them yet.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261020180000_bot_job_about/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Additive only: two nullable text columns on "BotJob", "matchId" and
-- "aboutKey". No default, so no table rewrite; no backfill (past jobs keep
-- NULL, and a quote of one resolves exactly as it did before); no index (the
-- columns are only read on a row already found by its primary key, or on
-- the few DMs to one phone). No foreign key, on purpose: a BotJob outlives
-- nothing, and a deleted match must never block or cascade a send queue.
--
-- It drops, renames and rewrites nothing, and touches no other table.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS is a no-op on a second run. ONE
-- transaction. lock_timeout makes a busy table fail fast instead of queueing
-- every query behind the ALTER; if it fails on the lock nothing was changed
-- and it can simply be run again. There is no session-level SET in this file.
--
-- Verify after applying (expect two rows):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'BotJob' AND column_name IN ('matchId', 'aboutKey');

BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "BotJob" ADD COLUMN IF NOT EXISTS "matchId" TEXT;
ALTER TABLE "BotJob" ADD COLUMN IF NOT EXISTS "aboutKey" TEXT;
COMMIT;
