-- A form note with its amount (Kemal, 2026-11-10: "it would be nice if it
-- tells explicitly how much rating adjustment it made ... so if I don't like
-- it, I can get it amended further"). When a player tells MatchTime how they
-- will play in the next match ("@Match Time reduce my strength, I'm tired"),
-- MatchTime decides the amount then, says it ("Noted: -0.5 for Kemal (tired)
-- in Tuesday's game"), and keeps it here, one row per player per match, so
-- "make it -1" or "cancel my adjustment" changes it. When the teams are made
-- a row WINS over the rating adjuster's delta for that player
-- (src/lib/form-note-rules.ts formNotesWin, src/lib/team-generation.ts).
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261110150000_form_note/migration.sql
--
-- ORDER: APPLY THIS BEFORE THE DEPLOY. The code reads and writes the table
-- best-effort: deployed before this is applied, a form note is answered with
-- the plain "Noted: I'll take it into account when the teams are made" line
-- (as before this change) and team generation runs the adjuster alone, but
-- each attempt logs an error. Nothing breaks either way.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One NEW table "FormNote" with foreign keys to
-- "Organisation", "Match" and "User" (ON DELETE CASCADE), one unique index
-- and one index. No existing table, column or row changes.
--
-- IDEMPOTENT: IF NOT EXISTS everywhere, the constraints dropped and re-added.
-- ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect "FormNote"):
--   SELECT to_regclass('"FormNote"');
--
-- Rolling back:
--   DROP TABLE IF EXISTS "FormNote";

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "FormNote" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "delta" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "setByUserId" TEXT,
    "sourceMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FormNote_matchId_userId_key" ON "FormNote"("matchId", "userId");
CREATE INDEX IF NOT EXISTS "FormNote_orgId_idx" ON "FormNote"("orgId");

ALTER TABLE "FormNote" DROP CONSTRAINT IF EXISTS "FormNote_orgId_fkey";
ALTER TABLE "FormNote" ADD CONSTRAINT "FormNote_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FormNote" DROP CONSTRAINT IF EXISTS "FormNote_matchId_fkey";
ALTER TABLE "FormNote" ADD CONSTRAINT "FormNote_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FormNote" DROP CONSTRAINT IF EXISTS "FormNote_userId_fkey";
ALTER TABLE "FormNote" ADD CONSTRAINT "FormNote_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
