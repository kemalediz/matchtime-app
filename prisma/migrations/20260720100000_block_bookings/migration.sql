-- Block bookings (2026-07-20).
--
-- A BlockBooking represents the club's real venue booking: N consecutive
-- weekly matches paid up-front (Sutton FC: 10 Tuesdays, 25 Aug → 27 Oct
-- 2026). All Match rows are created up-front and linked back via
-- Match."blockBookingId" so a block can be listed, bulk-cancelled and
-- deleted as a set.
--
-- NOTE ON APPLYING: this repo historically manages schema with
-- `prisma db push` (no full migration history). This file is the
-- canonical, reviewable DDL for the change. Apply either by running this
-- SQL directly against the database, or via `prisma db push` (the change
-- is purely additive — one new table, one nullable FK column on "Match" —
-- so db push is safe on the live DB; no data backfill is required).

-- CreateTable
CREATE TABLE "BlockBooking" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "time" TEXT NOT NULL,
    "costPerMatch" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlockBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BlockBooking_orgId_idx" ON "BlockBooking"("orgId");

-- CreateIndex
CREATE INDEX "BlockBooking_activityId_idx" ON "BlockBooking"("activityId");

-- AddForeignKey
ALTER TABLE "BlockBooking" ADD CONSTRAINT "BlockBooking_activityId_fkey"
    FOREIGN KEY ("activityId") REFERENCES "Activity"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable (additive, nullable — zero impact on existing rows)
ALTER TABLE "Match" ADD COLUMN "blockBookingId" TEXT;

-- CreateIndex
CREATE INDEX "Match_blockBookingId_idx" ON "Match"("blockBookingId");

-- AddForeignKey: SET NULL so deleting a block detaches (never deletes)
-- any match still pointing at it.
ALTER TABLE "Match" ADD CONSTRAINT "Match_blockBookingId_fkey"
    FOREIGN KEY ("blockBookingId") REFERENCES "BlockBooking"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
