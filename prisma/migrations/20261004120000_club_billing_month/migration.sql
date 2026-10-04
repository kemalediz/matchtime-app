-- Club fee billing, slice P1 (2026-10-04): the games-played billing month.
-- Plan: MDs/club-fee-billing-plan-2026-10-01.md, sections 2A and 3.6.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   1. One new, EMPTY table "ClubBillingMonth" (one row per billing month
--      of a billed club), FK to "Organisation" ON DELETE CASCADE, a unique
--      (orgId, index), a unique "stripeInvoiceId" and an index on "status".
--   2. Four CHECK constraints on the new table (the same DDL as
--      prisma/sql/club-billing-month-check.sql). The table is empty, so
--      adding them cannot fail.
--
-- It does NOT touch any existing table's columns or rows. The only lock on
-- an existing table is the brief SHARE ROW EXCLUSIVE lock on
-- "Organisation" that adding the foreign key takes (it blocks writes to
-- "Organisation" for the instant it takes to validate an empty table, not
-- reads). Nothing in P1 writes the table; with BILLING_ENABLED unset (the
-- default) no code path ever will.
--
-- The "mt.paused" and "mt.resumed" BillingEvent rows that P1 also adds
-- need no schema change ("BillingEvent"."type" is free text).
--
-- Verify after applying:
--   SELECT count(*) FROM "ClubBillingMonth";                                   -- 0
--   SELECT conname FROM pg_constraint WHERE conname LIKE 'ClubBillingMonth_%'
--     ORDER BY 1;  -- amountPence_check, invoiceId_check, orgId_fkey, pkey,
--                  -- shape_check, status_check (6 rows)
--   SELECT indexname FROM pg_indexes WHERE tablename = 'ClubBillingMonth'
--     ORDER BY 1;  -- orgId_index_key, pkey, status_idx, stripeInvoiceId_key
--
-- Rolling back (safe while the table is empty, i.e. before P2 ships):
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   DROP TABLE "ClubBillingMonth";
--   COMMIT;
-- (Roll the code back first once P2 is merged: P2 reads and writes it. The
-- P1 code itself never names the table, so P1 can stay deployed without it.)
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL and `db push` produces the same
-- table (db push never creates the CHECK constraints, which is why they
-- are here and in prisma/sql/club-billing-month-check.sql). It carries its
-- own BEGIN/COMMIT for psql -f.

BEGIN;

-- Fail fast rather than queue behind a long transaction holding a lock on
-- "Organisation" (the foreign key needs a lock on it, and every request
-- queued behind it would wait too). If this times out, nothing is applied:
-- re-run when the database is quiet.
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "ClubBillingMonth" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "priceAtStartPence" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "scheduled" INTEGER,
    "played" INTEGER,
    "pricePence" INTEGER,
    "amountPence" INTEGER,
    "reason" TEXT,
    "games" JSONB,
    "stripeInvoiceId" TEXT,
    "closedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "refundedPence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubBillingMonth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubBillingMonth_stripeInvoiceId_key" ON "ClubBillingMonth"("stripeInvoiceId");

-- CreateIndex
CREATE INDEX "ClubBillingMonth_status_idx" ON "ClubBillingMonth"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ClubBillingMonth_orgId_index_key" ON "ClubBillingMonth"("orgId", "index");

-- AddForeignKey
ALTER TABLE "ClubBillingMonth" ADD CONSTRAINT "ClubBillingMonth_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CHECK constraints (same DDL as prisma/sql/club-billing-month-check.sql)
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

COMMIT;
