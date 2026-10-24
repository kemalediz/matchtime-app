-- The local player pool, slice L2: the /play sign-up and its WhatsApp
-- confirmation (2026-10-25).
-- Plan: MDs/local-player-pool-plan-2026-10-23.md section 3.1, extended by
-- MDs/local-player-pool-approved-spec-2026-10-24.md (which wins).
--
-- NEEDS the L1 migration (20261024200000_local_player_pool) applied first:
-- it alters "PoolProfile". L1's file now carries the same 5-character
-- confirm code CHECK; the swap here is for a database that ran L1 when it
-- still said four.
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
-- Strictly additive. "PoolProfile" is empty in production today (L1 has no
-- writer), so the CHECK swap below meets no row.
--   * One column on "PoolProfile": "signupIp" TEXT NULL (the /play form's
--     requesting address; set only while a sign-up waits for its WhatsApp
--     message, cleared when it is confirmed), and its CHECK.
--   * "PoolProfile_confirmCode_check" replaced: a pool code is now FIVE
--     characters (a self-join connect code is four, so the two readers can
--     never take each other's code). Same alphabet.
--   * Two new, EMPTY tables, no foreign keys:
--       "PoolAttempt"        rate-limit records (failed confirm codes by
--                            number; sign-up attempts by address). No text,
--                            no code. Deleted after 30 days.
--       "PoolConsentRecord"  the append-only consent record: each consent
--                            and withdrawal (user, number, policy version,
--                            channel, evidence id, the code). Kept 6 years,
--                            also after a profile or User is deleted, as the
--                            privacy policy says.
--     With their indexes and CHECKs.
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
-- The same CHECKs are in prisma/sql/pool-check.sql (the re-runnable file
-- the e2e database gets), pinned to src/lib/pool/vocab.ts and rules.ts by
-- src/lib/pool/__tests__/schema-sql.test.ts.
--
-- Verify after applying (expect 1 row, 2 rows, then 0 and 0):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'PoolProfile' AND column_name = 'signupIp';
--   SELECT table_name FROM information_schema.tables WHERE table_name IN ('PoolAttempt', 'PoolConsentRecord');
--   SELECT count(*) FROM "PoolAttempt";
--   SELECT count(*) FROM "PoolConsentRecord";
--
-- Rolling back (after the code that reads them is no longer deployed):
--   DROP TABLE IF EXISTS "PoolAttempt", "PoolConsentRecord";
--   ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_signupIp_check";
--   ALTER TABLE "PoolProfile" DROP COLUMN IF EXISTS "signupIp";
--   (and re-run L1's 4-character confirm code CHECK if the L1 code returns)

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "PoolProfile" ADD COLUMN IF NOT EXISTS "signupIp" TEXT;
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_signupIp_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_signupIp_check"
  CHECK ("signupIp" IS NULL OR "status" = 'pending-verify');
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_confirmCode_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_confirmCode_check"
  CHECK ("confirmCode" IS NULL OR ("status" = 'pending-verify' AND "confirmCode" ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$'));

CREATE TABLE IF NOT EXISTS "PoolAttempt" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoolAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PoolAttempt_kind_key_createdAt_idx" ON "PoolAttempt"("kind", "key", "createdAt");
CREATE INDEX IF NOT EXISTS "PoolAttempt_createdAt_idx" ON "PoolAttempt"("createdAt");
ALTER TABLE "PoolAttempt" DROP CONSTRAINT IF EXISTS "PoolAttempt_result_check";
ALTER TABLE "PoolAttempt" ADD CONSTRAINT "PoolAttempt_result_check"
  CHECK (("kind" = 'confirm' AND "result" IN ('wrong', 'expired', 'has-profile')) OR ("kind" = 'signup' AND "result" IN ('created', 'area-not-found', 'venues-unknown')));

CREATE TABLE IF NOT EXISTS "PoolConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" TEXT,
    "action" TEXT NOT NULL,
    "version" INTEGER,
    "channel" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "code" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoolConsentRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PoolConsentRecord_userId_createdAt_idx" ON "PoolConsentRecord"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "PoolConsentRecord_createdAt_idx" ON "PoolConsentRecord"("createdAt");
ALTER TABLE "PoolConsentRecord" DROP CONSTRAINT IF EXISTS "PoolConsentRecord_action_check";
ALTER TABLE "PoolConsentRecord" ADD CONSTRAINT "PoolConsentRecord_action_check"
  CHECK ("action" IN ('consent', 'withdraw'));
ALTER TABLE "PoolConsentRecord" DROP CONSTRAINT IF EXISTS "PoolConsentRecord_channel_check";
ALTER TABLE "PoolConsentRecord" ADD CONSTRAINT "PoolConsentRecord_channel_check"
  CHECK ("channel" IN ('whatsapp', 'web'));
ALTER TABLE "PoolConsentRecord" DROP CONSTRAINT IF EXISTS "PoolConsentRecord_version_check";
ALTER TABLE "PoolConsentRecord" ADD CONSTRAINT "PoolConsentRecord_version_check"
  CHECK ("action" <> 'consent' OR "version" IS NOT NULL);

COMMIT;
