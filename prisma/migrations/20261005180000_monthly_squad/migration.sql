-- Monthly squad, slice 2 (2026-10-05): settings, the month, its members
-- and the credits ledger. Plan: MDs/monthly-squad-plan-2026-10-05.md,
-- sections 3 and 4.5.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   1. Five columns on "Organisation":
--        "squadMode"                TEXT NOT NULL DEFAULT 'weekly'
--        "paygPricePence"           INTEGER (NULL)
--        "monthListOpensDaysBefore" INTEGER NOT NULL DEFAULT 7
--        "monthCreditRule"          TEXT NOT NULL DEFAULT 'any-miss'
--        "paymentInstructions"      TEXT (NULL)
--      Constant defaults, so no table rewrite on PG 11+. EVERY club that
--      exists when this runs, Sutton FC included, reads "weekly", which is
--      today's behaviour: nothing reads the other four unless the club is
--      "monthly", and only an OWNER or ADMIN on /admin/settings can make
--      it so.
--   2. Three new, empty tables: "SquadMonth" (one per club fixture per
--      calendar month), "SquadMonthMember" (one per person per month) and
--      "SquadCredit" (the credits ledger), with their indexes and foreign
--      keys ("Organisation", "Activity", "User": ON DELETE CASCADE; a
--      credit's two month links: ON DELETE SET NULL).
--   3. Thirteen CHECK constraints (the same DDL as
--      prisma/sql/monthly-squad-check.sql). Every existing "Organisation"
--      row satisfies its five (weekly, any-miss, NULL, 7, NULL), so adding
--      them cannot fail; the other eight are on the new, empty tables.
--
-- It does NOT drop, rename or rewrite anything, posts nothing, and changes
-- no query that does not name the new columns or tables.
--
-- Verify after applying:
--   SELECT "squadMode", "monthCreditRule", "monthListOpensDaysBefore", count(*)
--     FROM "Organisation" GROUP BY 1, 2, 3;   -- one row: weekly | any-miss | 7 | <all clubs>
--   SELECT count(*) FROM "Organisation"
--     WHERE "paygPricePence" IS NOT NULL OR "paymentInstructions" IS NOT NULL;  -- 0
--   SELECT count(*) FROM "SquadMonth";        -- 0
--   SELECT count(*) FROM "SquadMonthMember";  -- 0
--   SELECT count(*) FROM "SquadCredit";       -- 0
--   SELECT count(*) FROM pg_constraint
--     WHERE conname IN ('Organisation_squadMode_check', 'Organisation_monthCreditRule_check',
--       'Organisation_paygPricePence_check', 'Organisation_monthListOpensDaysBefore_check',
--       'Organisation_paymentInstructions_check')
--        OR (conname LIKE 'Squad%\_check' ESCAPE '\');   -- 13
--
-- Rolling back (roll the code back first: it selects "squadMode"):
--   BEGIN;
--   DROP TABLE "SquadCredit";
--   DROP TABLE "SquadMonthMember";
--   DROP TABLE "SquadMonth";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_squadMode_check";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_monthCreditRule_check";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_paygPricePence_check";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_monthListOpensDaysBefore_check";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_paymentInstructions_check";
--   ALTER TABLE "Organisation" DROP COLUMN "squadMode", DROP COLUMN "paygPricePence",
--     DROP COLUMN "monthListOpensDaysBefore", DROP COLUMN "monthCreditRule",
--     DROP COLUMN "paymentInstructions";
--   COMMIT;
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL and `db push` produces the same
-- tables and columns (db push never creates the CHECK constraints, which
-- is why they are here and in prisma/sql/monthly-squad-check.sql). Apply
-- THIS file (psql -f; it carries its own BEGIN/COMMIT).

BEGIN;

-- Fail fast rather than queue behind a long transaction holding a lock on
-- "Organisation", "Activity" or "User" (ALTER TABLE and ADD FOREIGN KEY
-- take locks every request would then wait behind). If this times out,
-- nothing is applied: re-run when the database is quiet.
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN     "monthCreditRule" TEXT NOT NULL DEFAULT 'any-miss',
ADD COLUMN     "monthListOpensDaysBefore" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "paygPricePence" INTEGER,
ADD COLUMN     "paymentInstructions" TEXT,
ADD COLUMN     "squadMode" TEXT NOT NULL DEFAULT 'weekly';

-- CreateTable
CREATE TABLE "SquadMonth" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "monthStart" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "gamesScheduled" INTEGER NOT NULL DEFAULT 0,
    "sharePerGamePence" INTEGER,
    "concessionPerGamePence" INTEGER,
    "newcomerPerGamePence" INTEGER,
    "venueCostPence" INTEGER,
    "payByAt" TIMESTAMP(3),
    "listOpenedAt" TIMESTAMP(3),
    "pricedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "summarySentAt" TIMESTAMP(3),
    "startedMidMonthAt" TIMESTAMP(3),
    "startedByUserId" TEXT,
    "gamesPlayedBeforeStart" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SquadMonth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquadMonthMember" (
    "id" TEXT NOT NULL,
    "monthId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'regular',
    "tier" TEXT NOT NULL DEFAULT 'standard',
    "slot" INTEGER,
    "paygMatchIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "absentMatchIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gamesCovered" INTEGER NOT NULL DEFAULT 0,
    "creditsApplied" INTEGER NOT NULL DEFAULT 0,
    "amountDuePence" INTEGER,
    "paidClaimedAt" TIMESTAMP(3),
    "paidClaimSource" TEXT,
    "paidClaimedAmountPence" INTEGER,
    "paidAt" TIMESTAMP(3),
    "paidAmountPence" INTEGER,
    "paidConfirmedByUserId" TEXT,
    "paymentMethod" TEXT,
    "stripeSessionId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'admin',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "refundedPence" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SquadMonthMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquadCredit" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "games" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT NOT NULL,
    "earnedMonthId" TEXT,
    "earnedMatchId" TEXT,
    "appliedMonthId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SquadCredit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SquadMonth_status_idx" ON "SquadMonth"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SquadMonth_orgId_activityId_monthStart_key" ON "SquadMonth"("orgId", "activityId", "monthStart");

-- CreateIndex
CREATE INDEX "SquadMonthMember_userId_idx" ON "SquadMonthMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SquadMonthMember_monthId_userId_key" ON "SquadMonthMember"("monthId", "userId");

-- CreateIndex
CREATE INDEX "SquadCredit_orgId_userId_idx" ON "SquadCredit"("orgId", "userId");

-- CreateIndex
CREATE INDEX "SquadCredit_earnedMonthId_idx" ON "SquadCredit"("earnedMonthId");

-- CreateIndex
CREATE INDEX "SquadCredit_appliedMonthId_idx" ON "SquadCredit"("appliedMonthId");

-- AddForeignKey
ALTER TABLE "SquadMonth" ADD CONSTRAINT "SquadMonth_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadMonth" ADD CONSTRAINT "SquadMonth_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadMonthMember" ADD CONSTRAINT "SquadMonthMember_monthId_fkey" FOREIGN KEY ("monthId") REFERENCES "SquadMonth"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadMonthMember" ADD CONSTRAINT "SquadMonthMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadCredit" ADD CONSTRAINT "SquadCredit_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadCredit" ADD CONSTRAINT "SquadCredit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadCredit" ADD CONSTRAINT "SquadCredit_earnedMonthId_fkey" FOREIGN KEY ("earnedMonthId") REFERENCES "SquadMonth"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadCredit" ADD CONSTRAINT "SquadCredit_appliedMonthId_fkey" FOREIGN KEY ("appliedMonthId") REFERENCES "SquadMonth"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK constraints (the same DDL as prisma/sql/monthly-squad-check.sql).
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_squadMode_check"
  CHECK ("squadMode" IN ('weekly', 'monthly'));

ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_monthCreditRule_check"
  CHECK ("monthCreditRule" IN ('any-miss', 'filled-only', 'none'));

ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_paygPricePence_check"
  CHECK ("paygPricePence" IS NULL OR ("paygPricePence" BETWEEN 1 AND 10000));

ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_monthListOpensDaysBefore_check"
  CHECK ("monthListOpensDaysBefore" BETWEEN 1 AND 28);

ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_paymentInstructions_check"
  CHECK ("paymentInstructions" IS NULL OR char_length("paymentInstructions") BETWEEN 1 AND 500);

ALTER TABLE "SquadMonth" ADD CONSTRAINT "SquadMonth_status_check"
  CHECK ("status" IN ('open', 'priced', 'running', 'closed'));

ALTER TABLE "SquadMonth" ADD CONSTRAINT "SquadMonth_monthStart_check"
  CHECK (EXTRACT(DAY FROM "monthStart") = 1);

ALTER TABLE "SquadMonth" ADD CONSTRAINT "SquadMonth_games_check"
  CHECK ("gamesScheduled" >= 0 AND "gamesPlayedBeforeStart" BETWEEN 0 AND "gamesScheduled");

ALTER TABLE "SquadMonthMember" ADD CONSTRAINT "SquadMonthMember_kind_check"
  CHECK ("kind" IN ('regular', 'payg'));

ALTER TABLE "SquadMonthMember" ADD CONSTRAINT "SquadMonthMember_tier_check"
  CHECK ("tier" IN ('standard', 'concession'));

ALTER TABLE "SquadMonthMember" ADD CONSTRAINT "SquadMonthMember_counts_check"
  CHECK ("gamesCovered" >= 0 AND "creditsApplied" BETWEEN 0 AND "gamesCovered");

ALTER TABLE "SquadCredit" ADD CONSTRAINT "SquadCredit_reason_check"
  CHECK ("reason" IN ('missed', 'cancelled-week', 'left-mid-month', 'manual', 'carried-in'));

ALTER TABLE "SquadCredit" ADD CONSTRAINT "SquadCredit_games_check"
  CHECK ("games" >= 1);

COMMIT;
