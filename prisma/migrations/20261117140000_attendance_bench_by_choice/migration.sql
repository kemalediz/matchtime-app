-- On the bench BY CHOICE (2026-11-17, src/lib/bench-fill.ts). The bench now
-- fills an open place by itself in a first-come club; a player who chose
-- the bench while a place was his is never moved up by it. Recorded as a
-- column rather than read from AttendanceEvent.note, because callers with
-- their own notes (pasted lists) would otherwise be missed.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261117140000_attendance_bench_by_choice/migration.sql
--
-- RUN BEFORE THE DEPLOY: Prisma selects every column of "Attendance", so
-- code that knows the column must not reach a database without it.
-- Additive and idempotent.

ALTER TABLE "Attendance" ADD COLUMN IF NOT EXISTS "benchByChoice" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: a player on the bench today whose last move onto it was an
-- explicit request FROM the squad (he or an admin took him out on purpose).
UPDATE "Attendance" a
   SET "benchByChoice" = true
 WHERE a.status = 'BENCH'
   AND EXISTS (
     SELECT 1 FROM (
       SELECT e."fromStatus", e.note
         FROM "AttendanceEvent" e
        WHERE e."matchId" = a."matchId" AND e."userId" = a."userId" AND e."toStatus" = 'BENCH'
        ORDER BY e.at DESC
        LIMIT 1
     ) last
     WHERE last.note LIKE 'explicit bench request%' AND last."fromStatus" = 'CONFIRMED'
   );
