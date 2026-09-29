-- Self-join slice 3, the platform channel (2026-09-29).
-- Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 3.3, 7 and 12.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive, and safe to run twice (every statement is IF NOT EXISTS).
--   * One new, empty table, "PlatformJob": DMs and actions that belong to no
--     live club (sign-up codes first; the connect reply, the owner's approval
--     DM, the organiser's decision DM and leaving a group in later slices).
--   * One NULLABLE column on "PhoneOtp", "requestIp", for the per-IP sign-up
--     cap. Existing rows stay NULL, which the cap reads as "not attributable".
--   * Two indexes on "PhoneOtp" (per-IP count; site-wide daily count).
--
-- It does NOT drop, rename or rewrite anything.
--
-- ORDER: apply this BEFORE the server that reads it goes live. The sign-up
-- action writes "PhoneOtp"."requestIp" and "PlatformJob" on every request.
--
-- Verify after applying (expect 0, and the new column listed):
--   SELECT COUNT(*) FROM "PlatformJob";
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'PhoneOtp' AND column_name = 'requestIp';
--
-- Rolling back:
--   DROP TABLE IF EXISTS "PlatformJob";
--   DROP INDEX IF EXISTS "PhoneOtp_requestIp_createdAt_idx";
--   DROP INDEX IF EXISTS "PhoneOtp_createdAt_idx";
--   ALTER TABLE "PhoneOtp" DROP COLUMN IF EXISTS "requestIp";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this file
-- is the canonical, reviewable DDL.

-- AlterTable
ALTER TABLE "PhoneOtp" ADD COLUMN IF NOT EXISTS "requestIp" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "PlatformJob" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "phone" TEXT,
    "groupId" TEXT,
    "text" TEXT,
    "purpose" TEXT NOT NULL,
    "refId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "sendAfter" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failReason" TEXT,
    "waMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlatformJob_status_sendAfter_idx" ON "PlatformJob"("status", "sendAfter");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlatformJob_purpose_refId_idx" ON "PlatformJob"("purpose", "refId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PlatformJob_kind_groupId_idx" ON "PlatformJob"("kind", "groupId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PhoneOtp_requestIp_createdAt_idx" ON "PhoneOtp"("requestIp", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PhoneOtp_createdAt_idx" ON "PhoneOtp"("createdAt");
