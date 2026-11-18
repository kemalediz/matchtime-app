-- What a Man of the Match announcement told the group (Kemal, 2026-11-16).
-- "Who was the last Man of the Match?" must be answered with the same winner
-- and the same tally the group was shown. Re-counting the MoMVote rows later
-- cannot give that: votes are still accepted after an early post or the
-- day-5 backstop, a changed vote keeps its old "createdAt", and an
-- organiser's pick row is deleted and recreated on every restatement. So the
-- result is stored here, one row per match, when /api/whatsapp/due-posts
-- claims the announcement ("<matchId>:mom-announcement"), from the same tally
-- the post's words were built from. See src/lib/mom-announce-rules.ts.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261116120000_mom_announcement/migration.sql
--   (or: npx tsx scripts/apply-mom-announcement-migration.ts [--apply])
--
-- WHAT IS KEPT: the winner and the vote count of every player the post
-- listed (or the one name an organiser picked), with their user ids, as
-- JSON in "result". NEVER who voted for whom.
--
-- ORDER: THIS MUST BE APPLIED BEFORE THE DEPLOY. Nothing breaks if it is not:
-- the claim writes this table best-effort, after the post's own claim row, so
-- every write fails, is logged and swallowed, and the announcement still goes
-- out; the readers treat the missing table as no records (one info line).
-- But every result posted meanwhile has no stored record. The answer then
-- reads the post's own text where it can, and otherwise names nobody and
-- credits nobody until that vote's window closes (up to 7 days), which can
-- hold a Man of the Match badge back to the next week's badges post.
-- Results posted before the change are filled in from the posts' own text by
-- scripts/backfill-mom-announcements.ts (dry run by default; --apply never
-- overwrites a record), and read back from that text on the fly anyway.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One NEW table "MoMAnnouncement" keyed by "matchId",
-- with a foreign key to "Match" (ON DELETE CASCADE). No existing table,
-- column or row changes.
--
-- IDEMPOTENT: IF NOT EXISTS, the constraint dropped and re-added.
-- ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect "MoMAnnouncement"):
--   SELECT to_regclass('"MoMAnnouncement"');
--
-- Rolling back:
--   DROP TABLE IF EXISTS "MoMAnnouncement";

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "MoMAnnouncement" (
    "matchId" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "announcedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoMAnnouncement_pkey" PRIMARY KEY ("matchId")
);

ALTER TABLE "MoMAnnouncement" DROP CONSTRAINT IF EXISTS "MoMAnnouncement_matchId_fkey";
ALTER TABLE "MoMAnnouncement" ADD CONSTRAINT "MoMAnnouncement_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
