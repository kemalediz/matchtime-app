-- The per-visit OPENS of 13 to 16 November 2026 ("PoolVisitEvent") added up
-- into the daily totals ("PoolVisitDaily"), 2026-11-16. Third of four (see
-- 20261116120000_pool_visit_daily). Nothing is deleted here: the old table
-- is RENAMED to "PoolVisitEventBackfilled", kept until the totals have been
-- checked against the daily counters, and dropped by file 4.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261116120200_pool_visit_daily_backfill/migration.sql
--
-- APPLY AFTER THE DEPLOY. From the deploy on, the new code adds each open
-- to "PoolVisitDaily" and nothing writes "PoolVisitEvent" any more, so
-- adding the old rows to whatever the new code has added since is exact:
-- each open is in one table or the other, never both, never neither.
-- (Applied before the deploy, the old code's writes after it fail, are
-- logged and swallowed: those few visits stay in the counters and miss
-- the breakdown. Nothing else is harmed.)
--
-- ONCE ONLY, BY CONSTRUCTION: it adds the rows and renames the table in
-- one transaction. Run again, "PoolVisitEvent" no longer exists and it does
-- nothing (a NOTICE says so), so nothing can be counted twice. On a
-- database that never had "PoolVisitEvent" it does nothing too.
--
-- HOW A ROW BECOMES A TOTAL. Only opens: the old "started" rows are left
-- out (the daily counters already count starts). One row is one open. Its
-- day is the London day of "at" ("at" is UTC, floored to the hour; London
-- is a whole number of hours off UTC, so the hour never moves the day).
-- Its trigger is "openedBy" ("visible-time" included, from the old
-- 5-second rule), or "none" for an open that did not say. "inApp" and
-- "scanner" are copied. "browser", "device", "visibleMs", "hasRef" and the
-- hour are left behind.
--
--   INSERT INTO "PoolVisitDaily" ("code", "day", "step", "trigger", "inApp", "scanner", "count")
--   SELECT "code", (("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')::date, 'opened',
--          COALESCE("openedBy", 'none'), "inApp", "scanner", count(*)::int
--   FROM "PoolVisitEvent" WHERE "step" = 'opened' GROUP BY 1, 2, 3, 4, 5, 6
--   ON CONFLICT (all six) DO UPDATE SET "count" = "PoolVisitDaily"."count" + EXCLUDED."count";
--
-- DRY RUN FIRST (read only; the opens that will be added, per day):
--   BEGIN READ ONLY;
--   SELECT (("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')::date AS day, "scanner", count(*)
--   FROM "PoolVisitEvent" WHERE "step" = 'opened' GROUP BY 1, 2 ORDER BY 1, 2;
--   ROLLBACK;
--
-- CHECK AFTER APPLYING, BEFORE FILE 4. (a) The opens without scanners
-- against the daily counters, per code and day, from the first day the
-- breakdown holds. Every row should agree, except: the first day (the
-- per-visit log began part way through it), an hour over the old cap of
-- 200 rows per code, and a write that failed (each is in the server log as
-- "[pool-funnel] ... visit not logged" or "... not added to the daily
-- breakdown"). Staff and scanners are in neither.
--   BEGIN READ ONLY;
--   WITH breakdown AS (
--     SELECT "code", "day", sum("count")::int AS n FROM "PoolVisitDaily" WHERE NOT "scanner" GROUP BY 1, 2
--   ), counters AS (
--     SELECT "code", "day", "count" AS n FROM "PoolCampaignVisit"
--     WHERE "step" = 'opened' AND "day" >= (SELECT min("day") FROM "PoolVisitDaily")
--   )
--   SELECT coalesce(b."code", c."code") AS code, coalesce(b."day", c."day") AS day, c.n AS counters, b.n AS breakdown
--   FROM breakdown b FULL JOIN counters c ON b."code" = c."code" AND b."day" = c."day"
--   WHERE b.n IS DISTINCT FROM c.n
--   ORDER BY 2, 1;
--   ROLLBACK;
-- (Drop the WHERE line to see every row.)
-- (b) Every old open was added. Both sides count only the London days
-- before the deploy day: on the deploy day itself the new code adds opens
-- of its own, so comparing that day would be a false alarm. Put the deploy
-- day's date (yyyy-mm-dd, London) in both places; expect two equal numbers.
--   SELECT (SELECT count(*) FROM "PoolVisitEventBackfilled"
--           WHERE "step" = 'opened' AND (("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')::date < '<deploy day>') AS old_opens,
--          (SELECT coalesce(sum("count"), 0) FROM "PoolVisitDaily" WHERE "day" < '<deploy day>') AS added_before_deploy_day;
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Adds to "PoolVisitDaily" (new rows, or a higher count on rows the new
-- code made the same day) and renames "PoolVisitEvent" to
-- "PoolVisitEventBackfilled", its rows, indexes and CHECKs untouched. No
-- row is deleted anywhere, and no other table is touched. The old table is
-- read whole once, under a lock that only stops writes (the old code's,
-- if it is still live; reads go on).
--
-- ONE transaction; SET LOCAL only.
--
-- Rolling back (with the old code back): subtract what was added and give
-- the old table its name again, in one transaction:
--   BEGIN;
--   WITH old AS (SELECT "code", (("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')::date AS "day",
--                       COALESCE("openedBy", 'none') AS "trigger", "inApp", "scanner", count(*)::int AS n
--                FROM "PoolVisitEventBackfilled" WHERE "step" = 'opened' GROUP BY 1, 2, 3, 4, 5)
--   UPDATE "PoolVisitDaily" d SET "count" = d."count" - old.n FROM old
--   WHERE (d."code", d."day", d."step", d."trigger", d."inApp", d."scanner")
--       = (old."code", old."day", 'opened', old."trigger", old."inApp", old."scanner");
--   DELETE FROM "PoolVisitDaily" WHERE "count" = 0;
--   ALTER TABLE "PoolVisitEventBackfilled" RENAME TO "PoolVisitEvent";
--   COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('"PoolVisitEvent"') IS NULL THEN
    RAISE NOTICE 'no "PoolVisitEvent" table: already added up (or never there), nothing to do';
    RETURN;
  END IF;

  LOCK TABLE "PoolVisitEvent" IN EXCLUSIVE MODE;

  INSERT INTO "PoolVisitDaily" ("code", "day", "step", "trigger", "inApp", "scanner", "count")
  SELECT "code",
         (("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')::date,
         'opened',
         COALESCE("openedBy", 'none'),
         "inApp", "scanner",
         count(*)::int
  FROM "PoolVisitEvent"
  WHERE "step" = 'opened'
  GROUP BY 1, 2, 3, 4, 5, 6
  ON CONFLICT ("code", "day", "step", "trigger", "inApp", "scanner")
  DO UPDATE SET "count" = "PoolVisitDaily"."count" + EXCLUDED."count";

  ALTER TABLE "PoolVisitEvent" RENAME TO "PoolVisitEventBackfilled";
END
$$;

COMMIT;
