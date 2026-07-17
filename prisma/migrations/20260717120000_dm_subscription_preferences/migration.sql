-- Per-category proactive-DM subscription preferences (2026-07-17).
--
-- Adds five per-category boolean subscription flags to Membership, all
-- defaulting to true (true = subscribed = receives the DM). PAYMENT DMs
-- deliberately get NO flag — a player who owes money is always messaged.
--
-- NOTE ON APPLYING: this repo historically manages schema with
-- `prisma db push` (no prior migration history). This file is the
-- canonical, reviewable DDL for the change. Apply either by running this
-- SQL directly against the database, or by `prisma db push` for the
-- column adds followed by the backfill UPDATE below. The backfill MUST be
-- run so existing `ratingDmOptOut` opt-outs are preserved.

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "subBenchOfferDm" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "subMatchInviteDm" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "subPrefsUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "subRatingDm" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "subReminderDm" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "subTentativeDm" BOOLEAN NOT NULL DEFAULT true;

-- Data migration: PRESERVE existing rating opt-outs.
--   Old column `ratingDmOptOut` has OPT-OUT semantics (true = suppressed).
--   New column `subRatingDm` has SUBSCRIPTION semantics (true = receives).
--   So subRatingDm = NOT ratingDmOptOut. New columns already default to
--   true, so we only need to flip the rows that were opted OUT. We also
--   carry the opt-out timestamp over to subPrefsUpdatedAt for audit
--   continuity. Every other sub* category stays true (subscribed) — the
--   old single toggle never expressed a preference about them.
UPDATE "Membership"
SET "subRatingDm" = FALSE,
    "subPrefsUpdatedAt" = COALESCE("ratingDmOptOutAt", NOW())
WHERE "ratingDmOptOut" = TRUE;
