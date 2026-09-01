-- The append-only guarantee for "AttendanceEvent" (2026-09-01).
--
-- The value of this table is that it is the one thing in the system that
-- cannot be rewritten. That has to be enforced by the database, not by
-- convention: a log an application can quietly correct is not evidence,
-- and this one is the evidence §10 step 6 of the analyzer redesign turns
-- on.
--
-- UPDATE and DELETE are refused. TRUNCATE is deliberately NOT — the e2e
-- fixture world resets with `TRUNCATE … CASCADE` (e2e/helpers/seed.ts)
-- and a throwaway test database is not an audit trail. A row-level
-- BEFORE trigger does not fire on TRUNCATE, so that falls out of the
-- design rather than being a hole someone left.
--
-- IDEMPOTENT: safe to run repeatedly. Applied to production by
-- prisma/migrations/20260901120000_attendance_event_log/migration.sql
-- and to the e2e database by e2e/run.ts after `prisma db push` (db push
-- creates tables and columns, never triggers).

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
