-- The /play visit breakdown as DAILY TOTALS OF OPENS ONLY (2026-11-16,
-- Kemal, after two rounds of review). From 13 November each page beacon
-- left its own row in "PoolVisitEvent", with the hour, its time on screen,
-- what opened the page, a browser family and a device class. At our
-- traffic such a row can be matched to the one person who signed up that
-- day (on 13 November the only fb2 sign-up was the only fb2 start, and its
-- row said mobile Safari, not in an app), and what opened the page tells a
-- computer from a phone (a wheel or a key comes first only from a
-- computer). So the breakdown keeps, per bucket and London day, only the
-- number of opens, split by in-app browser and scanner flag. At very low
-- traffic a day's total can still coincide with a single sign-up. See
-- src/lib/pool/visit-log-rules.ts.
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
-- the London day, an app's in-app browser, the scanner flag, and the
-- number of opens. Only opens: starts are counted by "PoolCampaignVisit"
-- only. NO browser family, NO device class, NO interaction type, NO time
-- of day, NO time on screen, NO IP address, NO user agent, NO friend's
-- code, no user id, no cookie. An open still counts only after a real tap,
-- scroll or key press (src/app/play/funnel-open.ts); which one is not kept.
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
-- Verify after applying (expect "PoolVisitDaily", then 3 CHECKs):
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
    "inApp" TEXT NOT NULL,
    "scanner" BOOLEAN NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PoolVisitDaily_pkey" PRIMARY KEY ("code", "day", "inApp", "scanner")
);

CREATE INDEX IF NOT EXISTS "PoolVisitDaily_day_idx" ON "PoolVisitDaily"("day");

ALTER TABLE "PoolVisitDaily" DROP CONSTRAINT IF EXISTS "PoolVisitDaily_code_check";
ALTER TABLE "PoolVisitDaily" ADD CONSTRAINT "PoolVisitDaily_code_check"
  CHECK ("code" IN ('_direct', '_referral') OR ("code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("code") <= 32));
ALTER TABLE "PoolVisitDaily" DROP CONSTRAINT IF EXISTS "PoolVisitDaily_inApp_check";
ALTER TABLE "PoolVisitDaily" ADD CONSTRAINT "PoolVisitDaily_inApp_check"
  CHECK ("inApp" IN ('facebook', 'instagram', 'nextdoor', 'whatsapp', 'other', 'none'));
ALTER TABLE "PoolVisitDaily" DROP CONSTRAINT IF EXISTS "PoolVisitDaily_count_check";
ALTER TABLE "PoolVisitDaily" ADD CONSTRAINT "PoolVisitDaily_count_check"
  CHECK ("count" >= 0);

COMMIT;
