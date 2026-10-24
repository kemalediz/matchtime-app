-- The local player pool, slice L7: no-shows, the turn-up record, the
-- pauses MatchTime decides, blocks and reports (2026-10-24).
-- Plan: MDs/local-player-pool-plan-2026-10-23.md sections 5.5, 6 and 9;
-- decisions L7.x in MDs/local-player-pool-decisions-log.md.
--
-- NEEDS L1 (20261024200000_local_player_pool) applied first: it alters
-- "PoolProfile", "PoolBlock" and "GuestPlace".
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- column on queries without a `select`, so code that knows the new columns
-- fails against a database without them.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261026090000_pool_no_shows/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. No row is written or changed.
--   * "GuestPlace"."settledAt" TIMESTAMP NULL: the guest's result is final
--     (the 24-hour no-show window closed, or the game was cancelled).
--   * "PoolProfile"."reviewRequestedAt" TIMESTAMP NULL: he asked a person
--     to look at a pause MatchTime decided; its CHECK.
--   * "PoolBlock"."userGoneAt" TIMESTAMP NULL: when his pool profile was
--     deleted (the record is kept 24 months after that, decision L0.3).
--   * One new, EMPTY table, "PoolReport" (a problem reported to the
--     platform owner by a club or by a player; no foreign key on the user,
--     so it outlives a deleted profile for the same 24 months), with its
--     indexes, its foreign key to "Organisation" and its CHECKs.
--   * "PoolProfile_paused_check" replaced by one that ALSO allows a pause
--     MatchTime decided ("no-shows", "reports", "admin") to stay on a
--     STOPPED profile, so stopping and starting again cannot lift it. It
--     also requires "pausedReason" and "pausedAt" to be set together,
--     which the old one did not (it allowed a "pausedAt" with no reason on
--     a profile that was not paused). "PoolProfile" is EMPTY in production
--     today (the pool has not opened), so the swap meets no row. On a
--     database that has profiles, check first (expect 0):
--       SELECT count(*) FROM "PoolProfile" WHERE ("pausedReason" IS NULL) <> ("pausedAt" IS NULL);
--
-- IDEMPOTENT: every column, table and index is IF NOT EXISTS and every
-- constraint is dropped if present before it is added. ONE transaction.
-- lock_timeout makes a busy table fail fast; if it fails on the lock,
-- nothing was changed and it can simply be run again. No session-level SET.
--
-- The same CHECKs are in prisma/sql/pool-check.sql (the re-runnable file
-- the e2e database gets), pinned by src/lib/pool/__tests__/schema-sql.test.ts.
-- L1's own file now carries the new paused CHECK too, so the two can be
-- re-run in any order.
--
-- Verify after applying (expect 3 rows, 1 row, then 0):
--   SELECT table_name, column_name FROM information_schema.columns
--    WHERE (table_name, column_name) IN (('GuestPlace', 'settledAt'), ('PoolProfile', 'reviewRequestedAt'), ('PoolBlock', 'userGoneAt'));
--   SELECT table_name FROM information_schema.tables WHERE table_name = 'PoolReport';
--   SELECT count(*) FROM "PoolReport";
--
-- Rolling back (after the code that reads them is no longer deployed):
--   DROP TABLE IF EXISTS "PoolReport";
--   ALTER TABLE "GuestPlace" DROP COLUMN IF EXISTS "settledAt";
--   ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_reviewRequested_check";
--   ALTER TABLE "PoolProfile" DROP COLUMN IF EXISTS "reviewRequestedAt";
--   ALTER TABLE "PoolBlock" DROP COLUMN IF EXISTS "userGoneAt";
--   (and L1's old paused CHECK, once no stopped profile keeps a reason)

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "GuestPlace" ADD COLUMN IF NOT EXISTS "settledAt" TIMESTAMP(3);
ALTER TABLE "PoolProfile" ADD COLUMN IF NOT EXISTS "reviewRequestedAt" TIMESTAMP(3);
ALTER TABLE "PoolBlock" ADD COLUMN IF NOT EXISTS "userGoneAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "PoolReport" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "byUserId" TEXT NOT NULL,
    "matchId" TEXT,
    "text" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "userGoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoolReport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PoolReport_userId_createdAt_idx" ON "PoolReport"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "PoolReport_orgId_createdAt_idx" ON "PoolReport"("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "PoolReport_reviewedAt_idx" ON "PoolReport"("reviewedAt");
ALTER TABLE "PoolReport" DROP CONSTRAINT IF EXISTS "PoolReport_orgId_fkey";
ALTER TABLE "PoolReport" ADD CONSTRAINT "PoolReport_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PoolReport" DROP CONSTRAINT IF EXISTS "PoolReport_by_check";
ALTER TABLE "PoolReport" ADD CONSTRAINT "PoolReport_by_check"
  CHECK ("by" IN ('club', 'player'));
ALTER TABLE "PoolReport" DROP CONSTRAINT IF EXISTS "PoolReport_text_check";
ALTER TABLE "PoolReport" ADD CONSTRAINT "PoolReport_text_check"
  CHECK (length("text") BETWEEN 3 AND 1000);
ALTER TABLE "PoolReport" DROP CONSTRAINT IF EXISTS "PoolReport_reviewed_check";
ALTER TABLE "PoolReport" ADD CONSTRAINT "PoolReport_reviewed_check"
  CHECK (("reviewedAt" IS NULL) = ("reviewedBy" IS NULL));

ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_paused_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_paused_check"
  CHECK ((("pausedReason" IS NULL) = ("pausedAt" IS NULL)) AND ("status" <> 'paused' OR "pausedReason" IS NOT NULL)
    AND ("pausedReason" IS NULL OR "status" = 'paused' OR ("status" = 'stopped' AND "pausedReason" IN ('no-shows', 'reports', 'admin'))));
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_reviewRequested_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_reviewRequested_check"
  CHECK ("reviewRequestedAt" IS NULL OR "pausedReason" IN ('no-shows', 'reports', 'admin'));

COMMIT;
