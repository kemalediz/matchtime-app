-- The local player pool, slice L8: a club's pasted WhatsApp group invite
-- link (2026-10-24). Plan: MDs/local-player-pool-approved-spec-2026-10-24.md
-- "Joining the group"; decisions L8.x in MDs/local-player-pool-decisions-log.md.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, AFTER
-- 20261024200000_local_player_pool, and APPLY IT BEFORE THE CODE IS
-- DEPLOYED: the Prisma client selects every Organisation column on queries
-- without a `select`, so code that knows the new columns fails against a
-- database without them.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261025160000_pool_group_invite_link/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. No row changes.
--   * Three NULL columns on "Organisation":
--       "groupInviteLink"        TEXT NULL (https://chat.whatsapp.com/<code>)
--       "groupInviteLinkSetAt"   TIMESTAMP(3) NULL
--       "groupInviteLinkSetById" TEXT NULL (the organiser who pasted it)
--     No default: adding them rewrites nothing. Every club reads NULL.
--   * "Organisation_groupInviteLink_check": the link is canonical and on
--     chat.whatsapp.com only. Every existing row passes (all NULL). Its
--     definition also lives in prisma/sql/pool-check.sql, which from now on
--     needs this migration applied first (it names the column).
--
-- It drops, renames and rewrites nothing. No PlatformJob change: the new
-- job kind ("invite-code") and DM purposes are TEXT values with no CHECK.
--
-- IDEMPOTENT: columns IF NOT EXISTS, the constraint dropped if present
-- before it is added. ONE transaction. lock_timeout makes a busy table
-- fail fast instead of queueing every query behind the ALTER; if it fails
-- on the lock, nothing was changed and it can simply be run again. There
-- is no session-level SET in this file.
--
-- Verify after applying (expect 3 rows, then 0):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'Organisation' AND column_name IN ('groupInviteLink', 'groupInviteLinkSetAt', 'groupInviteLinkSetById');
--   SELECT count(*) FROM "Organisation" WHERE "groupInviteLink" IS NOT NULL;
--
-- Rolling back (after the code that reads them is no longer deployed):
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_groupInviteLink_check";
--   ALTER TABLE "Organisation" DROP COLUMN IF EXISTS "groupInviteLink",
--     DROP COLUMN IF EXISTS "groupInviteLinkSetAt", DROP COLUMN IF EXISTS "groupInviteLinkSetById";
--   (and remove the CHECK from prisma/sql/pool-check.sql in git)

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "groupInviteLink" TEXT;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "groupInviteLinkSetAt" TIMESTAMP(3);
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "groupInviteLinkSetById" TEXT;

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_groupInviteLink_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_groupInviteLink_check"
  CHECK ("groupInviteLink" IS NULL OR "groupInviteLink" ~ '^https://chat\.whatsapp\.com/[A-Za-z0-9]{10,40}$');

COMMIT;
