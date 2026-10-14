-- Teams proposed and approved in a club's admin group (2026-10-14).
-- One club setting ("Teams ready": a London time on match day, or "off")
-- and one table holding the proposal per match.
--
-- HOW TO APPLY (before the code that reads these is deployed):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261014150000_admin_team_proposal/migration.sql
--
-- IDEMPOTENT: every statement is IF NOT EXISTS, so it can be run again
-- safely. It is ONE transaction: it either applies whole or not at all.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- 1. "Organisation"."teamsReadyTime": a new TEXT column with a constant
--    default ('10:00'). On Postgres 11 and later adding a column with a
--    constant default is a catalogue change only: no table rewrite, and
--    every existing club reads '10:00'. The code reads it only for a live
--    weekly club with a linked admin group, so no other club sees any
--    change.
-- 2. "AdminTeamProposal": one new, empty table and two indexes on it. No
--    foreign keys, on purpose (as "AdminSquadProposal"): a proposal is
--    read only by club and by match, and a deleted match leaves at most a
--    dead row nothing reads.
--
-- LOCKING
-- -------
-- ALTER TABLE ... ADD COLUMN takes a brief ACCESS EXCLUSIVE lock on
-- "Organisation" (no rewrite, so it is held for milliseconds). CREATE
-- TABLE and CREATE INDEX on a new, empty table lock only that table.
-- `lock_timeout` is 5 seconds FOR THIS TRANSACTION ONLY (SET LOCAL, which
-- ends at COMMIT and is safe through a transaction pooler), so the file
-- fails fast rather than queueing behind a long query.
--
-- Verify after applying (expect 1, 1, then 0):
--   SELECT count(*) FROM information_schema.columns WHERE table_name = 'Organisation' AND column_name = 'teamsReadyTime';
--   SELECT count(*) FROM information_schema.tables WHERE table_name = 'AdminTeamProposal';
--   SELECT count(*) FROM "AdminTeamProposal";
--
-- Rolling back (only once no deployed code reads them):
--   DROP TABLE IF EXISTS "AdminTeamProposal";
--   ALTER TABLE "Organisation" DROP COLUMN IF EXISTS "teamsReadyTime";

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "teamsReadyTime" TEXT NOT NULL DEFAULT '10:00';

CREATE TABLE IF NOT EXISTS "AdminTeamProposal" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'proposed',
  "askedAt" TIMESTAMP(3) NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "approvedByUserId" TEXT,
  "toldSheet" JSONB,
  "remindedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminTeamProposal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AdminTeamProposal_matchId_key" ON "AdminTeamProposal"("matchId");
CREATE INDEX IF NOT EXISTS "AdminTeamProposal_orgId_state_idx" ON "AdminTeamProposal"("orgId", "state");

COMMIT;
