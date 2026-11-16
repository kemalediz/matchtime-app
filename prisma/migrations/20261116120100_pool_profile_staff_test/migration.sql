-- Staff test sign-ups (2026-11-16, Kemal): a /play or friend-link sign-up
-- a MatchTime staff member makes with a verified staff session, ticked as a
-- test, is left out of the pool's MEASUREMENTS only: the funnel's sent and
-- confirmed steps, the codes page's "All time" sign-ups, the pool funnel
-- page and its CSV, the offer health and the analytics sign-up event. In
-- every operational flow (offers, rounds, places, posts, pages, badges) he
-- is a player like any other. The flag lives where those measurements read
-- it:
--   "PoolProfile"."staffTest"   set by createPoolSignup (src/lib/pool/signup.ts);
--   "PoolOffer"."staffTest"     set when an offer is made to a staff test
--                               (src/lib/pool/round.ts), for the offer
--                               health, so it holds after the profile goes.
-- Nothing else about these rows changes.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261116120100_pool_profile_staff_test/migration.sql
--
-- Second of four (see 20261116120000_pool_visit_daily). APPLY BEFORE
-- MERGING: merging deploys, and the new code's Prisma client knows these
-- columns and names them in its queries, so without them these fail:
--   - EVERY insert into "PoolProfile" (a /play sign-up, a friend link's
--     sign-up, a member's sign-up from his profile);
--   - every update of a "PoolProfile" that returns the row (the WhatsApp
--     confirm, the manage page, pausing, stopping, the offer rounds);
--   - every read of a "PoolProfile" without a `select` (Prisma then lists
--     every column);
--   - EVERY insert into "PoolOffer" (every pool offer), and the same reads
--     and returning updates of it.
-- That is the whole player pool. The old code never names the columns, and
-- their defaults keep the old inserts valid, so applying this first changes
-- nothing live.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Two NEW columns, each BOOLEAN NOT NULL DEFAULT false: every existing
-- profile and offer is not a staff test (Postgres 11+ adds a constant
-- default without rewriting the table, so each lock is held for moments).
-- No row changes.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS. ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect one row each: false, every row):
--   SELECT "staffTest", count(*) FROM "PoolProfile" GROUP BY 1;
--   SELECT "staffTest", count(*) FROM "PoolOffer" GROUP BY 1;
--
-- Rolling back (with the old code back):
--   ALTER TABLE "PoolProfile" DROP COLUMN IF EXISTS "staffTest";
--   ALTER TABLE "PoolOffer" DROP COLUMN IF EXISTS "staffTest";

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "PoolProfile" ADD COLUMN IF NOT EXISTS "staffTest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PoolOffer" ADD COLUMN IF NOT EXISTS "staffTest" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
