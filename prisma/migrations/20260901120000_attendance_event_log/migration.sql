-- Append-only attendance event log + AnalyzedMessage.batchId (2026-09-01).
--
-- WHAT THIS IS FOR
-- ----------------
-- `Attendance` records what a squad IS. Nothing recorded what it WAS, so
-- `e2e/replay/` can replay only 447 of 1,723 real production messages:
-- 1,149 are excluded as `attendance-state-unknown` (a row that existed
-- before a batch and was touched after it has an unknowable status AT
-- that instant), and 104 as `batch-boundary-ambiguous` (batches were
-- recovered from write timing because no batch id was stored). That
-- harness is the evidence base for §10 step 6 of
-- MDs/analyzer-redesign-2026-08-31.md — the change that can put a player
-- at a pitch with no slot.
--
-- Neither half recovers a single historical message. Both stop the gap
-- growing.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive:
--   1. CREATE TABLE "AttendanceEvent"    — new, empty, no foreign keys.
--   2. five indexes on it                — on a new empty table.
--   3. ALTER TABLE "AnalyzedMessage" ADD COLUMN "batchId" TEXT
--      — NULLABLE with no default, so Postgres 11+ does a catalog-only
--        change: no table rewrite, no row locks beyond a brief
--        ACCESS EXCLUSIVE on the ALTER itself, milliseconds on 1,723
--        rows.
--   4. one index on that column.
--   5. two triggers enforcing append-only on "AttendanceEvent".
--
-- It does NOT: rewrite a row, backfill anything, drop or rename
-- anything, add a constraint to an existing table, or change any
-- behaviour. Every existing row is untouched and every existing query
-- keeps working — `AnalyzedMessage` gains one nullable column that
-- nothing branches on.
--
-- Rolling back is `DROP TABLE "AttendanceEvent"` +
-- `ALTER TABLE "AnalyzedMessage" DROP COLUMN "batchId"`, with no data
-- loss outside the new table.
--
-- NOTE ON APPLYING: this repo historically manages schema with
-- `prisma db push` (there is no full migration history — see
-- prisma.config.ts, and the same note on the two prior migrations).
-- This file is the canonical, reviewable DDL. Apply it either by
-- running this SQL directly, or with
-- `npx tsx scripts/apply-attendance-event-migration.ts --apply`
-- (idempotent, prints before/after, guarded so a re-run is a no-op).
-- `prisma db push` alone would create the table and the column but NOT
-- the append-only triggers, which are the point.

-- CreateTable
CREATE TABLE "AttendanceEvent" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "fromStatus" "AttendanceStatus",
    "toStatus" "AttendanceStatus",
    "fromPosition" INTEGER,
    "toPosition" INTEGER,
    "cause" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "sourceRef" TEXT,
    "note" TEXT,
    -- Filled by the DATABASE, never the application: it is what lets a
    -- reader group the events of one atomic change (a format switch
    -- recuts a whole squad at once) and what the e2e coverage gate uses
    -- to prove a write and its event shared a transaction.
    "txId" TEXT DEFAULT txid_current()::text,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceEvent_pkey" PRIMARY KEY ("id")
);

-- NO FOREIGN KEYS, DELIBERATELY. An FK carries a referential action and
-- every honest choice is wrong for a log: CASCADE deletes history when a
-- match or a merged-away user is removed (Attendance is ON DELETE
-- CASCADE from Match), RESTRICT makes the log block ordinary deletes.
-- `UserMerge.oldUserId` sets the same precedent for the same reason — a
-- record of what happened has to outlive the row it describes.

-- CreateIndex
CREATE INDEX "AttendanceEvent_matchId_at_idx" ON "AttendanceEvent"("matchId", "at");
CREATE INDEX "AttendanceEvent_matchId_userId_at_idx" ON "AttendanceEvent"("matchId", "userId", "at");
CREATE INDEX "AttendanceEvent_orgId_at_idx" ON "AttendanceEvent"("orgId", "at");
CREATE INDEX "AttendanceEvent_userId_at_idx" ON "AttendanceEvent"("userId", "at");
CREATE INDEX "AttendanceEvent_txId_idx" ON "AttendanceEvent"("txId");

-- AlterTable (additive, nullable, no default — catalog-only, no rewrite)
ALTER TABLE "AnalyzedMessage" ADD COLUMN "batchId" TEXT;

-- CreateIndex
CREATE INDEX "AnalyzedMessage_batchId_idx" ON "AnalyzedMessage"("batchId");

-- ── The append-only guarantee ────────────────────────────────────────
-- Kept in prisma/sql/attendance-event-append-only.sql as well, because
-- `prisma db push` (how the e2e database is built) creates tables and
-- columns but never triggers, so the test harness applies that file
-- directly. The two are identical; change both.

CREATE OR REPLACE FUNCTION attendance_event_no_mutate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '"AttendanceEvent" is append-only: % is not permitted. Record a new event instead.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS attendance_event_no_update ON "AttendanceEvent";
CREATE TRIGGER attendance_event_no_update
  BEFORE UPDATE ON "AttendanceEvent"
  FOR EACH ROW EXECUTE FUNCTION attendance_event_no_mutate();

DROP TRIGGER IF EXISTS attendance_event_no_delete ON "AttendanceEvent";
CREATE TRIGGER attendance_event_no_delete
  BEFORE DELETE ON "AttendanceEvent"
  FOR EACH ROW EXECUTE FUNCTION attendance_event_no_mutate();

-- TRUNCATE is deliberately NOT blocked: a row-level BEFORE trigger does
-- not fire on TRUNCATE, and the e2e fixture world resets that way. A
-- throwaway test database is not an audit trail; production is, and
-- nothing in the application ever issues a TRUNCATE.
