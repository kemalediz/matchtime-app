-- The local player pool, slice L11: drop the seven unused "nearby players"
-- columns on "User" (2026-10-24).
-- Plan: MDs/local-player-pool-plan-2026-10-23.md sections 2, 7 and 8 (L11).
--
-- ============================================================================
-- DESTRUCTIVE. APPLY ONLY WITH KEMAL'S EXPLICIT OK.
-- ============================================================================
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Unlike the additive pool
-- migrations, the ORDER IS THE OTHER WAY ROUND: deploy the code first (it no
-- longer has these fields on the Prisma model, and Prisma ignores columns it
-- does not know, so the live database is safe with the columns still
-- present), then, with Kemal's OK, apply this by hand:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261027090000_drop_discoverable_nearby/migration.sql
--
-- WARNING ON `prisma db push`: this repo manages schema with `db push`. Now
-- that the schema no longer has these fields, a `db push` against prod would
-- propose dropping the same columns (it asks for --accept-data-loss). Do not
-- accept that; apply this reviewed file instead, after the backup below.
--
-- WHAT IT DROPS
-- -------------
--   "User"."discoverableNearby"     BOOLEAN NOT NULL DEFAULT false
--   "User"."discoverableNearbyAt"   TIMESTAMP(3) NULL
--   "User"."discoverableConsentVer" INTEGER NULL
--   "User"."nearbyRadiusKm"         INTEGER NOT NULL DEFAULT 10
--   "User"."homeAreaLabel"          TEXT NULL
--   "User"."homeAreaLat"            DOUBLE PRECISION NULL
--   "User"."homeAreaLng"            DOUBLE PRECISION NULL
-- Added 2026-06-18 (911bc92d) for a cross-club opt-in that was never built.
-- No code under src/ ever read or wrote them. No index, constraint or view
-- uses them (prod, read-only, 2026-10-24: "User" has only User_pkey,
-- User_email_key, User_phoneNumber_key and the user_phone_e164 CHECK;
-- information_schema.view_column_usage has no row for "User").
--
-- PROD COUNTS FOUND (read-only SELECTs, 2026-10-24, 186 users):
--   discoverableNearby = true          0
--   discoverableNearbyAt IS NOT NULL   0
--   discoverableConsentVer NOT NULL    0
--   nearbyRadiusKm <> 10 (default)     0
--   homeAreaLabel NOT NULL             0
--   homeAreaLat NOT NULL               0
--   homeAreaLng NOT NULL               0
-- So the drop loses no data today. Re-run the counts before applying.
--
-- 1. BACKUP FIRST (run, and keep the output, before applying). Expect 0 rows:
--   \copy (SELECT id, "discoverableNearby", "discoverableNearbyAt", "discoverableConsentVer",
--            "nearbyRadiusKm", "homeAreaLabel", "homeAreaLat", "homeAreaLng"
--          FROM "User"
--          WHERE "discoverableNearby" OR "discoverableNearbyAt" IS NOT NULL
--             OR "discoverableConsentVer" IS NOT NULL OR "nearbyRadiusKm" <> 10
--             OR "homeAreaLabel" IS NOT NULL OR "homeAreaLat" IS NOT NULL OR "homeAreaLng" IS NOT NULL)
--     TO 'user-discoverable-nearby-backup.csv' WITH CSV HEADER
--
-- 2. APPLY this file. ONE transaction: it applies whole or not at all.
--    lock_timeout makes a busy "User" table fail fast instead of queueing
--    every query behind the ALTER; if it fails on the lock, nothing changed
--    and it can simply be run again. DROP COLUMN IF EXISTS makes it
--    idempotent. Dropping a column is a catalogue change (no table rewrite).
--    There is no session-level SET in this file.
--
-- 3. VERIFY (expect 0 rows):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'User' AND column_name IN ('discoverableNearby', 'discoverableNearbyAt',
--      'discoverableConsentVer', 'nearbyRadiusKm', 'homeAreaLabel', 'homeAreaLat', 'homeAreaLng');
--
-- ROLLBACK (the columns come back empty, with their old defaults; any data
-- is restorable ONLY from the step-1 backup):
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   ALTER TABLE "User"
--     ADD COLUMN IF NOT EXISTS "discoverableNearby"     BOOLEAN NOT NULL DEFAULT false,
--     ADD COLUMN IF NOT EXISTS "discoverableNearbyAt"   TIMESTAMP(3),
--     ADD COLUMN IF NOT EXISTS "discoverableConsentVer" INTEGER,
--     ADD COLUMN IF NOT EXISTS "nearbyRadiusKm"         INTEGER NOT NULL DEFAULT 10,
--     ADD COLUMN IF NOT EXISTS "homeAreaLabel"          TEXT,
--     ADD COLUMN IF NOT EXISTS "homeAreaLat"            DOUBLE PRECISION,
--     ADD COLUMN IF NOT EXISTS "homeAreaLng"            DOUBLE PRECISION;
--   COMMIT;
--   (then reload rows from the backup CSV, and restore the fields in
--   prisma/schema.prisma from git if the code needs them again)

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "User"
  DROP COLUMN IF EXISTS "discoverableNearby",
  DROP COLUMN IF EXISTS "discoverableNearbyAt",
  DROP COLUMN IF EXISTS "discoverableConsentVer",
  DROP COLUMN IF EXISTS "nearbyRadiusKm",
  DROP COLUMN IF EXISTS "homeAreaLabel",
  DROP COLUMN IF EXISTS "homeAreaLat",
  DROP COLUMN IF EXISTS "homeAreaLng";

COMMIT;
