-- Free places (2026-10-16): a player's fee for one match can be waived.
-- See src/lib/fee-waiver.ts and src/lib/fee-waiver-rules.ts.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- Attendance column on queries without a `select`, so code that knows the
-- new columns fails against a database that does not have them yet.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261016200000_fee_waiver/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   1. Three NULLABLE columns on "Attendance", with no default:
--      "feeWaivedAt" TIMESTAMP(3), "feeWaivedReason" TEXT,
--      "feeWaivedByUserId" TEXT. Adding a nullable column with no default
--      is a catalogue change only (no table rewrite).
--   2. One new, empty table "AdminFeeProposal" (a free place asked for in
--      the admin group, waiting for YES), with its unique and plain index.
-- The columns are NULL on every existing row: nobody has a free place, so
-- every club, Sutton FC (cmnnwhdx30000zfr85q18lyy9) and FNF included,
-- behaves exactly as today. The FNF stopgap rows (#299, marked "received"
-- on /collect) stay paid (Kemal, decision b).
--
-- It drops, renames and rewrites nothing. No index on the new columns:
-- every reader already loads the match's attendances by "matchId".
--
-- IDEMPOTENT: ADD COLUMN, CREATE TABLE and CREATE INDEX are all IF NOT
-- EXISTS, a no-op on a second run. ONE transaction: it applies whole or not at all. lock_timeout makes a busy
-- table fail fast instead of queueing every query behind the ALTER; if it
-- fails on the lock nothing was changed and it can simply be run again.
-- There is no session-level SET in this file.
--
-- Verify after applying (expect 3 rows, then 0, then 0):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'Attendance' AND column_name LIKE 'feeWaived%';
--   SELECT count(*) FROM "Attendance" WHERE "feeWaivedAt" IS NOT NULL;
--   SELECT count(*) FROM "AdminFeeProposal";
--
-- Rolling back (after the code that reads them is no longer deployed):
--   DROP TABLE IF EXISTS "AdminFeeProposal";
--   ALTER TABLE "Attendance" DROP COLUMN IF EXISTS "feeWaivedAt",
--     DROP COLUMN IF EXISTS "feeWaivedReason", DROP COLUMN IF EXISTS "feeWaivedByUserId";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. `db push` would add the
-- same columns and table, but apply this file on production.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Attendance"
  ADD COLUMN IF NOT EXISTS "feeWaivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "feeWaivedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "feeWaivedByUserId" TEXT;

-- A free place asked for in the admin group, waiting for an organiser's
-- YES (fee-waiver.ts proposeFeeFreeInHq / answerFeeProposalYes). New and
-- empty; the same shape as "AdminSquadProposal".
CREATE TABLE IF NOT EXISTS "AdminFeeProposal" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "waMessageId" TEXT NOT NULL,
  "proposedByUserId" TEXT NOT NULL,
  "userIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "undo" BOOLEAN NOT NULL DEFAULT false,
  "text" TEXT NOT NULL DEFAULT '',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "outcome" TEXT,
  "resolvedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminFeeProposal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AdminFeeProposal_waMessageId_key" ON "AdminFeeProposal"("waMessageId");
CREATE INDEX IF NOT EXISTS "AdminFeeProposal_orgId_resolvedAt_idx" ON "AdminFeeProposal"("orgId", "resolvedAt");

COMMIT;
