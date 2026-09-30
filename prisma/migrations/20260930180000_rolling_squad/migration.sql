-- Rolling squad (2026-09-30), slice 1 of
-- MDs/friday-group-features-plan-2026-09-30.md.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive:
--   1. "Organisation"."rollingSquadEnabled" BOOLEAN NOT NULL DEFAULT false.
--      Postgres 11+ stores a constant default in the catalog: no table
--      rewrite. Every existing club, Sutton FC included, reads false, so
--      nothing changes until an admin turns it on in /admin/settings.
--   2. "Match"."rollingSeededAt" TIMESTAMP(3) and
--      "Match"."rollingSeededFromMatchId" TEXT, both NULLABLE with no
--      default: catalog-only changes. NULL means "never seeded", which is
--      true of every existing match.
--
-- It does NOT: backfill anything, add an index or a constraint, drop or
-- rename anything, or change any query that does not name the new
-- columns.
--
-- Rolling back:
--   ALTER TABLE "Organisation" DROP COLUMN "rollingSquadEnabled";
--   ALTER TABLE "Match" DROP COLUMN "rollingSeededAt",
--                       DROP COLUMN "rollingSeededFromMatchId";
-- with no data loss outside the new columns.
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`
-- (there is no full migration history; see the prior migrations). This
-- file is the canonical, reviewable DDL. `prisma db push` produces an
-- identical result here.

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN "rollingSquadEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Match" ADD COLUMN "rollingSeededAt" TIMESTAMP(3),
ADD COLUMN "rollingSeededFromMatchId" TEXT;
