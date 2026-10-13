-- Venue suggestions: the per-person hourly count of suggestion calls (2026-10-13).
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand:
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261013120000_venue_suggest_usage/migration.sql
--
-- ORDER DOES NOT MATTER. The code is safe to deploy BEFORE this is
-- applied: while the table is missing, the count cannot be kept, so
-- /api/venue/suggest answers an empty list and the venue box is a plain
-- text box (src/lib/venue-suggest-cap.ts fails closed). Nothing else
-- reads the table. Suggestions start working once it exists.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS, so it can be run again
-- safely. It is ONE transaction: it applies whole or not at all.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive: ONE new, empty table and one index on it.
--   "VenueSuggestUsage"  one row per person per clock hour: how many
--                        suggestion calls that person caused in that
--                        hour. The cap (120 an hour) reads the count.
--                        A user id, an hour and a count: never what was
--                        typed, a place or a session token.
--
-- It adds NO column to any existing table and NO foreign key, so it
-- takes no lock on any existing table, rewrites nothing and updates no
-- row. No existing query changes.
--
-- There is no session-level SET anywhere in this file.
--
-- Verify after applying (expect 1, then 4):
--   SELECT count(*) FROM information_schema.tables WHERE table_name = 'VenueSuggestUsage';
--   SELECT count(*) FROM information_schema.columns WHERE table_name = 'VenueSuggestUsage';
--
-- Rolling back (suggestions then switch themselves off, nothing else changes):
--   DROP TABLE IF EXISTS "VenueSuggestUsage";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL for production.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "VenueSuggestUsage" (
  "key"         TEXT         NOT NULL,
  "userId"      TEXT         NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "count"       INTEGER      NOT NULL DEFAULT 0,
  CONSTRAINT "VenueSuggestUsage_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "VenueSuggestUsage_userId_windowStart_idx"
  ON "VenueSuggestUsage" ("userId", "windowStart");

COMMIT;
