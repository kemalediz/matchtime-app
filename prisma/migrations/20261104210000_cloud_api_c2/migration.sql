-- WhatsApp Cloud API, PR C2: the schema (2026-11-04). Plan:
-- MDs/whatsapp-cloud-api-plan-2026-11-04.md sections 5.2, 5.5, 5.6, 5.10.
-- Every PlatformJob now says which number sends it ("baileys", the club
-- number on the Pi, or "cloud", the official number), and the Pi only ever
-- claims "baileys". Two new tables for the Cloud side: WaInbound (one row
-- per inbound message, for dedupe and retry) and CloudTemplateStatus (one
-- row per Meta template and language). Nothing writes a "cloud" job, a
-- WaInbound row or a CloudTemplateStatus row yet: the flags are off.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261104210000_cloud_api_c2/migration.sql
--
-- APPLY BEFORE DEPLOYING THE C2 CODE. The C2 code writes "channel" on every
-- queued DM and filters the Pi's claim on it: without this migration every
-- queued DM and every platform-jobs poll would fail (column does not
-- exist). The code live now keeps working against the new schema: it never
-- names the new columns, so its inserts get "channel" = 'baileys' from the
-- default and its claim reads them as before.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- "PlatformJob": seven NEW columns. "channel" TEXT NOT NULL DEFAULT
-- 'baileys' (a constant default: Postgres 11+ adds it without rewriting the
-- table, and every existing row reads 'baileys', which is what it was);
-- "templateName", "templateLang", "templateParams" (JSONB), "deliveredAt",
-- "readAt", "errorCode" (INTEGER), all nullable and NULL on every row. One
-- NEW index on "waMessageId" (the status webhook finds a job by its wamid).
-- Three CHECKs (the channel is one of two; a template has both its name
-- and its language; parameters only with a template); every existing row
-- passes them, because the new columns are 'baileys' and NULL.
-- Two NEW, empty tables "WaInbound" and "CloudTemplateStatus", with their
-- indexes and CHECKs. No row is added, changed or removed anywhere.
-- Locks: the PlatformJob ALTERs and the index build hold their locks for
-- moments (a small table; lock_timeout 5s, so a busy moment fails the
-- migration cleanly instead of queueing behind it; re-run it).
--
-- The CHECKs here are the same statements as prisma/sql/cloud-api-check.sql
-- (pinned by src/lib/__tests__/cloud-api-schema-sql.test.ts).
--
-- IDEMPOTENT: IF NOT EXISTS, CHECKs dropped and re-added.
-- ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect every row 'baileys'; 3 + 4 + 6 CHECKs; both tables empty):
--   SELECT channel, count(*) FROM "PlatformJob" GROUP BY channel;
--   SELECT conrelid::regclass, conname FROM pg_constraint
--     WHERE conrelid IN ('"PlatformJob"'::regclass, '"WaInbound"'::regclass, '"CloudTemplateStatus"'::regclass)
--       AND contype = 'c' ORDER BY 1, 2;
--   SELECT (SELECT count(*) FROM "WaInbound") AS inbound, (SELECT count(*) FROM "CloudTemplateStatus") AS templates;
--   SELECT indexname FROM pg_indexes WHERE tablename IN ('PlatformJob', 'WaInbound') ORDER BY 1;
--
-- Rolling back (only AFTER the C2 code is reverted, since it writes and
-- reads "channel"; and only while no row is 'cloud' and both new tables are
-- empty, which holds while the flags are off):
--   BEGIN;
--   DROP TABLE IF EXISTS "CloudTemplateStatus";
--   DROP TABLE IF EXISTS "WaInbound";
--   DROP INDEX IF EXISTS "PlatformJob_waMessageId_idx";
--   ALTER TABLE "PlatformJob" DROP CONSTRAINT IF EXISTS "PlatformJob_templateParams_check";
--   ALTER TABLE "PlatformJob" DROP CONSTRAINT IF EXISTS "PlatformJob_template_check";
--   ALTER TABLE "PlatformJob" DROP CONSTRAINT IF EXISTS "PlatformJob_channel_check";
--   ALTER TABLE "PlatformJob" DROP COLUMN IF EXISTS "errorCode", DROP COLUMN IF EXISTS "readAt",
--     DROP COLUMN IF EXISTS "deliveredAt", DROP COLUMN IF EXISTS "templateParams",
--     DROP COLUMN IF EXISTS "templateLang", DROP COLUMN IF EXISTS "templateName",
--     DROP COLUMN IF EXISTS "channel";
--   COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';

-- PlatformJob: the channel, and what the Cloud dispatcher and webhook fill later.
ALTER TABLE "PlatformJob" ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'baileys';
ALTER TABLE "PlatformJob" ADD COLUMN IF NOT EXISTS "templateName" TEXT;
ALTER TABLE "PlatformJob" ADD COLUMN IF NOT EXISTS "templateLang" TEXT;
ALTER TABLE "PlatformJob" ADD COLUMN IF NOT EXISTS "templateParams" JSONB;
ALTER TABLE "PlatformJob" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
ALTER TABLE "PlatformJob" ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMP(3);
ALTER TABLE "PlatformJob" ADD COLUMN IF NOT EXISTS "errorCode" INTEGER;
CREATE INDEX IF NOT EXISTS "PlatformJob_waMessageId_idx" ON "PlatformJob"("waMessageId");

-- WaInbound: one row per inbound message.
CREATE TABLE IF NOT EXISTS "WaInbound" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "wamid" TEXT NOT NULL,
    "phone" TEXT,
    "waUserId" TEXT,
    "payload" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "result" TEXT,

    CONSTRAINT "WaInbound_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WaInbound_channel_wamid_key" ON "WaInbound"("channel", "wamid");
CREATE INDEX IF NOT EXISTS "WaInbound_processedAt_receivedAt_idx" ON "WaInbound"("processedAt", "receivedAt");
CREATE INDEX IF NOT EXISTS "WaInbound_phone_channel_receivedAt_idx" ON "WaInbound"("phone", "channel", "receivedAt");

-- CloudTemplateStatus: one row per Meta template and language.
CREATE TABLE IF NOT EXISTS "CloudTemplateStatus" (
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "metaTemplateId" TEXT,
    "status" TEXT NOT NULL,
    "category" TEXT,
    "previousCategory" TEXT,
    "qualityScore" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudTemplateStatus_pkey" PRIMARY KEY ("name", "language")
);

-- The CHECKs (the same statements as prisma/sql/cloud-api-check.sql).
ALTER TABLE "PlatformJob" DROP CONSTRAINT IF EXISTS "PlatformJob_channel_check";
ALTER TABLE "PlatformJob" ADD CONSTRAINT "PlatformJob_channel_check"
  CHECK ("channel" IN ('baileys', 'cloud'));
ALTER TABLE "PlatformJob" DROP CONSTRAINT IF EXISTS "PlatformJob_template_check";
ALTER TABLE "PlatformJob" ADD CONSTRAINT "PlatformJob_template_check"
  CHECK (("templateName" IS NULL) = ("templateLang" IS NULL));
ALTER TABLE "PlatformJob" DROP CONSTRAINT IF EXISTS "PlatformJob_templateParams_check";
ALTER TABLE "PlatformJob" ADD CONSTRAINT "PlatformJob_templateParams_check"
  CHECK ("templateParams" IS NULL OR "templateName" IS NOT NULL);

ALTER TABLE "WaInbound" DROP CONSTRAINT IF EXISTS "WaInbound_channel_check";
ALTER TABLE "WaInbound" ADD CONSTRAINT "WaInbound_channel_check"
  CHECK ("channel" IN ('baileys', 'cloud'));
ALTER TABLE "WaInbound" DROP CONSTRAINT IF EXISTS "WaInbound_sender_check";
ALTER TABLE "WaInbound" ADD CONSTRAINT "WaInbound_sender_check"
  CHECK ("phone" IS NOT NULL OR "waUserId" IS NOT NULL);
ALTER TABLE "WaInbound" DROP CONSTRAINT IF EXISTS "WaInbound_phone_check";
ALTER TABLE "WaInbound" ADD CONSTRAINT "WaInbound_phone_check"
  CHECK ("phone" IS NULL OR "phone" ~ '^[0-9]{8,15}$');
ALTER TABLE "WaInbound" DROP CONSTRAINT IF EXISTS "WaInbound_attempts_check";
ALTER TABLE "WaInbound" ADD CONSTRAINT "WaInbound_attempts_check"
  CHECK ("attempts" >= 0);

ALTER TABLE "CloudTemplateStatus" DROP CONSTRAINT IF EXISTS "CloudTemplateStatus_name_check";
ALTER TABLE "CloudTemplateStatus" ADD CONSTRAINT "CloudTemplateStatus_name_check"
  CHECK ("name" ~ '^[a-z0-9_]+$' AND char_length("name") <= 512);
ALTER TABLE "CloudTemplateStatus" DROP CONSTRAINT IF EXISTS "CloudTemplateStatus_language_check";
ALTER TABLE "CloudTemplateStatus" ADD CONSTRAINT "CloudTemplateStatus_language_check"
  CHECK ("language" ~ '^[a-z]{2,3}(_[A-Z]{2})?$');
ALTER TABLE "CloudTemplateStatus" DROP CONSTRAINT IF EXISTS "CloudTemplateStatus_status_check";
ALTER TABLE "CloudTemplateStatus" ADD CONSTRAINT "CloudTemplateStatus_status_check"
  CHECK ("status" ~ '^[A-Z_]{1,64}$');
ALTER TABLE "CloudTemplateStatus" DROP CONSTRAINT IF EXISTS "CloudTemplateStatus_category_check";
ALTER TABLE "CloudTemplateStatus" ADD CONSTRAINT "CloudTemplateStatus_category_check"
  CHECK ("category" IS NULL OR "category" IN ('UTILITY', 'MARKETING', 'AUTHENTICATION'));
ALTER TABLE "CloudTemplateStatus" DROP CONSTRAINT IF EXISTS "CloudTemplateStatus_previousCategory_check";
ALTER TABLE "CloudTemplateStatus" ADD CONSTRAINT "CloudTemplateStatus_previousCategory_check"
  CHECK ("previousCategory" IS NULL OR "previousCategory" IN ('UTILITY', 'MARKETING', 'AUTHENTICATION'));
ALTER TABLE "CloudTemplateStatus" DROP CONSTRAINT IF EXISTS "CloudTemplateStatus_qualityScore_check";
ALTER TABLE "CloudTemplateStatus" ADD CONSTRAINT "CloudTemplateStatus_qualityScore_check"
  CHECK ("qualityScore" IS NULL OR "qualityScore" ~ '^[A-Z_]{1,32}$');

COMMIT;
