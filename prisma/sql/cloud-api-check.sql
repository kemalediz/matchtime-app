-- The WhatsApp Cloud API tables' CHECK constraints (PR C2, 2026-11-04).
-- Plan: MDs/whatsapp-cloud-api-plan-2026-11-04.md sections 5.2, 5.5, 5.6.
--
--   PlatformJob          a job's channel is one of the two numbers; a
--                        template has both its name and its language, and
--                        parameters only with a template.
--   WaInbound            the channel is one of the two numbers; the sender
--                        is named by phone (digits, no "+") or by Meta's
--                        user id; attempts never negative.
--   CloudTemplateStatus  Meta's spelling of a name, a language, a status
--                        and a quality rating; a category (and the one
--                        before a re-categorisation) is one of Meta's three.
--
-- The channel values are SEND_CHANNELS in src/lib/send-channel.ts and the
-- categories CLOUD_TEMPLATE_CATEGORIES in src/lib/cloud-api/vocab.ts,
-- pinned here by src/lib/__tests__/cloud-api-schema-sql.test.ts. A
-- template's status is deliberately a pattern, not a list: Meta adds
-- statuses, and a webhook carrying a new one must still be recorded.
--
-- IDEMPOTENT: safe to run repeatedly. Applied to production by
-- prisma/migrations/20261104210000_cloud_api_c2/migration.sql and to the
-- e2e database by e2e/run.ts after `prisma db push` (db push creates
-- columns and indexes, never CHECK constraints).
--
-- ONE TRANSACTION: a re-run swaps each CHECK whole or not at all.

BEGIN;

-- PlatformJob
ALTER TABLE "PlatformJob" DROP CONSTRAINT IF EXISTS "PlatformJob_channel_check";
ALTER TABLE "PlatformJob" ADD CONSTRAINT "PlatformJob_channel_check"
  CHECK ("channel" IN ('baileys', 'cloud'));
ALTER TABLE "PlatformJob" DROP CONSTRAINT IF EXISTS "PlatformJob_template_check";
ALTER TABLE "PlatformJob" ADD CONSTRAINT "PlatformJob_template_check"
  CHECK (("templateName" IS NULL) = ("templateLang" IS NULL));
ALTER TABLE "PlatformJob" DROP CONSTRAINT IF EXISTS "PlatformJob_templateParams_check";
ALTER TABLE "PlatformJob" ADD CONSTRAINT "PlatformJob_templateParams_check"
  CHECK ("templateParams" IS NULL OR "templateName" IS NOT NULL);

-- WaInbound
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

-- CloudTemplateStatus
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
