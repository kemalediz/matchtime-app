-- The player pool banner's "Not interested" (2026-10-28, approved by Kemal).
-- One line at the top of every signed-in page asks a club member to join
-- the MatchTime player pool, or, once he is in it, to share his own link.
-- "Not interested" hides that banner for good, on every device, so it is
-- stored on his user row: one timestamp per banner, so dismissing the join
-- banner and joining later still shows the share banner once.
--
-- The code tolerates these columns being missing (it reads them with raw
-- SQL and shows no banner when the read fails), so this may be applied
-- before or after the code is deployed. Until it is applied, nobody sees
-- the banner.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261028180000_pool_banner_dismissals/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. Two new NULLABLE columns on "User", no default, so
-- adding them rewrites no rows and takes only a brief lock. No existing
-- row or column is touched.
--   * "User"."poolBannerJoinDismissedAt"  TIMESTAMP(3) NULL
--   * "User"."poolBannerShareDismissedAt" TIMESTAMP(3) NULL
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; a second run changes nothing.
-- ONE transaction; there is no session-level SET in this file.
--
-- Verify after applying (expect two rows):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'User' AND column_name LIKE 'poolBanner%';
--
-- Rolling back (the code reads a missing column as "no banner"):
--   ALTER TABLE "User" DROP COLUMN IF EXISTS "poolBannerJoinDismissedAt",
--                      DROP COLUMN IF EXISTS "poolBannerShareDismissedAt";

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "poolBannerJoinDismissedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "poolBannerShareDismissedAt" TIMESTAMP(3);

COMMIT;
