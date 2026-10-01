-- Club fee billing, slice B1 (2026-10-01): schema, rules and the quiet gate.
-- Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 3 and 4.3.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   1. Three columns on "Organisation":
--        "billingStatus"     TEXT NOT NULL DEFAULT 'exempt'
--        "billingPlan"       TEXT NOT NULL DEFAULT 'standard'
--        "billingPricePence" INTEGER (NULL)
--      Postgres 11+ stores a constant default in the catalog: no table
--      rewrite. EVERY club that exists when this runs, Sutton FC and every
--      club that predates self-join included, reads "exempt": never billed,
--      never paused. Nothing in B1 ever moves a club out of "exempt".
--   2. Five CHECK constraints on "Organisation" (the same DDL as
--      prisma/sql/org-billing-check.sql): billingStatus in the six states,
--      billingPlan in the three plans, a custom price exactly when the plan
--      is custom (100 to 999 pence), a Free plan is always exempt, and a
--      club that predates self-join ("approvedAt" NULL, Sutton FC) is
--      always exempt. Every existing row satisfies them (exempt, standard,
--      NULL), so adding them cannot fail.
--   3. Three new, empty tables: "ClubBilling" (one row per billed club,
--      FK to "Organisation" ON DELETE CASCADE), "BillingEvent" (Stripe
--      webhook audit, no FK on purpose) and "BillingNotice" (one DM per
--      club, kind and cycle; unique (orgId, kind, cycleKey); FK CASCADE).
--
-- It does NOT drop, rename or rewrite anything, and changes no query that
-- does not name the new columns or tables. With BILLING_ENABLED unset (the
-- default) the code ignores "billingStatus" entirely.
--
-- Verify after applying:
--   SELECT "billingStatus", "billingPlan", count(*) FROM "Organisation"
--     GROUP BY 1, 2;                                         -- one row: exempt | standard | <all clubs>
--   SELECT count(*) FROM "Organisation" WHERE "billingPricePence" IS NOT NULL;  -- 0
--   SELECT conname FROM pg_constraint WHERE conname LIKE 'Organisation_billing%';  -- 5 rows
--   SELECT count(*) FROM "ClubBilling";    -- 0
--   SELECT count(*) FROM "BillingEvent";   -- 0
--   SELECT count(*) FROM "BillingNotice";  -- 0
--
-- Rolling back:
--   BEGIN;
--   DROP TABLE "BillingNotice";
--   DROP TABLE "BillingEvent";
--   DROP TABLE "ClubBilling";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_billingStatus_check";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_billingPlan_check";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_billingPricePence_check";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_billingFreeExempt_check";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_billingPreSelfJoinExempt_check";
--   ALTER TABLE "Organisation" DROP COLUMN "billingStatus",
--     DROP COLUMN "billingPlan", DROP COLUMN "billingPricePence";
--   COMMIT;
-- (Roll the code back first: the B1 code selects "billingStatus".)
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL and `db push` produces the same
-- tables and columns (db push never creates the CHECK constraints, which
-- is why they are here and in prisma/sql/org-billing-check.sql). It
-- carries its own BEGIN/COMMIT for psql -f.

BEGIN;

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN     "billingPlan" TEXT NOT NULL DEFAULT 'standard',
ADD COLUMN     "billingPricePence" INTEGER,
ADD COLUMN     "billingStatus" TEXT NOT NULL DEFAULT 'exempt';

-- CreateTable
CREATE TABLE "ClubBilling" (
    "orgId" TEXT NOT NULL,
    "trialStartedAt" TIMESTAMP(3) NOT NULL,
    "trialEndsAt" TIMESTAMP(3) NOT NULL,
    "graceEndsAt" TIMESTAMP(3),
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripeSubscriptionStatus" TEXT,
    "stripePriceId" TEXT,
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "stripePaymentMethodId" TEXT,
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "cardHolderUserId" TEXT,
    "paymentFailedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "pausedReason" TEXT,
    "billingCountry" TEXT,
    "cardCountry" TEXT,
    "vatCountryCheck" BOOLEAN NOT NULL DEFAULT false,
    "resumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubBilling_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "orgId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingNotice" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "cycleKey" TEXT NOT NULL,
    "platformJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubBilling_stripeCustomerId_key" ON "ClubBilling"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubBilling_stripeSubscriptionId_key" ON "ClubBilling"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "BillingEvent_orgId_receivedAt_idx" ON "BillingEvent"("orgId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingNotice_orgId_kind_cycleKey_key" ON "BillingNotice"("orgId", "kind", "cycleKey");

-- AddForeignKey
ALTER TABLE "ClubBilling" ADD CONSTRAINT "ClubBilling_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingNotice" ADD CONSTRAINT "BillingNotice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECK constraints (same DDL as prisma/sql/org-billing-check.sql)
ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_billingStatus_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_billingStatus_check"
  CHECK ("billingStatus" IN ('exempt', 'trial', 'grace', 'subscribed', 'past_due', 'paused'));

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_billingPlan_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_billingPlan_check"
  CHECK ("billingPlan" IN ('standard', 'free', 'custom'));

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_billingPricePence_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_billingPricePence_check"
  CHECK (
    ("billingPlan" = 'custom') = ("billingPricePence" IS NOT NULL AND "billingPricePence" BETWEEN 100 AND 999)
  );

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_billingFreeExempt_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_billingFreeExempt_check"
  CHECK ("billingPlan" <> 'free' OR "billingStatus" = 'exempt');

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_billingPreSelfJoinExempt_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_billingPreSelfJoinExempt_check"
  CHECK ("approvedAt" IS NOT NULL OR "billingStatus" = 'exempt');

COMMIT;
