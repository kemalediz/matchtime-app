-- The /play visit breakdown as DAILY TOTALS OF OPENS ONLY (2026-11-16,
-- Kemal). From 13 November each page beacon left its own row in
-- "PoolVisitEvent", with the hour, its time on screen, a browser family
-- and a device class. At our traffic such a row can be matched to the one
-- person who signed up that day (on 13 November the only fb2 sign-up was
-- the only fb2 start, and its row said mobile Safari, not in an app). So
-- nothing per visit is kept any more, nor anything that narrows it down:
-- per bucket and London day, opens only, one count per trigger, in-app
-- browser and scanner flag. See src/lib/pool/visit-log-rules.ts.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261116120000_pool_visit_daily/migration.sql
--
-- ONE OF FOUR, IN THIS ORDER:
--   1. this file                                   BEFORE the deploy
--   2. 20261116120100_pool_profile_staff_test      BEFORE the deploy
--   3. 20261116120200_pool_visit_daily_backfill    AFTER the deploy
--   4. 20261116120300_drop_pool_visit_events       LATER, once the totals are checked
--
-- APPLY BEFORE DEPLOYING THE CODE. The new code adds to this table with
-- each open; without it every add fails, is logged ("[pool-funnel] opened
-- not added to the daily breakdown") and swallowed, the counters and /play
-- untouched, but those opens are missing from the breakdown. The old code
-- never reads or writes it, so applying it first changes nothing live.
--
-- WHAT IS KEPT: the bucket (a campaign code, "_direct" or "_referral"),
-- the London day, the step (always 'opened': starts are counted by
-- "PoolCampaignVisit" only), what opened the page (a tap, touch, key,
-- wheel, scroll or a start first; "visible-time" only for opens before 16
-- November 2026; "none" for an old open that did not say), an app's in-app
-- browser, the scanner flag, and a count. NO browser family, NO device
-- class, NO hour, NO time on screen, NO IP address, NO user agent, NO
-- friend's code, no user id, no cookie. "hasRef" is not carried over: the
-- "_referral" bucket already says a live friend's link brought the visit.
--
-- RETENTION: 90 DAYS. A day's totals are deleted once the day is 90 days
-- old, by the daily 06:00 cron (/api/cron/close-ratings,
-- purgeOldPoolVisitDaily in src/lib/pool/visits.ts; the rule is
-- POOL_VISIT_RETENTION_DAYS in src/lib/pool/visit-log-rules.ts). The
-- privacy policy (version 4) says so.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One NEW, empty table "PoolVisitDaily" (no foreign
-- key), its CHECKs and one index. No existing table, column or row changes;
-- "PoolVisitEvent" is untouched (file 3 adds its opens up, file 4 drops it).
--
-- IDEMPOTENT: IF NOT EXISTS, constraints dropped and re-added.
-- ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect "PoolVisitDaily", then 5 CHECKs):
--   SELECT to_regclass('"PoolVisitDaily"');
--   SELECT conname FROM pg_constraint WHERE conrelid = '"PoolVisitDaily"'::regclass AND contype = 'c';
--
-- Rolling back (before the deploy, or with the old code back):
--   DROP TABLE IF EXISTS "PoolVisitDaily";

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "PoolVisitDaily" (
    "code" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "step" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "inApp" TEXT NOT NULL,
    "scanner" BOOLEAN NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PoolVisitDaily_pkey" PRIMARY KEY ("code", "day", "step", "trigger", "inApp", "scanner")
);

CREATE INDEX IF NOT EXISTS "PoolVisitDaily_day_idx" ON "PoolVisitDaily"("day");

ALTER TABLE "PoolVisitDaily" DROP CONSTRAINT IF EXISTS "PoolVisitDaily_code_check";
ALTER TABLE "PoolVisitDaily" ADD CONSTRAINT "PoolVisitDaily_code_check"
  CHECK ("code" IN ('_direct', '_referral') OR ("code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("code") <= 32));
ALTER TABLE "PoolVisitDaily" DROP CONSTRAINT IF EXISTS "PoolVisitDaily_step_check";
ALTER TABLE "PoolVisitDaily" ADD CONSTRAINT "PoolVisitDaily_step_check"
  CHECK ("step" IN ('opened'));
ALTER TABLE "PoolVisitDaily" DROP CONSTRAINT IF EXISTS "PoolVisitDaily_trigger_check";
ALTER TABLE "PoolVisitDaily" ADD CONSTRAINT "PoolVisitDaily_trigger_check"
  CHECK ("trigger" IN ('pointer', 'touch', 'key', 'wheel', 'scroll', 'before-start', 'visible-time', 'none'));
ALTER TABLE "PoolVisitDaily" DROP CONSTRAINT IF EXISTS "PoolVisitDaily_inApp_check";
ALTER TABLE "PoolVisitDaily" ADD CONSTRAINT "PoolVisitDaily_inApp_check"
  CHECK ("inApp" IN ('facebook', 'instagram', 'nextdoor', 'whatsapp', 'other', 'none'));
ALTER TABLE "PoolVisitDaily" DROP CONSTRAINT IF EXISTS "PoolVisitDaily_count_check";
ALTER TABLE "PoolVisitDaily" ADD CONSTRAINT "PoolVisitDaily_count_check"
  CHECK ("count" >= 0);

COMMIT;
