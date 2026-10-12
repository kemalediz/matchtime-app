-- Venue location: where each weekly game is played (2026-10-12).
--
-- HOW TO APPLY (before the code that reads these columns is deployed):
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261012150000_venue_location/migration.sql
--
-- IDEMPOTENT: every statement is IF NOT EXISTS (each foreign key is added
-- only when it is missing), so it can be run again safely. It is ONE
-- transaction: it either applies whole or not at all.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   * Six NULLABLE columns on "Activity", with no default: a catalog-only
--     change, no table rewrite, and every existing row reads NULL in all
--     six. NULL in "venueLookupStatus" means "never looked up", which is
--     what every existing weekly game is, and the page says so in a
--     neutral line (it does not say "not found").
--   * Two NEW tables, both empty:
--       "VenueLookup"  one row per lookup a club caused; the per-club
--                      daily cap counts them. Foreign key to "Organisation".
--       "VenueQuery"   what Google answered for a query (country plus
--                      normalised words) : the place and how sure. Written
--                      only by the lookup code. Foreign key to "Venue".
--     and their indexes.
--
-- It does NOT drop, rename or rewrite anything, updates no row, and
-- changes no query that does not name the new columns.
--
-- CHANGED IN REVIEW (PR #241): the first version of this file added
-- "Activity"."venueQueryKey" and an index on it. Both are gone: the
-- query-to-place mapping lives in "VenueQuery" now, so no club's lookup
-- ever reads another club's "Activity" row. If that first version was
-- applied anywhere, the column and index are unused and harmless; remove
-- them at leisure with
--   DROP INDEX IF EXISTS "Activity_venueQueryKey_idx";
--   ALTER TABLE "Activity" DROP COLUMN IF EXISTS "venueQueryKey";
-- (not done here: this file only ever adds).
--
-- LOCKING
-- -------
-- ALTER TABLE takes an ACCESS EXCLUSIVE lock on "Activity" for the length
-- of this transaction. Adding a foreign key takes a SHARE ROW EXCLUSIVE
-- lock on the table it points at ("Organisation", "Venue": reads and row
-- writes carry on) and validates against an empty new table, so there is
-- nothing to scan. All of it is milliseconds.
--
-- `lock_timeout` is 5 seconds FOR THIS TRANSACTION ONLY (SET LOCAL, which
-- ends at COMMIT and is safe through a transaction pooler). There is no
-- session-level SET anywhere in this file. If a long-running transaction
-- holds one of the tables, the file fails after 5 seconds with
-- "canceling statement due to lock timeout" and changes nothing. Run it
-- again.
--
-- Verify after applying (expect 6, then 2, then 0):
--   SELECT count(*) FROM information_schema.columns WHERE table_name = 'Activity'
--     AND column_name IN ('venueConfidence','venueMatchSource','venueLookupStatus',
--                         'venueResolvedAt','venueConfirmedAt','venueConfirmedById');
--   SELECT count(*) FROM information_schema.tables WHERE table_name IN ('VenueLookup','VenueQuery');
--   SELECT count(*) FROM "Activity" WHERE "venueLookupStatus" IS NOT NULL;
--
-- Rolling back (only once no deployed code reads the columns):
--   DROP TABLE IF EXISTS "VenueQuery";
--   DROP TABLE IF EXISTS "VenueLookup";
--   ALTER TABLE "Activity" DROP COLUMN IF EXISTS "venueConfidence",
--     DROP COLUMN IF EXISTS "venueMatchSource", DROP COLUMN IF EXISTS "venueLookupStatus",
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
  ADD COLUMN IF NOT EXISTS "venueLookupStatus"  TEXT,
  ADD COLUMN IF NOT EXISTS "venueResolvedAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "venueConfirmedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "venueConfirmedById" TEXT;

CREATE TABLE IF NOT EXISTS "VenueLookup" (
  "id"         TEXT NOT NULL,
  "orgId"      TEXT NOT NULL,
  "activityId" TEXT,
  "kind"       TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VenueLookup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VenueLookup_orgId_createdAt_idx" ON "VenueLookup" ("orgId", "createdAt");

CREATE TABLE IF NOT EXISTS "VenueQuery" (
  "key"        TEXT NOT NULL,
  "venueId"    TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VenueQuery_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "VenueQuery_venueId_idx" ON "VenueQuery" ("venueId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VenueLookup_orgId_fkey') THEN
    ALTER TABLE "VenueLookup"
      ADD CONSTRAINT "VenueLookup_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "Organisation" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VenueQuery_venueId_fkey') THEN
    ALTER TABLE "VenueQuery"
      ADD CONSTRAINT "VenueQuery_venueId_fkey"
      FOREIGN KEY ("venueId") REFERENCES "Venue" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

COMMIT;
