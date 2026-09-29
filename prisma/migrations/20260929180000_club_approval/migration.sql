-- Club approval for self-join, slice 1: schema and silence rails (2026-09-29).
-- Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 3 and 12.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   * Four columns on "Organisation". "approvalStatus" is NOT NULL with
--     DEFAULT 'approved': that default IS the backfill. Postgres fills every
--     existing row with 'approved' as the column is added (a constant
--     default, so no table rewrite on PG 11+), which makes Sutton FC
--     (cmnnwhdx30000zfr85q18lyy9) and every other existing club approved.
--     "approvedAt", "approvalDecidedAt" and "approvalDecidedBy" are NULLABLE
--     and stay NULL for every existing club. A NULL "approvedAt" leaves the
--     club's AI window exactly where it is today (aiWindowStartAt, else
--     createdAt).
--   * Two new, empty tables: "ClubConnect" (FK to Organisation, ON DELETE
--     CASCADE) and "UnsolicitedGroup". Nothing writes to them yet.
--   * Two CHECK constraints (the same DDL as prisma/sql/org-approval-check.sql):
--     the five legal states, and "the bot can only be ON for an approved
--     club". Every existing row satisfies both once the default has filled.
--
-- It does NOT drop, rename or rewrite anything, and changes no query that
-- does not name the new columns.
--
-- Verify after applying (expect every row 'approved', and zero rows):
--   SELECT id, name, "approvalStatus", "approvedAt" FROM "Organisation";
--   SELECT id FROM "Organisation" WHERE "whatsappBotEnabled" AND "approvalStatus" <> 'approved';
--
-- Rolling back:
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_bot_requires_approval";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_approvalStatus_check";
--   DROP TABLE IF EXISTS "UnsolicitedGroup";
--   DROP TABLE IF EXISTS "ClubConnect";
--   ALTER TABLE "Organisation" DROP COLUMN "approvalStatus", DROP COLUMN "approvedAt",
--     DROP COLUMN "approvalDecidedAt", DROP COLUMN "approvalDecidedBy";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. `prisma db push` creates the
-- columns and tables but NOT the CHECK constraints, so apply this file.

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN     "approvalDecidedAt" TIMESTAMP(3),
ADD COLUMN     "approvalDecidedBy" TEXT,
ADD COLUMN     "approvalStatus" TEXT NOT NULL DEFAULT 'approved',
ADD COLUMN     "approvedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ClubConnect" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "dmAt" TIMESTAMP(3),
    "dmPhone" TEXT,
    "dmLid" TEXT,
    "dmPhoneMatched" BOOLEAN,
    "dmWaMessageId" TEXT,
    "lastMismatchAt" TIMESTAMP(3),
    "lastMismatchPhoneMasked" TEXT,
    "addWindowEndsAt" TIMESTAMP(3),
    "groupId" TEXT,
    "groupSubject" TEXT,
    "memberCount" INTEGER,
    "addedByPhone" TEXT,
    "addedByLid" TEXT,
    "adderMatch" TEXT,
    "participants" JSONB,
    "detectedLang" TEXT,
    "linkedAt" TIMESTAMP(3),
    "ownerDmQueuedAt" TIMESTAMP(3),
    "botRemovedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubConnect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnsolicitedGroup" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "subject" TEXT,
    "memberCount" INTEGER,
    "addedByPhone" TEXT,
    "addedByLid" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "UnsolicitedGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubConnect_dmWaMessageId_key" ON "ClubConnect"("dmWaMessageId");

-- CreateIndex
CREATE INDEX "ClubConnect_code_status_idx" ON "ClubConnect"("code", "status");

-- CreateIndex
CREATE INDEX "ClubConnect_orgId_status_idx" ON "ClubConnect"("orgId", "status");

-- CreateIndex
CREATE INDEX "ClubConnect_groupId_idx" ON "ClubConnect"("groupId");

-- CreateIndex
CREATE INDEX "UnsolicitedGroup_groupId_leftAt_idx" ON "UnsolicitedGroup"("groupId", "leftAt");

-- AddForeignKey
ALTER TABLE "ClubConnect" ADD CONSTRAINT "ClubConnect_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CHECK constraints (prisma/sql/org-approval-check.sql)
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_approvalStatus_check"
  CHECK ("approvalStatus" IN ('draft', 'pending', 'approved', 'rejected', 'suspended'));
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_bot_requires_approval"
  CHECK (NOT "whatsappBotEnabled" OR "approvalStatus" = 'approved');
