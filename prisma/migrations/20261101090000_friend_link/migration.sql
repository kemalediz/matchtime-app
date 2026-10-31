-- Friend link (2026-10-31, approved by Kemal): a member says a friend is
-- coming, MatchTime DMs him a personal link for that match, and the friend
-- joins only by filling in the /play form and sending his WhatsApp code.
-- Plan: MDs/friend-link-plan-2026-10-31.md.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261101090000_friend_link/migration.sql
--
-- APPLY BEFORE DEPLOYING THE CODE: the analyze route writes "FriendLink"
-- rows for every player's "my friend is in".
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One NEW table "FriendLink" (foreign keys to
-- "Organisation" and "Match", ON DELETE CASCADE). Two NEW nullable columns,
-- "PoolProfile"."friendLinkId" and "GuestPlace"."friendLinkId", NULL on
-- every existing row. "PoolProfile_source_check" gains 'friend'. One new
-- CHECK on "GuestPlace" that every existing row passes (its new column is
-- NULL). No existing row is changed.
--
-- IDEMPOTENT: IF NOT EXISTS everywhere, constraints dropped and re-added.
-- ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect "FriendLink" and two rows):
--   SELECT to_regclass('"FriendLink"');
--   SELECT table_name FROM information_schema.columns WHERE column_name = 'friendLinkId';
--
-- Rolling back:
--   ALTER TABLE "GuestPlace" DROP CONSTRAINT IF EXISTS "GuestPlace_friend_check";
--   ALTER TABLE "GuestPlace" DROP COLUMN IF EXISTS "friendLinkId";
--   ALTER TABLE "PoolProfile" DROP COLUMN IF EXISTS "friendLinkId";
--   DROP TABLE IF EXISTS "FriendLink";
--   (and "PoolProfile_source_check" back without 'friend', once no row has it)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "FriendLink" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "issuedByUserId" TEXT NOT NULL,
    "friendName" TEXT,
    "sourceMessageId" TEXT NOT NULL,
    "claimIndex" INTEGER NOT NULL DEFAULT 0,
    "botJobId" TEXT,
    "usedAt" TIMESTAMP(3),
    "usedByUserId" TEXT,
    "usedMessageId" TEXT,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FriendLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FriendLink_usedMessageId_key" ON "FriendLink"("usedMessageId");
CREATE UNIQUE INDEX IF NOT EXISTS "FriendLink_sourceMessageId_claimIndex_key" ON "FriendLink"("sourceMessageId", "claimIndex");
CREATE INDEX IF NOT EXISTS "FriendLink_matchId_issuedByUserId_idx" ON "FriendLink"("matchId", "issuedByUserId");

ALTER TABLE "FriendLink" DROP CONSTRAINT IF EXISTS "FriendLink_orgId_fkey";
ALTER TABLE "FriendLink" ADD CONSTRAINT "FriendLink_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FriendLink" DROP CONSTRAINT IF EXISTS "FriendLink_matchId_fkey";
ALTER TABLE "FriendLink" ADD CONSTRAINT "FriendLink_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FriendLink" DROP CONSTRAINT IF EXISTS "FriendLink_used_check";
ALTER TABLE "FriendLink" ADD CONSTRAINT "FriendLink_used_check"
  CHECK ((("usedAt" IS NULL) = ("usedMessageId" IS NULL)) AND (("usedAt" IS NULL) = ("outcome" IS NULL)));

ALTER TABLE "PoolProfile" ADD COLUMN IF NOT EXISTS "friendLinkId" TEXT;
CREATE INDEX IF NOT EXISTS "PoolProfile_friendLinkId_idx" ON "PoolProfile"("friendLinkId");
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_source_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_source_check"
  CHECK ("source" IS NULL OR "source" IN ('web', 'profile', 'referral', 'campaign', 'friend'));

ALTER TABLE "GuestPlace" ADD COLUMN IF NOT EXISTS "friendLinkId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "GuestPlace_friendLinkId_key" ON "GuestPlace"("friendLinkId");
ALTER TABLE "GuestPlace" DROP CONSTRAINT IF EXISTS "GuestPlace_friend_check";
ALTER TABLE "GuestPlace" ADD CONSTRAINT "GuestPlace_friend_check"
  CHECK ("friendLinkId" IS NULL OR ("source" = 'pool' AND "poolOfferId" IS NULL));

COMMIT;
