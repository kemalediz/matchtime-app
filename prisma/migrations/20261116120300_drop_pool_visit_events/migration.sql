-- Drop the per-visit rows of 13 to 16 November 2026 (2026-11-16, Kemal:
-- daily totals only). Fourth and last of four (see
-- 20261116120000_pool_visit_daily). THIS DELETES DATA.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261116120300_drop_pool_visit_events/migration.sql
--
-- APPLY ONLY ONCE THE BACKFILL HAS BEEN CHECKED: file 3 added the rows up
-- into "PoolVisitDaily" and renamed the old table "PoolVisitEventBackfilled";
-- its header has the query that compares the totals with the daily
-- counters. When those agree, this drops the renamed table. Do not wait
-- long: the old rows carry the hour and the time on screen, which the
-- privacy policy (version 4) no longer says are kept, and nothing deletes
-- them after 90 days any more.
--
-- REFUSES TO RUN WITHOUT THE BACKFILL: if "PoolVisitEvent" still exists
-- under its own name, file 3 has not run, and this stops with an error
-- rather than lose rows that were never added up. Nothing is changed then.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- DROP TABLE "PoolVisitEventBackfilled" (with its indexes and CHECKs). No
-- other table refers to it (no foreign key, and no code reads it since the
-- deploy). Nothing else changes.
--
-- IDEMPOTENT: run again, the table is gone and it does nothing.
-- ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect two NULLs):
--   SELECT to_regclass('"PoolVisitEvent"'), to_regclass('"PoolVisitEventBackfilled"');
--
-- Rolling back: not possible; the totals in "PoolVisitDaily" stay. Take a
-- copy first if one is wanted (pg_dump -t '"PoolVisitEventBackfilled"').

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('"PoolVisitEvent"') IS NOT NULL THEN
    RAISE EXCEPTION '"PoolVisitEvent" was never added up: apply 20261116120200_pool_visit_daily_backfill first, and check it';
  END IF;
END
$$;

DROP TABLE IF EXISTS "PoolVisitEventBackfilled";

COMMIT;
