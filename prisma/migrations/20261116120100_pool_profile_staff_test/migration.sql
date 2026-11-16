-- Staff test sign-ups (2026-11-16, Kemal): a /play sign-up made from a
-- MatchTime staff browser must not count as sent or confirmed in the
-- funnel. The confirm happens later by WhatsApp, where no cookie exists,
-- so the sign-up carries the flag: "PoolProfile"."staffTest", set by
-- createPoolSignup (src/lib/pool/signup.ts) when the request is from
-- MatchTime staff (src/lib/pool/staff-request.ts), read by
-- recordPoolSignupSent and recordPoolSignupConfirmed (src/lib/pool/visits.ts).
-- Nothing else about the sign-up changes.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261116120100_pool_profile_staff_test/migration.sql
--
-- Second of four (see 20261116120000_pool_visit_daily). APPLY BEFORE
-- DEPLOYING THE CODE. The new code's Prisma client knows the column and
-- names it in its queries, so without it these fail on "PoolProfile":
--   - EVERY insert into "PoolProfile" (a /play sign-up, a friend link's
--     sign-up, a member's sign-up from his profile);
--   - every update of a "PoolProfile" that returns the row (the WhatsApp
--     confirm, the manage page, pausing, stopping, the offer rounds);
--   - every read of a "PoolProfile" without a `select` (Prisma then lists
--     every column).
-- That is the whole player pool. The old code never names the column, and
-- its default keeps the old inserts valid, so applying it first changes
-- nothing live.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- One NEW column, BOOLEAN NOT NULL DEFAULT false: every existing profile
-- is not a staff test (Postgres 11+ adds a constant default without
-- rewriting the table, so the lock is held for moments). No row changes.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS. ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect one row: false, every profile):
--   SELECT "staffTest", count(*) FROM "PoolProfile" GROUP BY 1;
--
-- Rolling back (with the old code back):
--   ALTER TABLE "PoolProfile" DROP COLUMN IF EXISTS "staffTest";

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "PoolProfile" ADD COLUMN IF NOT EXISTS "staffTest" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
