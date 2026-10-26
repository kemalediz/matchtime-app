-- The local player pool: drop the unused "PoolProfile"."venueIds" column and
-- make the area CHECK require the district and its centre point.
--
-- ============================================================================
-- DESTRUCTIVE. APPROVED BY KEMAL ON 26 OCTOBER 2026.
-- ============================================================================
--
-- Chosen pitches were retired on 2026-10-25 (#423): a pool player's place is
-- only a postcode district and a travel distance (rules.ts PoolArea). The code
-- no longer reads or writes "PoolProfile"."venueIds".
--
-- APPLIED BY HAND, AFTER THE DEPLOY THAT REMOVES THE FIELD. The pull request
-- that added this file removes `venueIds` from prisma/schema.prisma. Prisma
-- selects every column it knows by name, so dropping the column while the
-- deployed client still has the field would break every PoolProfile read.
-- Deploy first (Prisma ignores a column it does not know), then apply:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261028000000_drop_pool_venue_ids/migration.sql
--
-- WARNING ON `prisma db push`: this repo manages schema with `db push`. Now
-- that the schema no longer has the field, a `db push` against prod would
-- propose dropping the same column (it asks for --accept-data-loss). Do not
-- accept that; apply this reviewed file instead.
--
-- The same CHECK is in prisma/sql/pool-check.sql (the e2e database and any
-- re-run). Every path that creates a profile (signup.ts, member-optin.ts)
-- places the district with profile-store.ts resolveArea before it inserts,
-- and the manage page's edit does the same before it updates, so a profile
-- always has "areaDistrict" and "areaLat".
--
-- IDEMPOTENT: the guard, DROP CONSTRAINT IF EXISTS and DROP COLUMN IF EXISTS
-- make a re-run a no-op.

BEGIN;

-- Refuse to run if any profile has no placed postcode area (the new CHECK
-- would reject it).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PoolProfile" WHERE "areaDistrict" IS NULL OR "areaLat" IS NULL) THEN
    RAISE EXCEPTION 'PoolProfile rows with no postcode area exist; place them before dropping venueIds';
  END IF;
END $$;

ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_area_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_area_check"
  CHECK ("areaDistrict" IS NOT NULL AND "areaLat" IS NOT NULL);
ALTER TABLE "PoolProfile" DROP COLUMN IF EXISTS "venueIds";

COMMIT;
