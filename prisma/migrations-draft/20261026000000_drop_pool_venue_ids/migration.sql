-- DRAFT, NOT APPLIED ANYWHERE BUT A LOCAL TEST DB. Needs Kemal's approval:
-- dropping a column is destructive.
--
-- Chosen pitches were retired on 2026-10-25: a pool player's place is only
-- a postcode district and a travel distance (rules.ts PoolArea). The code no
-- longer reads or writes "PoolProfile"."venueIds". This drops it and makes
-- the area CHECK require the district's centre point.
--
-- When approved: move this folder into prisma/migrations, remove the
-- `venueIds` line from prisma/schema.prisma, and change
-- prisma/sql/pool-check.sql's PoolProfile_area_check to the one below.

BEGIN;

-- Refuse to run if any profile would lose its only area.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PoolProfile" WHERE "areaLat" IS NULL) THEN
    RAISE EXCEPTION 'PoolProfile rows with no postcode area exist; place them before dropping venueIds';
  END IF;
END $$;

ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_area_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_area_check"
  CHECK ("areaDistrict" IS NOT NULL AND "areaLat" IS NOT NULL);
ALTER TABLE "PoolProfile" DROP COLUMN IF EXISTS "venueIds";

COMMIT;
