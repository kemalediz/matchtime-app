-- A club's own graphics template (2026-10-14).
-- See src/lib/club-graphics-template.ts and src/lib/club-graphics-layout.ts.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, before
-- or after the code is deployed:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261014170000_club_graphics_template/migration.sql
--
-- Order does not matter here: the table is new, nothing selects it except
-- the graphics route, and that route treats a missing table as "no
-- template" and draws the default design (it logs the error).
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   * One new table, "ClubGraphicsTemplate", empty. One row per club at
--     most (orgId is the primary key), deleted with the club.
--   * No existing table, column or row is touched. Every club, Sutton FC
--     (cmnnwhdx30000zfr85q18lyy9) included, keeps the default design until
--     a template is seeded for it with scripts/seed-club-graphics-template.ts.
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS; the foreign key is dropped if
-- present before it is added. ONE transaction. lock_timeout keeps the
-- foreign key's brief lock on "Organisation" from queueing queries behind
-- it; if it fails on the lock, nothing changed and it can be run again.
-- There is no session-level SET in this file.
--
-- Verify after applying (expect one row each: then 0):
--   SELECT to_regclass('"ClubGraphicsTemplate"');
--   SELECT count(*) FROM "ClubGraphicsTemplate";
--
-- Rolling back:
--   DROP TABLE IF EXISTS "ClubGraphicsTemplate";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL and matches what db push creates.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "ClubGraphicsTemplate" (
  "orgId"     TEXT         NOT NULL,
  "image"     BYTEA        NOT NULL,
  "mimeType"  TEXT         NOT NULL,
  "layout"    JSONB        NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClubGraphicsTemplate_pkey" PRIMARY KEY ("orgId")
);

ALTER TABLE "ClubGraphicsTemplate" DROP CONSTRAINT IF EXISTS "ClubGraphicsTemplate_orgId_fkey";
ALTER TABLE "ClubGraphicsTemplate" ADD CONSTRAINT "ClubGraphicsTemplate_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
