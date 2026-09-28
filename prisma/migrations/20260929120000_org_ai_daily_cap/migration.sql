-- The daily AI spend cap, per club (2026-09-29). See src/lib/ai-budget.ts.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. Two NULLABLE columns on "Organisation" (NULL means
-- "use the rule": $0.25/day for the first 28 days from createdAt, $1.00/day
-- after), and one new table, "OrgAiUsage", one row per club per London
-- calendar day. No backfill, nothing dropped or renamed, and no existing
-- query changes behaviour. Sutton FC reads NULL for both columns and gets
-- $1.00/day, being long past its first four weeks.
--
-- "OrgAiUsage"."orgId" is deliberately NOT a foreign key: spend before a
-- club exists is keyed "onboarding-group:<groupId>" or
-- "onboarding-user:<userId>".
--
-- THE CODE FAILS OPEN WITHOUT THIS: if the table is missing, every model
-- call is allowed and the failure is logged. Apply it BEFORE merging so
-- the cap is live from the first deploy.
--
-- Rolling back:
--   DROP TABLE "OrgAiUsage";
--   ALTER TABLE "Organisation" DROP COLUMN "aiDailyCapUsd", DROP COLUMN "aiWindowStartAt";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL and `prisma db push` produces an
-- identical result.

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN     "aiDailyCapUsd" DOUBLE PRECISION,
ADD COLUMN     "aiWindowStartAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OrgAiUsage" (
    "orgId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reservedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "refusedCalls" INTEGER NOT NULL DEFAULT 0,
    "skippedMessages" INTEGER NOT NULL DEFAULT 0,
    "capUsd" DOUBLE PRECISION,
    "cappedAt" TIMESTAMP(3),
    "capReplySentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgAiUsage_pkey" PRIMARY KEY ("orgId","day")
);

-- CreateIndex
CREATE INDEX "OrgAiUsage_day_idx" ON "OrgAiUsage"("day");
