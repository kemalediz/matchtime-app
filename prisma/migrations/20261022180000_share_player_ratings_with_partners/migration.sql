-- "Share our players' ratings with partner clubs" (Kemal, 2026-10-22,
-- option C). A partner guest's standing in the asking club's notice.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand BEFORE
-- the code deploys (the code reads the column):
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261022180000_share_player_ratings_with_partners/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Adds one NOT NULL boolean column with a constant DEFAULT false. Every
-- existing club reads as OFF: no club shares a rating until an owner or
-- admin switches it on. Metadata only on Postgres 11+ (no table rewrite).
--
-- Verify after applying (expect 0):
--   SELECT count(*) FROM "Organisation" WHERE "sharePlayerRatingsWithPartners";
--
-- Rolling back:
--   ALTER TABLE "Organisation" DROP COLUMN "sharePlayerRatingsWithPartners";
--
-- IDEMPOTENT. One transaction; lock_timeout makes a busy table fail fast.

BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "sharePlayerRatingsWithPartners" BOOLEAN NOT NULL DEFAULT false;
COMMIT;
