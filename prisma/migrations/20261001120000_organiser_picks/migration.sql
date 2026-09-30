-- Organiser pick, slice 2b (2026-10-01).
-- Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.6 to 2.14.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   * Two NOT NULL columns on "Organisation" with constant defaults
--     ('first-come', 'bench-offer'). Postgres fills every existing row with
--     the default as the column is added (no table rewrite on PG 11+), so
--     Sutton FC (cmnnwhdx30000zfr85q18lyy9) and every other club stays on
--     "first to say IN": today's behaviour, byte for byte.
--   * Two CHECK constraints on those columns.
--   * One new table, "OrganiserPickRound", with two indexes and a foreign
--     key to "Match" (ON DELETE CASCADE). Empty until a club turns
--     organiser pick on in /admin/settings.
--
-- It does NOT drop, rename or rewrite anything, and changes no query that
-- does not name the new columns or table.
--
-- Verify after applying (expect 0 and 0):
--   SELECT count(*) FROM "Organisation" WHERE "benchPickMode" <> 'first-come';
--   SELECT count(*) FROM "OrganiserPickRound";
--
-- Rolling back:
--   DROP TABLE "OrganiserPickRound";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_benchPickMode_check";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_benchPickFallback_check";
--   ALTER TABLE "Organisation" DROP COLUMN "benchPickMode", DROP COLUMN "benchPickFallback";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. Apply THIS file (psql -f; it
-- carries its own BEGIN/COMMIT). `db push` would produce the same columns
-- and table but never creates the CHECK constraints.

BEGIN;

ALTER TABLE "Organisation"
  ADD COLUMN "benchPickMode" TEXT NOT NULL DEFAULT 'first-come',
  ADD COLUMN "benchPickFallback" TEXT NOT NULL DEFAULT 'bench-offer';

ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_benchPickMode_check"
  CHECK ("benchPickMode" IN ('first-come', 'organiser'));
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_benchPickFallback_check"
  CHECK ("benchPickFallback" IN ('bench-offer', 'leave-empty'));

CREATE TABLE "OrganiserPickRound" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipientUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "listUserIds" TEXT[],
    "vacatedByUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lateDropUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "openPlaces" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "fallbackAt" TIMESTAMP(3) NOT NULL,
    "pendingConfirmUserId" TEXT,
    "pendingConfirmAskedByUserId" TEXT,
    "pendingConfirmAskedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "pickedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastPickedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganiserPickRound_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrganiserPickRound_matchId_resolvedAt_idx" ON "OrganiserPickRound"("matchId", "resolvedAt");
CREATE INDEX "OrganiserPickRound_orgId_resolvedAt_idx" ON "OrganiserPickRound"("orgId", "resolvedAt");

ALTER TABLE "OrganiserPickRound" ADD CONSTRAINT "OrganiserPickRound_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
