-- Squad changes typed in a club's admin group (2026-10-14).
-- A squad list pasted in the admin group waits here for an admin's YES.
--
-- HOW TO APPLY (before the code that reads this table is deployed):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261014120000_admin_squad_proposal/migration.sql
--
-- IDEMPOTENT: every statement is IF NOT EXISTS, so it can be run again
-- safely. It is ONE transaction: it either applies whole or not at all.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive: one new, empty table and two indexes on it. It does
-- not touch, lock, rewrite or read any existing table, and changes no
-- query that does not name the new table. No foreign keys, on purpose: a
-- proposal is short-lived (30 minutes) and is only ever read by club and
-- by open state, so a deleted match leaves at most a dead row that nothing
-- reads.
--
-- LOCKING
-- -------
-- CREATE TABLE and CREATE INDEX on a new, empty table lock only that table.
-- `lock_timeout` is set to 5 seconds FOR THIS TRANSACTION ONLY (SET LOCAL,
-- which ends at COMMIT and is safe through a transaction pooler), so the
-- file fails fast rather than queueing if anything unexpected holds a lock.
--
-- Verify after applying (expect 1, then 0):
--   SELECT count(*) FROM information_schema.tables WHERE table_name = 'AdminSquadProposal';
--   SELECT count(*) FROM "AdminSquadProposal";
--
-- Rolling back (only once no deployed code reads the table):
--   DROP TABLE IF EXISTS "AdminSquadProposal";

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "AdminSquadProposal" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "waMessageId" TEXT NOT NULL,
  "proposedByUserId" TEXT NOT NULL,
  "playingUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "playingNewNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "reserveUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "reserveNewNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "outcome" TEXT,
  "resolvedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminSquadProposal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AdminSquadProposal_waMessageId_key" ON "AdminSquadProposal"("waMessageId");
CREATE INDEX IF NOT EXISTS "AdminSquadProposal_orgId_resolvedAt_idx" ON "AdminSquadProposal"("orgId", "resolvedAt");

COMMIT;
