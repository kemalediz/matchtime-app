-- A partner request never expires (Kemal, 2026-11-05: "stop expiring
-- everything for unanswered too"). Plan: MDs/partner-discovery-plan-2026-10-21.md,
-- the dated note under section 9. A request between clubs now stays open
-- until the other club accepts or declines it, or the asking club withdraws
-- it, so the column that held its expiry goes.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261105090000_partner_requests_never_expire/migration.sql
--
-- APPLY AFTER THE CODE IS DEPLOYED, NOT BEFORE (the reverse of the usual
-- order). The Prisma client lists every ClubPartnership column on queries
-- without a `select`, so the code live before this change, which still
-- knows "expiresAt", fails (column does not exist) against a database
-- without it. The new code never names the column, so it runs fine against
-- a database that still has it. Deploy, wait for it to be live, then apply.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Drops one nullable column, "ClubPartnership"."expiresAt". Prod had no
-- pending request when this was written (verified 2026-11-05), so no open
-- request loses anything; ended rows only lose a date nothing reads. No
-- other column, row, index or CHECK changes. The "endReason" CHECK keeps
-- 'expired' as an allowed value: old rows carry it, and nothing writes it
-- any more. Lock: a moment's ACCESS EXCLUSIVE on a small table
-- (lock_timeout 5s, so a busy moment fails cleanly; re-run it).
--
-- IDEMPOTENT: DROP COLUMN IF EXISTS. ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect 0 rows):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'ClubPartnership' AND column_name = 'expiresAt';
--
-- Rolling back (only if the expiry code is restored; the dates are gone):
--   ALTER TABLE "ClubPartnership" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "ClubPartnership" DROP COLUMN IF EXISTS "expiresAt";

COMMIT;
