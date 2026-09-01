-- The COVERAGE gate: an attendance write with no event fails.
--
-- ─────────────────────────────────────────────────────────────────────
-- TEST DATABASES ONLY. THIS IS NOT IN THE PRODUCTION MIGRATION.
-- ─────────────────────────────────────────────────────────────────────
-- Applied by e2e/run.ts after `prisma db push`, so the whole e2e suite
-- runs with it armed and a writer that forgets to log FAILS A TEST. It
-- is deliberately NOT part of
-- prisma/migrations/20260901120000_attendance_event_log/migration.sql,
-- because arming it in production would turn "a writer we missed" from
-- a gap in an audit log into a thrown registration — a live behaviour
-- change, in the write path, in the PR whose whole premise is that it
-- changes no behaviour. Whether to arm it in production later is a
-- decision with its own risk, and it should be taken on its own.
--
-- ─────────────────────────────────────────────────────────────────────
-- WHY A DEFERRED CONSTRAINT TRIGGER
-- ─────────────────────────────────────────────────────────────────────
-- The event is written AFTER the attendance row inside the same
-- transaction, so an ordinary AFTER trigger would fire too early and
-- reject every legitimate write. A `CONSTRAINT TRIGGER … DEFERRABLE
-- INITIALLY DEFERRED` runs at COMMIT, by which time both statements
-- have happened — which is exactly the property being asserted: not
-- "an event exists somewhere" but "an event was written by the same
-- transaction". `AttendanceEvent."txId"` (DEFAULT txid_current()) is
-- what makes that checkable.
--
-- It fires only when the SQUAD PLACE changed. Payment metadata
-- (`paidAt`, `stripeSessionId`, `paymentMethod` …) is written against
-- Attendance rows constantly and is not a squad place; requiring an
-- event for those would fill the log with noise and break the payment
-- path for nothing.
--
-- IDEMPOTENT: safe to run repeatedly.

CREATE OR REPLACE FUNCTION attendance_requires_event()
RETURNS TRIGGER AS $$
DECLARE
  target_match TEXT;
  target_user  TEXT;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    target_match := OLD."matchId";
    target_user  := OLD."userId";
    -- A CASCADE from deleting the Match is not a squad decision, it is
    -- the match ceasing to exist. `Attendance.matchId` is ON DELETE
    -- CASCADE, and by commit time the parent row is gone — which is how
    -- we tell that case apart from an application deleting one player's
    -- place. Demanding an event per row there would make deleting a
    -- match impossible.
    IF NOT EXISTS (SELECT 1 FROM "Match" m WHERE m.id = target_match) THEN
      RETURN NULL;
    END IF;
  ELSE
    target_match := NEW."matchId";
    target_user  := NEW."userId";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "AttendanceEvent" e
     WHERE e."matchId" = target_match
       AND e."userId"  = target_user
       AND e."txId"    = txid_current()::text
  ) THEN
    RAISE EXCEPTION
      'attendance % on (match=%, user=%) wrote no AttendanceEvent in the same transaction. Route the write through src/lib/attendance-events.ts.',
      TG_OP, target_match, target_user
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS attendance_requires_event_ins ON "Attendance";
CREATE CONSTRAINT TRIGGER attendance_requires_event_ins
  AFTER INSERT ON "Attendance"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION attendance_requires_event();

DROP TRIGGER IF EXISTS attendance_requires_event_upd ON "Attendance";
CREATE CONSTRAINT TRIGGER attendance_requires_event_upd
  AFTER UPDATE ON "Attendance"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD."userId" IS DISTINCT FROM NEW."userId"
    OR OLD.position IS DISTINCT FROM NEW.position
  )
  EXECUTE FUNCTION attendance_requires_event();

DROP TRIGGER IF EXISTS attendance_requires_event_del ON "Attendance";
CREATE CONSTRAINT TRIGGER attendance_requires_event_del
  AFTER DELETE ON "Attendance"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION attendance_requires_event();
