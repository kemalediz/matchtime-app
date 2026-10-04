-- Club billing month (slice P1, 2026-10-04): the games-played charge.
-- Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 2A and 3.6.
--
-- Each billed club is charged after each of its own billing months for the
-- games played (fee = price x played / scheduled, floored to the penny).
-- One "ClubBillingMonth" row records one such month. P1 only creates the
-- table: NOTHING writes it until slice P2, and BILLING_ENABLED stays off.
--
-- The CHECK constraints on "ClubBillingMonth":
--   1. "status" is one of the ten month states;
--   2. "amountPence" is NULL or at least 30 (Stripe's GBP minimum: a month
--      under 30p is "below-minimum" and stores no amount);
--   3. an invoiced, paid or failed month always names its Stripe invoice;
--   4. shape: index >= 1, endsAt after startsAt, a positive starting
--      price, refunds not negative, and played between 0 and scheduled.
--
-- IDEMPOTENT: safe to run repeatedly. Applied to production by
-- prisma/migrations/20261004120000_club_billing_month/migration.sql and to
-- the e2e database by e2e/run.ts after `prisma db push` (db push creates
-- tables, never CHECK constraints).

ALTER TABLE "ClubBillingMonth" DROP CONSTRAINT IF EXISTS "ClubBillingMonth_status_check";
ALTER TABLE "ClubBillingMonth" ADD CONSTRAINT "ClubBillingMonth_status_check"
  CHECK ("status" IN ('open', 'closing', 'no-games', 'below-minimum', 'waived', 'no-card',
                      'invoiced', 'paid', 'failed', 'void'));

ALTER TABLE "ClubBillingMonth" DROP CONSTRAINT IF EXISTS "ClubBillingMonth_amountPence_check";
ALTER TABLE "ClubBillingMonth" ADD CONSTRAINT "ClubBillingMonth_amountPence_check"
  CHECK ("amountPence" IS NULL OR "amountPence" >= 30);

ALTER TABLE "ClubBillingMonth" DROP CONSTRAINT IF EXISTS "ClubBillingMonth_invoiceId_check";
ALTER TABLE "ClubBillingMonth" ADD CONSTRAINT "ClubBillingMonth_invoiceId_check"
  CHECK ("status" NOT IN ('invoiced', 'paid', 'failed') OR "stripeInvoiceId" IS NOT NULL);

ALTER TABLE "ClubBillingMonth" DROP CONSTRAINT IF EXISTS "ClubBillingMonth_shape_check";
ALTER TABLE "ClubBillingMonth" ADD CONSTRAINT "ClubBillingMonth_shape_check"
  CHECK (
    "index" >= 1
    AND "endsAt" > "startsAt"
    AND "priceAtStartPence" > 0
    AND "refundedPence" >= 0
    AND ("scheduled" IS NULL OR "scheduled" >= 0)
    AND ("played" IS NULL OR ("played" >= 0 AND "scheduled" IS NOT NULL AND "played" <= "scheduled"))
  );
