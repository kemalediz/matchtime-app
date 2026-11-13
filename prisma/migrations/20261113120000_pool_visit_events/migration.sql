-- The /play visit log (2026-11-13). The funnel counters ("PoolCampaignVisit")
-- say how many opened and started per code and day, but not why people
-- left; on 12 November 2026 the detail that could have said so lived only in
-- the server log, gone in a day. So each page beacon (opened, started) now
-- also leaves one row here. See src/lib/pool/visit-log-rules.ts.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261113120000_pool_visit_events/migration.sql
--   (or: npx tsx scripts/apply-pool-visit-event-migration.ts [--apply])
--
-- WHAT IS KEPT (Kemal's conditions, 2026-11-13): only what the funnel
-- analysis needs and nothing that identifies a person. The minute, the
-- bucket (a campaign code, "_direct" or "_referral"), the step, what opened
-- the page, its time on screen, WHETHER a friend's code came with it, and a
-- coarse browser label (family, in-app browser, device class, scanner). NO
-- IP address, NO user agent, NO friend's code, no user id, no cookie.
--
-- RETENTION: 90 DAYS. Rows are deleted once "at" is 90 days old, by the
-- daily 06:00 cron (/api/cron/close-ratings, purgeOldPoolVisitEvents in
-- src/lib/pool/visits.ts; the rule is POOL_VISIT_RETENTION_DAYS in
-- src/lib/pool/visit-log-rules.ts). The privacy policy (version 3) says so.
--
-- ORDER DOES NOT MATTER. The beacon writes this table best-effort, after its
-- answer and after the count: deployed before this is applied, every write
-- fails, is logged ("[pool-funnel] opened visit not logged") and swallowed,
-- the counters and /play are untouched, and the cron's deletion returns 0.
-- Apply it before or right after the deploy; visits before it are not logged.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One NEW table "PoolVisitEvent" (no foreign key), its
-- CHECKs and one index. No existing table, column or row changes.
--
-- IDEMPOTENT: IF NOT EXISTS, constraints dropped and re-added.
-- ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect "PoolVisitEvent", then 7 CHECKs):
--   SELECT to_regclass('"PoolVisitEvent"');
--   SELECT conname FROM pg_constraint WHERE conrelid = '"PoolVisitEvent"'::regclass AND contype = 'c';
--
-- Rolling back:
--   DROP TABLE IF EXISTS "PoolVisitEvent";

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "PoolVisitEvent" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "code" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "openedBy" TEXT,
    "visibleMs" INTEGER,
    "hasRef" BOOLEAN NOT NULL DEFAULT false,
    "browser" TEXT NOT NULL,
    "inApp" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "scanner" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PoolVisitEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PoolVisitEvent_at_idx" ON "PoolVisitEvent"("at");

ALTER TABLE "PoolVisitEvent" DROP CONSTRAINT IF EXISTS "PoolVisitEvent_code_check";
ALTER TABLE "PoolVisitEvent" ADD CONSTRAINT "PoolVisitEvent_code_check"
  CHECK ("code" IN ('_direct', '_referral') OR ("code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("code") <= 32));
ALTER TABLE "PoolVisitEvent" DROP CONSTRAINT IF EXISTS "PoolVisitEvent_step_check";
ALTER TABLE "PoolVisitEvent" ADD CONSTRAINT "PoolVisitEvent_step_check"
  CHECK ("step" IN ('opened', 'started'));
ALTER TABLE "PoolVisitEvent" DROP CONSTRAINT IF EXISTS "PoolVisitEvent_openedBy_check";
ALTER TABLE "PoolVisitEvent" ADD CONSTRAINT "PoolVisitEvent_openedBy_check"
  CHECK ("openedBy" IS NULL OR "openedBy" IN ('pointer', 'touch', 'key', 'wheel', 'scroll', 'visible-time', 'before-start'));
ALTER TABLE "PoolVisitEvent" DROP CONSTRAINT IF EXISTS "PoolVisitEvent_visibleMs_check";
ALTER TABLE "PoolVisitEvent" ADD CONSTRAINT "PoolVisitEvent_visibleMs_check"
  CHECK ("visibleMs" IS NULL OR ("visibleMs" >= 0 AND "visibleMs" <= 86400000));
ALTER TABLE "PoolVisitEvent" DROP CONSTRAINT IF EXISTS "PoolVisitEvent_browser_check";
ALTER TABLE "PoolVisitEvent" ADD CONSTRAINT "PoolVisitEvent_browser_check"
  CHECK ("browser" IN ('chrome', 'safari', 'firefox', 'edge', 'samsung', 'other'));
ALTER TABLE "PoolVisitEvent" DROP CONSTRAINT IF EXISTS "PoolVisitEvent_inApp_check";
ALTER TABLE "PoolVisitEvent" ADD CONSTRAINT "PoolVisitEvent_inApp_check"
  CHECK ("inApp" IN ('facebook', 'instagram', 'nextdoor', 'whatsapp', 'other', 'none'));
ALTER TABLE "PoolVisitEvent" DROP CONSTRAINT IF EXISTS "PoolVisitEvent_device_check";
ALTER TABLE "PoolVisitEvent" ADD CONSTRAINT "PoolVisitEvent_device_check"
  CHECK ("device" IN ('mobile', 'tablet', 'desktop', 'other'));

COMMIT;
