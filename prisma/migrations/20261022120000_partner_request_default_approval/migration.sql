-- Partner requests (partner discovery), slice P3, 2026-10-22.
-- Plan: MDs/partner-discovery-plan-2026-10-21.md, section 1 ("post without
-- asking" is the default, Kemal 2026-10-22) and section 3.2.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand. Order
-- does not matter for correctness: the code writes "standing" explicitly on
-- every request row (REQUEST_DEFAULT_APPROVAL in
-- src/lib/club-partnership-rules.ts), so this only keeps the database's
-- default in step with prisma/schema.prisma for any other insert.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261022120000_partner_request_default_approval/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Changes the column DEFAULT of "ClubPartnership"."partnerApproval" from
-- 'each-ask' to 'standing'. A default applies only to rows inserted
-- afterwards: NO EXISTING ROW CHANGES (MT Test's "each-ask" pairing stays
-- "each-ask"). Metadata only: no table rewrite, no scan.
--
-- Verify after applying (expect 'standing'::text):
--   SELECT column_default FROM information_schema.columns
--    WHERE table_name = 'ClubPartnership' AND column_name = 'partnerApproval';
--
-- Rolling back:
--   ALTER TABLE "ClubPartnership" ALTER COLUMN "partnerApproval" SET DEFAULT 'each-ask';
--
-- IDEMPOTENT. One transaction; lock_timeout makes a busy table fail fast.

BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "ClubPartnership" ALTER COLUMN "partnerApproval" SET DEFAULT 'standing';
COMMIT;
