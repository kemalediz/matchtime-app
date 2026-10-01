-- Club fee billing on "Organisation" (slice B1, 2026-10-01).
-- Plan: MDs/club-fee-billing-plan-2026-10-01.md, section 3.1.
--
-- The billing state, the plan and the custom price are each one of their
-- choices and nothing else, so a typo can never become a seventh state
-- that one reader treats as "paused" and another as "serving":
--   1. billingStatus is one of the six states;
--   2. billingPlan is one of the three plans;
--   3. a custom price is set exactly when the plan is "custom", and is
--      between 100 and 999 pence (GBP 1.00 to GBP 9.99);
--   4. a Free plan is always "exempt" (never billed, never paused);
--   5. a club that predates self-join ("approvedAt" NULL: Sutton FC and
--      every club approved by the column default) is always "exempt". This
--      is the database's own lock on "Sutton FC is never billed and never
--      paused", whatever any code path does. ("approvedAt" is written only
--      by an approval decision and never cleared, club-approval.ts.)
--
-- IDEMPOTENT: safe to run repeatedly. Applied to production by
-- prisma/migrations/20261001200000_club_billing/migration.sql and to the
-- e2e database by e2e/run.ts after `prisma db push` (db push creates
-- columns, never CHECK constraints).

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
