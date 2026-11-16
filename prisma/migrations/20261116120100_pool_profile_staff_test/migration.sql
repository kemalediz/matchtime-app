-- Staff test sign-ups (2026-11-16, Kemal): a /play sign-up a MatchTime
-- staff member makes and ticks as a test, with a verified staff session,
-- is counted nowhere (the funnel, the owner's pages, the clubs' pages and
-- notices, referral badges, analytics), though it works as any other and
-- can be offered games. The flag lives on the profile and, since round 4
-- of #607, on the rows that outlive it, so an erased staff-test profile
-- never comes back into a count:
--   "PoolProfile"."staffTest"   set by createPoolSignup (src/lib/pool/signup.ts);
--   "PoolOffer"."staffTest"     set when an offer is made to a staff test
--                               (src/lib/pool/round.ts);
--   "GuestPlace"."staffTest"    set when a staff test takes a place, by an
--                               offer or by a friend link
--                               (src/lib/partner-guest.ts).
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
--   - EVERY insert into "PoolOffer" (every pool offer);
--   - EVERY insert into "GuestPlace" (every pool, friend-link and partner
--     guest taking a place), and the same reads and returning updates of
--     both.
-- That is the whole player pool and every guest place. The old code never
-- names the columns, and their defaults keep the old inserts valid, so
-- applying this first changes nothing live.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Three NEW columns, each BOOLEAN NOT NULL DEFAULT false: every existing
-- profile, offer and guest place is not a staff test (Postgres 11+ adds a
-- constant default without rewriting the table, so each lock is held for
-- moments). No row changes.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS. ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect one row each: false, every row):
--   SELECT "staffTest", count(*) FROM "PoolProfile" GROUP BY 1;
--   SELECT "staffTest", count(*) FROM "PoolOffer" GROUP BY 1;
--   SELECT "staffTest", count(*) FROM "GuestPlace" GROUP BY 1;
--
-- Rolling back (with the old code back):
--   ALTER TABLE "PoolProfile" DROP COLUMN IF EXISTS "staffTest";
--   ALTER TABLE "PoolOffer" DROP COLUMN IF EXISTS "staffTest";
--   ALTER TABLE "GuestPlace" DROP COLUMN IF EXISTS "staffTest";

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "PoolProfile" ADD COLUMN IF NOT EXISTS "staffTest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PoolOffer" ADD COLUMN IF NOT EXISTS "staffTest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GuestPlace" ADD COLUMN IF NOT EXISTS "staffTest" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
