-- Approved but setting up, slice S1: schema and silence rails (2026-10-12).
-- Go-live plan sections 2.1 and 2.2.
--
-- HOW TO APPLY (before the code that reads these columns is deployed):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261012120000_setup_hold/migration.sql
--
-- IDEMPOTENT: every statement is IF NOT EXISTS or DROP IF EXISTS then ADD,
-- so it can be run again safely. It is ONE transaction: it either applies
-- whole or not at all.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   * Five columns on "Organisation". "setupStage" is NOT NULL with DEFAULT
--     'live': that default IS the backfill. Postgres records a constant
--     default in the catalog as the column is added (no table rewrite on
--     PG 11+), so every existing club, Sutton FC and the self-join clubs
--     already approved included, reads 'live' and nothing changes for it.
--     "liveAt", "liveBy", "setupAskedAt" and "setupRemovedAt" are NULLABLE
--     and stay NULL on every existing row.
--   * Two CHECK constraints (the same DDL as prisma/sql/org-setup-check.sql):
--     the two legal stages, and "the bot is never ON for a club that is
--     setting up". Every existing row satisfies both once the default has
--     filled.
--
-- It does NOT drop, rename or rewrite anything, updates no row, and changes
-- no query that does not name the new columns.
--
-- LOCKING
-- -------
-- ALTER TABLE takes an ACCESS EXCLUSIVE lock on "Organisation" for the
-- length of this transaction. The work under it is: catalog-only column
-- adds, and one validation scan of "Organisation" per CHECK (one row per
-- club, so a handful of rows). That is milliseconds. No other table is
-- locked.
--
-- `lock_timeout` is set to 5 seconds FOR THIS TRANSACTION ONLY (SET LOCAL,
-- which ends at COMMIT and is safe through a transaction pooler). If some
-- long-running transaction is holding "Organisation", this file fails
-- after 5 seconds with "canceling statement due to lock timeout" and
-- changes nothing, instead of queueing behind it and blocking every other
-- reader of the table while it waits. Just run it again.
--
-- Verify after applying (expect every row 'live', then zero rows, then 2):
--   SELECT "setupStage", count(*) FROM "Organisation" GROUP BY 1;
--   SELECT id FROM "Organisation" WHERE "setupStage" = 'setting-up' AND "whatsappBotEnabled";
--   SELECT count(*) FROM pg_constraint WHERE conname IN
--     ('Organisation_setupStage_check', 'Organisation_bot_off_while_setting_up');
--
-- Rolling back (only once no deployed code reads the columns):
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_bot_off_while_setting_up";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_setupStage_check";
--   ALTER TABLE "Organisation" DROP COLUMN IF EXISTS "setupStage", DROP COLUMN IF EXISTS "liveAt",
--     DROP COLUMN IF EXISTS "liveBy", DROP COLUMN IF EXISTS "setupAskedAt",
--     DROP COLUMN IF EXISTS "setupRemovedAt";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. `prisma db push` creates the
-- columns but NOT the CHECK constraints, so apply this file.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Organisation"
  ADD COLUMN IF NOT EXISTS "setupStage" TEXT NOT NULL DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS "liveAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "liveBy" TEXT,
  ADD COLUMN IF NOT EXISTS "setupAskedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "setupRemovedAt" TIMESTAMP(3);

-- CHECK constraints (prisma/sql/org-setup-check.sql)
ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_setupStage_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_setupStage_check"
  CHECK ("setupStage" IN ('live', 'setting-up'));

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_bot_off_while_setting_up";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_bot_off_while_setting_up"
  CHECK (NOT ("setupStage" = 'setting-up' AND "whatsappBotEnabled"));

COMMIT;
