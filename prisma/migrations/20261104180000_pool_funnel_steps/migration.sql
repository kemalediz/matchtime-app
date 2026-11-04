-- The /play sign-up funnel's steps (2026-11-04). /play was opened 24 times
-- on 4 November and nobody sent the form, and nothing said where they
-- stopped. "PoolCampaignVisit" counted only the visit (opened); it now
-- counts each step, per bucket and London day: opened, started (the first
-- touch of the form), sent (a waiting sign-up made) and confirmed (his
-- WhatsApp message made it active).
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261104180000_pool_funnel_steps/migration.sql
--
-- APPLY JUST BEFORE DEPLOYING THE CODE. Between the two, the code now live
-- writes its visit with ON CONFLICT ("code", "day"), which no longer names
-- the key: that write fails, is logged ("[pool-visit] not counted") and
-- swallowed, so /play is never affected, but visits in that window are not
-- counted. The live owner page keeps working (it groups by code only). The
-- new code would fail the same way without this migration, so apply first.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- One NEW column "step" on "PoolCampaignVisit" (TEXT NOT NULL DEFAULT
-- 'opened'): every existing row, a visit, becomes an opened row with its
-- count unchanged. A CHECK keeps "step" to the four steps. The primary key
-- goes from ("code", "day") to ("code", "day", "step"): the existing rows
-- are already unique on (code, day), so they are unique on the wider key
-- too. No row is added, changed or removed, and nothing about a person is
-- added (no id, no address, no user agent). The table is small (one row per
-- code and day): the key rebuild holds its lock for moments.
--
-- IDEMPOTENT: IF NOT EXISTS, constraints dropped and re-added.
-- ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect step 'opened' on every old row, the CHECK, and the wider key):
--   SELECT step, count(*) FROM "PoolCampaignVisit" GROUP BY step;
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('PoolCampaignVisit_step_check', 'PoolCampaignVisit_pkey');
--
-- Rolling back (only once no row has a step other than 'opened', i.e.
-- before the new code has counted anything, or after deleting those rows):
--   BEGIN;
--   DELETE FROM "PoolCampaignVisit" WHERE step <> 'opened';
--   ALTER TABLE "PoolCampaignVisit" DROP CONSTRAINT "PoolCampaignVisit_pkey";
--   ALTER TABLE "PoolCampaignVisit" ADD CONSTRAINT "PoolCampaignVisit_pkey" PRIMARY KEY ("code", "day");
--   ALTER TABLE "PoolCampaignVisit" DROP CONSTRAINT "PoolCampaignVisit_step_check";
--   ALTER TABLE "PoolCampaignVisit" DROP COLUMN "step";
--   COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "PoolCampaignVisit" ADD COLUMN IF NOT EXISTS "step" TEXT NOT NULL DEFAULT 'opened';

ALTER TABLE "PoolCampaignVisit" DROP CONSTRAINT IF EXISTS "PoolCampaignVisit_step_check";
ALTER TABLE "PoolCampaignVisit" ADD CONSTRAINT "PoolCampaignVisit_step_check"
  CHECK ("step" IN ('opened', 'started', 'sent', 'confirmed'));

ALTER TABLE "PoolCampaignVisit" DROP CONSTRAINT IF EXISTS "PoolCampaignVisit_pkey";
ALTER TABLE "PoolCampaignVisit" ADD CONSTRAINT "PoolCampaignVisit_pkey" PRIMARY KEY ("code", "day", "step");

COMMIT;
