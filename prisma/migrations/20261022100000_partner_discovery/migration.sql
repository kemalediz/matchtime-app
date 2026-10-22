-- Finding partner clubs nearby (partner discovery), slice P1, 2026-10-22.
-- Plan: MDs/partner-discovery-plan-2026-10-21.md, section 6.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- Organisation, ClubPartnership and Venue column on queries without a
-- `select`, so code that knows the new columns fails against a database
-- without them.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261022100000_partner_discovery/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. The PartnerAsk changes of section 6 are NOT here
-- (another slice owns PartnerAsk).
--   * Six columns on "Organisation":
--       "discoverable" BOOLEAN NOT NULL DEFAULT true   every existing club
--                                                      reads as ON at once
--                                                      (Kemal, 2026-10-22)
--       "discoverableAt" TIMESTAMP NULL, "discoverableById" TEXT NULL
--       "autoAcceptPartnerRequests" BOOLEAN NOT NULL DEFAULT false
--       "homeVenueId" TEXT NULL, FK to "Venue" ON DELETE SET NULL
--       "venueReminderSentAt" TIMESTAMP NULL           the weekly venue DM's
--                                                      claim (not in the
--                                                      plan's list; needed so
--                                                      two runs never both send)
--     Constant defaults: Postgres fills every existing row as the column is
--     added (no table rewrite on PG 11+).
--   * Five columns on "ClubPartnership": "origin" TEXT NOT NULL DEFAULT
--     'owner' (both live pairings were made by the platform owner, so
--     'owner' is true of them), "expiresAt", "endedAt", "endedByOrgId",
--     "endReason" (all NULL), and an index on ("askerOrgId", "status").
--   * One new, empty table "ClubBlock" with its unique pair, its index and
--     foreign keys (ON DELETE CASCADE from both clubs).
--   * An index on "Venue" ("lat", "lng") for the nearby search.
--   * Three CHECK constraints, as in prisma/sql/partner-ask-check.sql:
--     "origin" and "endReason" are one of their values, and a club never
--     blocks itself.
--
-- It drops, renames and rewrites nothing. No row changes.
--
-- IDEMPOTENT: every column, table and index is IF NOT EXISTS and every
-- constraint is dropped if present before it is added. ONE transaction:
-- it applies whole or not at all. lock_timeout makes a busy table fail fast
-- instead of queueing every query behind the ALTER; if it fails on the
-- lock, nothing was changed and it can simply be run again. There is no
-- session-level SET in this file.
--
-- Verify after applying (expect 6 rows, then 5 rows, then 1 row, then 0, 0):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'Organisation' AND column_name IN ('discoverable',
--      'discoverableAt', 'discoverableById', 'autoAcceptPartnerRequests',
--      'homeVenueId', 'venueReminderSentAt');
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'ClubPartnership' AND column_name IN ('origin',
--      'expiresAt', 'endedAt', 'endedByOrgId', 'endReason');
--   SELECT table_name FROM information_schema.tables WHERE table_name = 'ClubBlock';
--   SELECT count(*) FROM "Organisation" WHERE NOT "discoverable" OR "autoAcceptPartnerRequests";
--   SELECT count(*) FROM "ClubPartnership" WHERE "origin" <> 'owner';
--
-- Rolling back (after the code that reads them is no longer deployed):
--   DROP TABLE IF EXISTS "ClubBlock";  -- its CHECK goes with it
--   DROP INDEX IF EXISTS "Venue_lat_lng_idx";
--   DROP INDEX IF EXISTS "ClubPartnership_askerOrgId_status_idx";
--   ALTER TABLE "ClubPartnership" DROP CONSTRAINT IF EXISTS "ClubPartnership_origin_check",
--     DROP CONSTRAINT IF EXISTS "ClubPartnership_endReason_check";
--   ALTER TABLE "ClubPartnership" DROP COLUMN IF EXISTS "origin", DROP COLUMN IF EXISTS "expiresAt",
--     DROP COLUMN IF EXISTS "endedAt", DROP COLUMN IF EXISTS "endedByOrgId", DROP COLUMN IF EXISTS "endReason";
--   DROP INDEX IF EXISTS "Organisation_homeVenueId_idx";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_homeVenueId_fkey";
--   ALTER TABLE "Organisation" DROP COLUMN IF EXISTS "discoverable", DROP COLUMN IF EXISTS "discoverableAt",
--     DROP COLUMN IF EXISTS "discoverableById", DROP COLUMN IF EXISTS "autoAcceptPartnerRequests",
--     DROP COLUMN IF EXISTS "homeVenueId", DROP COLUMN IF EXISTS "venueReminderSentAt";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. `db push` adds the same columns,
-- table and indexes but never the CHECK constraints: after any `db push`,
-- run prisma/sql/partner-ask-check.sql.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Organisation
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "discoverable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "discoverableAt" TIMESTAMP(3);
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "discoverableById" TEXT;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "autoAcceptPartnerRequests" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "homeVenueId" TEXT;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "venueReminderSentAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Organisation_homeVenueId_idx" ON "Organisation"("homeVenueId");
ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_homeVenueId_fkey";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_homeVenueId_fkey"
  FOREIGN KEY ("homeVenueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ClubPartnership
ALTER TABLE "ClubPartnership" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE "ClubPartnership" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "ClubPartnership" ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMP(3);
ALTER TABLE "ClubPartnership" ADD COLUMN IF NOT EXISTS "endedByOrgId" TEXT;
ALTER TABLE "ClubPartnership" ADD COLUMN IF NOT EXISTS "endReason" TEXT;
CREATE INDEX IF NOT EXISTS "ClubPartnership_askerOrgId_status_idx" ON "ClubPartnership"("askerOrgId", "status");

-- ClubBlock
CREATE TABLE IF NOT EXISTS "ClubBlock" (
  "id" TEXT NOT NULL,
  "blockerOrgId" TEXT NOT NULL,
  "blockedOrgId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClubBlock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ClubBlock_blockerOrgId_blockedOrgId_key" ON "ClubBlock"("blockerOrgId", "blockedOrgId");
CREATE INDEX IF NOT EXISTS "ClubBlock_blockedOrgId_idx" ON "ClubBlock"("blockedOrgId");
ALTER TABLE "ClubBlock" DROP CONSTRAINT IF EXISTS "ClubBlock_blockerOrgId_fkey";
ALTER TABLE "ClubBlock" ADD CONSTRAINT "ClubBlock_blockerOrgId_fkey"
  FOREIGN KEY ("blockerOrgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClubBlock" DROP CONSTRAINT IF EXISTS "ClubBlock_blockedOrgId_fkey";
ALTER TABLE "ClubBlock" ADD CONSTRAINT "ClubBlock_blockedOrgId_fkey"
  FOREIGN KEY ("blockedOrgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Venue
CREATE INDEX IF NOT EXISTS "Venue_lat_lng_idx" ON "Venue"("lat", "lng");

-- The CHECK constraints, as in prisma/sql/partner-ask-check.sql.
ALTER TABLE "ClubPartnership" DROP CONSTRAINT IF EXISTS "ClubPartnership_origin_check";
ALTER TABLE "ClubPartnership" ADD CONSTRAINT "ClubPartnership_origin_check"
  CHECK ("origin" IN ('owner', 'request'));
ALTER TABLE "ClubPartnership" DROP CONSTRAINT IF EXISTS "ClubPartnership_endReason_check";
ALTER TABLE "ClubPartnership" ADD CONSTRAINT "ClubPartnership_endReason_check"
  CHECK ("endReason" IS NULL OR "endReason" IN ('declined', 'withdrawn', 'ended', 'expired', 'blocked'));
ALTER TABLE "ClubBlock" DROP CONSTRAINT IF EXISTS "ClubBlock_two_clubs_check";
ALTER TABLE "ClubBlock" ADD CONSTRAINT "ClubBlock_two_clubs_check"
  CHECK ("blockerOrgId" <> "blockedOrgId");

COMMIT;
