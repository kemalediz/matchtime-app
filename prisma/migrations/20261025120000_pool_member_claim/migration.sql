-- The local player pool, slice L3: a member's WhatsApp claim (2026-10-25).
-- A club member with no number on his account starts the /play WhatsApp
-- step from his profile. When a number NO account holds sends his code,
-- nothing is attached: the number waits on his waiting sign-up for his
-- yes on his signed-in page.
--
-- NEEDS the L1 and L2 migrations applied first (20261024200000_local_player_pool,
-- 20261025090000_pool_signup_confirm).
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, BEFORE
-- the code is deployed (the Prisma client selects every "PoolProfile"
-- column on queries without a `select`):
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261025120000_pool_member_claim/migration.sql
--
-- Strictly additive: three NULL columns on "PoolProfile" and their CHECK.
-- No row changes. IDEMPOTENT, ONE transaction, no session-level SET. The
-- same CHECK is in prisma/sql/pool-check.sql.
--
-- Verify (expect 3 rows):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'PoolProfile' AND column_name IN ('claimPhone', 'claimMessageId', 'claimAt');
--
-- Roll back (after the code that reads them is no longer deployed):
--   ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_claim_check";
--   ALTER TABLE "PoolProfile" DROP COLUMN IF EXISTS "claimPhone", DROP COLUMN IF EXISTS "claimMessageId", DROP COLUMN IF EXISTS "claimAt";

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "PoolProfile" ADD COLUMN IF NOT EXISTS "claimPhone" TEXT;
ALTER TABLE "PoolProfile" ADD COLUMN IF NOT EXISTS "claimMessageId" TEXT;
ALTER TABLE "PoolProfile" ADD COLUMN IF NOT EXISTS "claimAt" TIMESTAMP(3);

ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_claim_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_claim_check"
  CHECK (("claimPhone" IS NULL) = ("claimMessageId" IS NULL) AND ("claimPhone" IS NULL) = ("claimAt" IS NULL)
    AND ("claimPhone" IS NULL OR ("status" = 'pending-verify' AND "userId" IS NOT NULL AND "claimPhone" ~ '^[0-9]{7,15}$')));

COMMIT;
