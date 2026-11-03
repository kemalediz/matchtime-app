-- Visits to /play per campaign code (2026-11-03), and Facebook and Nextdoor
-- as campaign sources. A code attributed sign-ups but nothing counted the
-- visits, so a post with no sign-ups (Nextdoor, 764 views) could not say
-- whether people clicked and gave up or never clicked.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261104120000_pool_campaign_visits/migration.sql
--
-- APPLY BEFORE DEPLOYING THE CODE: the owner's source codes page reads
-- "PoolCampaignVisit" (it would fail without the table), and the owner form
-- offers 'facebook' and 'nextdoor' (refused by the old CHECK). The /play
-- beacon itself only logs a failed write, so /play is never affected.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One NEW table "PoolCampaignVisit" (code, London day,
-- count; no foreign key, nothing about a person). "PoolCampaign_source_check"
-- gains 'facebook' and 'nextdoor': every existing row still passes it. No
-- existing row is changed.
--
-- IDEMPOTENT: IF NOT EXISTS, constraints dropped and re-added.
-- ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect "PoolCampaignVisit", then a CHECK naming 'nextdoor'):
--   SELECT to_regclass('"PoolCampaignVisit"');
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'PoolCampaign_source_check';
--
-- Rolling back:
--   DROP TABLE IF EXISTS "PoolCampaignVisit";
--   (and "PoolCampaign_source_check" back without 'facebook' and 'nextdoor', once no row has them)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "PoolCampaignVisit" (
    "code" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PoolCampaignVisit_pkey" PRIMARY KEY ("code", "day")
);

ALTER TABLE "PoolCampaignVisit" DROP CONSTRAINT IF EXISTS "PoolCampaignVisit_code_check";
ALTER TABLE "PoolCampaignVisit" ADD CONSTRAINT "PoolCampaignVisit_code_check"
  CHECK ("code" IN ('_direct', '_referral') OR ("code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("code") <= 32));
ALTER TABLE "PoolCampaignVisit" DROP CONSTRAINT IF EXISTS "PoolCampaignVisit_count_check";
ALTER TABLE "PoolCampaignVisit" ADD CONSTRAINT "PoolCampaignVisit_count_check"
  CHECK ("count" >= 0);

ALTER TABLE "PoolCampaign" DROP CONSTRAINT IF EXISTS "PoolCampaign_source_check";
ALTER TABLE "PoolCampaign" ADD CONSTRAINT "PoolCampaign_source_check"
  CHECK ("source" IN ('linkedin', 'leaflet', 'facebook', 'nextdoor', 'club', 'other'));

COMMIT;
