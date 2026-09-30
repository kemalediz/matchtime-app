-- Weekly deadlines (2026-09-30), slice 3 of
-- MDs/friday-group-features-plan-2026-09-30.md.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive: four NULLABLE columns on "Organisation" with no
-- default, which Postgres records in the catalog only (no table rewrite,
-- no long lock). NULL means "not set", which is true of every existing
-- club, Sutton FC included, so nothing changes until an admin sets a
-- deadline in /admin/settings.
--
-- It does NOT: backfill anything, add an index or a constraint, drop or
-- rename anything, or change any query that does not name the new
-- columns.
--
-- Rolling back:
--   ALTER TABLE "Organisation" DROP COLUMN "dropOutDeadlineDay",
--                              DROP COLUMN "dropOutDeadlineTime",
--                              DROP COLUMN "listPublishDay",
--                              DROP COLUMN "listPublishTime";
-- with no data loss outside the new columns.
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL and `prisma db push` produces an
-- identical result.

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN "dropOutDeadlineDay" INTEGER,
ADD COLUMN "dropOutDeadlineTime" TEXT,
ADD COLUMN "listPublishDay" INTEGER,
ADD COLUMN "listPublishTime" TEXT;
