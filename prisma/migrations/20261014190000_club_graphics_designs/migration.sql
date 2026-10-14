-- Posters: shared templates, owner-uploaded backgrounds and each club's
-- chosen design (2026-10-14).
-- See src/lib/club-graphics-choice.ts, src/lib/club-graphics-template.ts
-- and src/lib/graphics-background.ts.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, after
-- 20261014170000_club_graphics_template, before or after the code is
-- deployed:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261014190000_club_graphics_designs/migration.sql
--
-- Order does not matter. Code deployed first: it reads a template the old
-- way when these columns are missing (so FNF's board is drawn exactly as
-- before), reads "no choice" when the choice table is missing, and the
-- Posters card's choose and upload buttons fail with a message until this
-- is applied; the graphics never fail.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   * "ClubGraphicsTemplate" gets six columns:
--       kind           TEXT NOT NULL DEFAULT 'measured'
--       shared         BOOLEAN NOT NULL DEFAULT false
--       displayName    TEXT (null)
--       sharedImage    BYTEA (null)   the variant other clubs get, branding
--       sharedMimeType TEXT (null)    painted out (FNF's "Floodlights",
--       sharedLayout   JSONB (null)   seeded separately)
--     Constant defaults or null: PostgreSQL 11+ adds these without
--     rewriting the table. Every existing row (FNF's) becomes kind
--     'measured', not shared, no display name, no variant: exactly what it
--     is today, drawn the same.
--   * One index on "ClubGraphicsTemplate"(shared), for the gallery.
--   * One new table, "ClubGraphicsChoice", empty: one row per club at most
--     (orgId is the primary key), deleted with the club; its
--     "sharedFromOrgId" is set to null if the template it points at is
--     deleted. No row means "the club's own template, else the default",
--     which is what every club gets today.
--   * No existing row is changed. Sutton FC (cmnnwhdx30000zfr85q18lyy9)
--     has no template and no choice: it keeps the default design.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS, CREATE TABLE / INDEX IF NOT
-- EXISTS, each foreign key dropped if present before it is added. ONE
-- transaction. lock_timeout keeps the brief locks (ALTER TABLE on
-- "ClubGraphicsTemplate", the foreign keys' locks on "Organisation") from
-- queueing queries behind them; if it fails on a lock, nothing changed
-- and it can be run again. There is no session-level SET in this file.
--
-- Verify after applying:
--   SELECT kind, shared, "displayName" FROM "ClubGraphicsTemplate";   -- 'measured', f, null for each
--   SELECT to_regclass('"ClubGraphicsChoice"');                       -- not null
--   SELECT count(*) FROM "ClubGraphicsChoice";                         -- 0
--
-- Rolling back (after rolling the code back, or with the code tolerant
-- as above):
--   DROP TABLE IF EXISTS "ClubGraphicsChoice";
--   DROP INDEX IF EXISTS "ClubGraphicsTemplate_shared_idx";
--   ALTER TABLE "ClubGraphicsTemplate" DROP COLUMN IF EXISTS "sharedLayout",
--     DROP COLUMN IF EXISTS "sharedMimeType", DROP COLUMN IF EXISTS "sharedImage",
--     DROP COLUMN IF EXISTS "displayName", DROP COLUMN IF EXISTS "shared",
--     DROP COLUMN IF EXISTS "kind";
--   (An uploaded background row would then read as a measured template
--   with no valid layout, and be drawn in the default design.)
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL and matches what db push creates.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "ClubGraphicsTemplate" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'measured';
ALTER TABLE "ClubGraphicsTemplate" ADD COLUMN IF NOT EXISTS "shared" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ClubGraphicsTemplate" ADD COLUMN IF NOT EXISTS "displayName" TEXT;
ALTER TABLE "ClubGraphicsTemplate" ADD COLUMN IF NOT EXISTS "sharedImage" BYTEA;
ALTER TABLE "ClubGraphicsTemplate" ADD COLUMN IF NOT EXISTS "sharedMimeType" TEXT;
ALTER TABLE "ClubGraphicsTemplate" ADD COLUMN IF NOT EXISTS "sharedLayout" JSONB;
CREATE INDEX IF NOT EXISTS "ClubGraphicsTemplate_shared_idx" ON "ClubGraphicsTemplate"("shared");

CREATE TABLE IF NOT EXISTS "ClubGraphicsChoice" (
  "orgId"           TEXT         NOT NULL,
  "design"          TEXT         NOT NULL,
  "sharedFromOrgId" TEXT,
  "updatedById"     TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClubGraphicsChoice_pkey" PRIMARY KEY ("orgId")
);
CREATE INDEX IF NOT EXISTS "ClubGraphicsChoice_sharedFromOrgId_idx" ON "ClubGraphicsChoice"("sharedFromOrgId");

ALTER TABLE "ClubGraphicsChoice" DROP CONSTRAINT IF EXISTS "ClubGraphicsChoice_orgId_fkey";
ALTER TABLE "ClubGraphicsChoice" ADD CONSTRAINT "ClubGraphicsChoice_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClubGraphicsChoice" DROP CONSTRAINT IF EXISTS "ClubGraphicsChoice_sharedFromOrgId_fkey";
ALTER TABLE "ClubGraphicsChoice" ADD CONSTRAINT "ClubGraphicsChoice_sharedFromOrgId_fkey"
  FOREIGN KEY ("sharedFromOrgId") REFERENCES "ClubGraphicsTemplate"("orgId") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
