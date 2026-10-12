-- Venue location: where each weekly game is played (2026-10-12).
--
-- HOW TO APPLY (before the code that reads these columns is deployed):
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261012150000_venue_location/migration.sql
--
-- IDEMPOTENT: every statement is IF NOT EXISTS (the one foreign key is
-- added only when it is missing), so it can be run again safely. It is
-- ONE transaction: it either applies whole or not at all.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   * Six NULLABLE columns on "Activity", with no default: a catalog-only
--     change, no table rewrite, and every existing row reads NULL in all
--     six. Nothing changes for an existing activity until its venue is
--     looked up.
--   * One index on "Activity"."venueQueryKey". "Activity" holds one row
--     per weekly game (tens of rows), so the build is instant. It is a
--     plain CREATE INDEX, not CONCURRENTLY, because CONCURRENTLY cannot
--     run inside a transaction; on a table this small the difference is
--     not measurable.
--   * One NEW table, "VenueLookup" (the per-club daily cap counts its
--     rows), with its index and a foreign key to "Organisation".
--
-- It does NOT drop, rename or rewrite anything, updates no row, and
-- changes no query that does not name the new columns.
--
-- LOCKING
-- -------
-- ALTER TABLE takes an ACCESS EXCLUSIVE lock on "Activity" for the length
-- of this transaction; CREATE INDEX then needs only a SHARE lock on it.
-- Adding the foreign key takes a SHARE ROW EXCLUSIVE lock on
-- "Organisation" (reads and row writes carry on; it validates against an
-- empty new table, so there is nothing to scan). All of it is
-- milliseconds.
--
-- `lock_timeout` is 5 seconds FOR THIS TRANSACTION ONLY (SET LOCAL, which
-- ends at COMMIT and is safe through a transaction pooler). There is no
-- session-level SET anywhere in this file. If a long-running transaction
-- holds one of the two tables, the file fails after 5 seconds with
-- "canceling statement due to lock timeout" and changes nothing. Run it
-- again.
--
-- Verify after applying (expect 6, then 1, then 0):
--   SELECT count(*) FROM information_schema.columns WHERE table_name = 'Activity'
--     AND column_name IN ('venueConfidence','venueMatchSource','venueQueryKey',
--                         'venueResolvedAt','venueConfirmedAt','venueConfirmedById');
--   SELECT count(*) FROM information_schema.tables WHERE table_name = 'VenueLookup';
--   SELECT count(*) FROM "Activity" WHERE "venueConfidence" IS NOT NULL;
--
-- Rolling back (only once no deployed code reads the columns):
--   DROP TABLE IF EXISTS "VenueLookup";
--   DROP INDEX IF EXISTS "Activity_venueQueryKey_idx";
--   ALTER TABLE "Activity" DROP COLUMN IF EXISTS "venueConfidence",
--     DROP COLUMN IF EXISTS "venueMatchSource", DROP COLUMN IF EXISTS "venueQueryKey",
--     DROP COLUMN IF EXISTS "venueResolvedAt", DROP COLUMN IF EXISTS "venueConfirmedAt",
--     DROP COLUMN IF EXISTS "venueConfirmedById";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL for production.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "Activity"
  ADD COLUMN IF NOT EXISTS "venueConfidence"    TEXT,
  ADD COLUMN IF NOT EXISTS "venueMatchSource"   TEXT,
  ADD COLUMN IF NOT EXISTS "venueQueryKey"      TEXT,
  ADD COLUMN IF NOT EXISTS "venueResolvedAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "venueConfirmedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "venueConfirmedById" TEXT;

CREATE INDEX IF NOT EXISTS "Activity_venueQueryKey_idx" ON "Activity" ("venueQueryKey");

CREATE TABLE IF NOT EXISTS "VenueLookup" (
  "id"         TEXT NOT NULL,
  "orgId"      TEXT NOT NULL,
  "activityId" TEXT,
  "kind"       TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VenueLookup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VenueLookup_orgId_createdAt_idx" ON "VenueLookup" ("orgId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VenueLookup_orgId_fkey') THEN
    ALTER TABLE "VenueLookup"
      ADD CONSTRAINT "VenueLookup_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "Organisation" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

COMMIT;
