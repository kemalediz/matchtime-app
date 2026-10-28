-- A refused pool ask, asked again once the club fixes what was missing
-- (2026-10-28, approved by Kemal). An organiser asks the MatchTime player
-- pool in words; the pool refuses "no-venue" (the game's venue has no
-- position); the organiser then sets the venue. MatchTime remembers the
-- refused ask in this table and, when the venue is set, asks again once and
-- posts the result in the group it was asked in.
--
-- The code tolerates this table being missing: remembering a refusal and
-- retrying both catch the error and log it, and the ask's own reply is
-- unchanged. Until it is applied, nothing is retried.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261028200000_pool_ask_retry/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One NEW table "PoolAskRetry" with two indexes and two
-- foreign keys (to "Organisation" and "Match", ON DELETE CASCADE). No
-- existing row or column is touched; adding a foreign key from a new empty
-- table only briefly locks the referenced tables.
--
-- IDEMPOTENT: IF NOT EXISTS everywhere, constraints dropped and re-added;
-- a second run changes nothing. ONE transaction; there is no session-level
-- SET in this file (SET LOCAL only).
--
-- Verify after applying (expect one row):
--   SELECT to_regclass('"PoolAskRetry"');
--
-- Rolling back (the code treats a missing table as nothing to retry):
--   DROP TABLE IF EXISTS "PoolAskRetry";

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "PoolAskRetry" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "askedByUserId" TEXT NOT NULL,
    "askedIn" TEXT NOT NULL,
    "askMessageId" TEXT,
    "places" INTEGER NOT NULL,
    "refusal" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PoolAskRetry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PoolAskRetry_matchId_refusal_key" ON "PoolAskRetry"("matchId", "refusal");
CREATE INDEX IF NOT EXISTS "PoolAskRetry_orgId_claimedAt_idx" ON "PoolAskRetry"("orgId", "claimedAt");

ALTER TABLE "PoolAskRetry" DROP CONSTRAINT IF EXISTS "PoolAskRetry_orgId_fkey";
ALTER TABLE "PoolAskRetry" ADD CONSTRAINT "PoolAskRetry_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PoolAskRetry" DROP CONSTRAINT IF EXISTS "PoolAskRetry_matchId_fkey";
ALTER TABLE "PoolAskRetry" ADD CONSTRAINT "PoolAskRetry_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
