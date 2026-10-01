-- Badge announcements (2026-10-01): src/lib/badge-announcements.ts.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   1. "Organisation"."featureBadgeAnnouncements" BOOLEAN NOT NULL
--      DEFAULT true. Postgres 11+ stores a constant default in the
--      catalog: no table rewrite. Every club, Sutton FC included, reads
--      true, so the feature is ON everywhere once the code ships.
--   2. One new table, "BadgeAnnouncement": the once-ever ledger of badges
--      announced per player per club. Unique on (orgId, userId, badgeKey);
--      foreign keys to "Organisation" and "User", ON DELETE CASCADE.
--      "matchId" is informational, deliberately with no foreign key.
--      Empty until the backfill below or the first post.
--
-- It does NOT drop, rename or rewrite anything, and changes no query that
-- does not name the new column or table.
--
-- ORDER OF OPERATIONS (so Sutton FC is never flooded with old badges)
-- --------------------------------------------------------------------
--   1. Apply this file.
--   2. Run the backfill, which records every badge players ALREADY hold
--      as announced (dry run first, it writes nothing without --apply):
--        npx tsx scripts/backfill-badge-announcements.ts
--        npx tsx scripts/backfill-badge-announcements.ts --apply
--   3. Merge and deploy.
-- If step 2 is skipped the code still cannot flood a club: while a club
-- has no ledger rows, a post announces only badges earned at that match
-- and records everything else silently (the bootstrap guard).
--
-- Verify after applying:
--   SELECT count(*) FROM "Organisation" WHERE "featureBadgeAnnouncements" = false;  -- 0
--   SELECT count(*) FROM "BadgeAnnouncement";                                      -- 0 before the backfill
--
-- Rolling back:
--   DROP TABLE "BadgeAnnouncement";
--   ALTER TABLE "Organisation" DROP COLUMN "featureBadgeAnnouncements";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL and `db push` produces the same
-- result. It carries its own BEGIN/COMMIT for psql -f.

BEGIN;

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN "featureBadgeAnnouncements" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "BadgeAnnouncement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "badgeKey" TEXT NOT NULL,
    "matchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BadgeAnnouncement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BadgeAnnouncement_orgId_userId_badgeKey_key" ON "BadgeAnnouncement"("orgId", "userId", "badgeKey");

-- AddForeignKey
ALTER TABLE "BadgeAnnouncement" ADD CONSTRAINT "BadgeAnnouncement_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BadgeAnnouncement" ADD CONSTRAINT "BadgeAnnouncement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
