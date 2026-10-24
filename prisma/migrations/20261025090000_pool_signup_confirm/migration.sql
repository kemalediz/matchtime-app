-- The local player pool, slice L2: the /play sign-up and its WhatsApp
-- confirmation (2026-10-25).
-- Plan: MDs/local-player-pool-plan-2026-10-23.md section 3.1, extended by
-- MDs/local-player-pool-approved-spec-2026-10-24.md (which wins).
--
-- NEEDS the L1 migration (20261024200000_local_player_pool) applied first:
-- it alters "PoolProfile".
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- "PoolProfile" column on queries without a `select`, so code that knows
-- the new column fails against a database without it.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261025090000_pool_signup_confirm/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   * One column on "PoolProfile": "signupIp" TEXT NULL (the /play form's
--     requesting address, for its per-hour cap; set only while a sign-up is
--     waiting for its WhatsApp message, cleared when it is confirmed).
--     "PoolProfile" is empty in production today (L1 has no writer).
--   * One CHECK on it, "PoolProfile_signupIp_check": NULL unless
--     'pending-verify'.
--   * One new, EMPTY table: "PoolConfirmAttempt" (a /play code from one
--     number that did not work: the number, 'wrong' or 'expired', the time;
--     no text, no code), with its two indexes and its CHECK.
--
-- It drops, renames and rewrites nothing. No row changes. No club changes:
-- sign-up touches no club and MatchTime still never messages anyone first.
--
-- IDEMPOTENT: every column, table and index is IF NOT EXISTS and every
-- constraint is dropped if present before it is added. ONE transaction.
-- lock_timeout makes a busy table fail fast; if it fails on the lock,
-- nothing was changed and it can simply be run again. There is no
-- session-level SET in this file.
--
-- The same two CHECKs are in prisma/sql/pool-check.sql (the re-runnable
-- file the e2e database gets), pinned to src/lib/pool/vocab.ts by
-- src/lib/pool/__tests__/schema-sql.test.ts.
--
-- Verify after applying (expect 1 row, 1 row, then 0):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'PoolProfile' AND column_name = 'signupIp';
--   SELECT table_name FROM information_schema.tables WHERE table_name = 'PoolConfirmAttempt';
--   SELECT count(*) FROM "PoolConfirmAttempt";
--
-- Rolling back (after the code that reads them is no longer deployed):
--   DROP TABLE IF EXISTS "PoolConfirmAttempt";
--   ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_signupIp_check";
--   ALTER TABLE "PoolProfile" DROP COLUMN IF EXISTS "signupIp";

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "PoolProfile" ADD COLUMN IF NOT EXISTS "signupIp" TEXT;
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_signupIp_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_signupIp_check"
  CHECK ("signupIp" IS NULL OR "status" = 'pending-verify');

CREATE TABLE IF NOT EXISTS "PoolConfirmAttempt" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoolConfirmAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PoolConfirmAttempt_phone_createdAt_idx" ON "PoolConfirmAttempt"("phone", "createdAt");
CREATE INDEX IF NOT EXISTS "PoolConfirmAttempt_createdAt_idx" ON "PoolConfirmAttempt"("createdAt");
ALTER TABLE "PoolConfirmAttempt" DROP CONSTRAINT IF EXISTS "PoolConfirmAttempt_result_check";
ALTER TABLE "PoolConfirmAttempt" ADD CONSTRAINT "PoolConfirmAttempt_result_check"
  CHECK ("result" IN ('wrong', 'expired'));
ALTER TABLE "PoolConfirmAttempt" DROP CONSTRAINT IF EXISTS "PoolConfirmAttempt_phone_check";
ALTER TABLE "PoolConfirmAttempt" ADD CONSTRAINT "PoolConfirmAttempt_phone_check"
  CHECK ("phone" ~ '^[0-9]{8,15}$');

COMMIT;
