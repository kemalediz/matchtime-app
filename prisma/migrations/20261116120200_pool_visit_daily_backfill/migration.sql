-- The per-visit rows of 13 to 16 November 2026 ("PoolVisitEvent") added up
-- into the daily totals ("PoolVisitDaily"), 2026-11-16. Third of four (see
-- 20261116120000_pool_visit_daily). Nothing is deleted here: the old table
-- is RENAMED to "PoolVisitEventBackfilled", kept until the totals have been
-- checked against the daily counters, and dropped by file 4.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261116120200_pool_visit_daily_backfill/migration.sql
--
-- APPLY AFTER THE DEPLOY. From the deploy on, the new code adds each visit
-- to "PoolVisitDaily" and nothing writes "PoolVisitEvent" any more, so
-- adding the old rows to whatever the new code has added since is exact:
-- each visit is in one table or the other, never both, never neither.
-- (Applied before the deploy, the old code's writes after it fail, are
-- logged and swallowed: those few visits stay in the counters and miss
-- the breakdown. Nothing else is harmed.)
--
-- ONCE ONLY, BY CONSTRUCTION: it adds the rows and renames the table in
-- one transaction. Run again, "PoolVisitEvent" no longer exists and it does
-- nothing (a NOTICE says so), so nothing can be counted twice. On a
-- database that never had "PoolVisitEvent" it does nothing too.
--
-- HOW A ROW BECOMES A TOTAL. One row is one beacon. Its day is the London
-- day of "at" ("at" is UTC, floored to the hour; London is a whole number
-- of hours off UTC, so the hour never moves the day). Its trigger is
-- "openedBy" ("visible-time" included, from the old 5-second rule), or
-- "none" for a start or an open that did not say. The label columns are
-- copied. "visibleMs", "hasRef" and the hour are dropped.
--
--   INSERT INTO "PoolVisitDaily" ("code", "day", "step", "trigger", "browser", "inApp", "device", "scanner", "count")
--   SELECT "code", (("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')::date, "step",
--          CASE WHEN "step" = 'started' THEN 'none' ELSE COALESCE("openedBy", 'none') END,
--          "browser", "inApp", "device", "scanner", count(*)::int
--   FROM "PoolVisitEvent" GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
--   ON CONFLICT (all eight) DO UPDATE SET "count" = "PoolVisitDaily"."count" + EXCLUDED."count";
--
-- DRY RUN FIRST (read only; what will be added, per day and step):
--   BEGIN READ ONLY;
--   SELECT (("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')::date AS day, "step", "scanner", count(*)
--   FROM "PoolVisitEvent" GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
--   ROLLBACK;
--
-- CHECK AFTER APPLYING, BEFORE FILE 4: the breakdown without scanners
-- against the daily counters, per code, day and step, from the first day
-- the breakdown holds. Every row should agree, except: the first day (the
-- per-visit log began part way through it), an hour over the old cap of
-- 200 rows per code, and a write that failed (each is in the server log as
-- "[pool-funnel] ... visit not logged" or "... not added to the daily
-- breakdown"). Staff and scanners are in neither.
--   BEGIN READ ONLY;
--   WITH breakdown AS (
--     SELECT "code", "day", "step", sum("count")::int AS n FROM "PoolVisitDaily" WHERE NOT "scanner" GROUP BY 1, 2, 3
--   ), counters AS (
--     SELECT "code", "day", "step", "count" AS n FROM "PoolCampaignVisit"
--     WHERE "step" IN ('opened', 'started') AND "day" >= (SELECT min("day") FROM "PoolVisitDaily")
--   )
--   SELECT coalesce(b."code", c."code") AS code, coalesce(b."day", c."day") AS day, coalesce(b."step", c."step") AS step,
--          c.n AS counters, b.n AS breakdown
--   FROM breakdown b FULL JOIN counters c ON b."code" = c."code" AND b."day" = c."day" AND b."step" = c."step"
--   WHERE b.n IS DISTINCT FROM c.n
--   ORDER BY 2, 1, 3;
--   ROLLBACK;
-- (Drop the WHERE line to see every row.) And that every old row was
-- added (the new code adds none before the deploy day):
--   SELECT (SELECT count(*) FROM "PoolVisitEventBackfilled") AS old_rows,
--          (SELECT sum("count") FROM "PoolVisitDaily" WHERE "day" < '<deploy day>') AS added_before_deploy_day;
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
--   WITH old AS (SELECT "code", (("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')::date AS "day", "step",
--                       CASE WHEN "step" = 'started' THEN 'none' ELSE COALESCE("openedBy", 'none') END AS "trigger",
--                       "browser", "inApp", "device", "scanner", count(*)::int AS n
--                FROM "PoolVisitEventBackfilled" GROUP BY 1, 2, 3, 4, 5, 6, 7, 8)
--   UPDATE "PoolVisitDaily" d SET "count" = d."count" - old.n FROM old
--   WHERE (d."code", d."day", d."step", d."trigger", d."browser", d."inApp", d."device", d."scanner")
--       = (old."code", old."day", old."step", old."trigger", old."browser", old."inApp", old."device", old."scanner");
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

  INSERT INTO "PoolVisitDaily" ("code", "day", "step", "trigger", "browser", "inApp", "device", "scanner", "count")
  SELECT "code",
         (("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/London')::date,
         "step",
         CASE WHEN "step" = 'started' THEN 'none' ELSE COALESCE("openedBy", 'none') END,
         "browser", "inApp", "device", "scanner",
         count(*)::int
  FROM "PoolVisitEvent"
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
  ON CONFLICT ("code", "day", "step", "trigger", "browser", "inApp", "device", "scanner")
  DO UPDATE SET "count" = "PoolVisitDaily"."count" + EXCLUDED."count";

  ALTER TABLE "PoolVisitEvent" RENAME TO "PoolVisitEventBackfilled";
END
$$;

COMMIT;
