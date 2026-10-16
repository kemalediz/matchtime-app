-- Asking a partner club for a player (2026-10-16).
-- Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, section 4.
--
-- Each enum-in-a-string is one of its values and nothing else, a club is
-- never its own partner, and a guest membership has both its marks or
-- neither.
--
-- IDEMPOTENT: safe to run repeatedly. Applied to production by
-- prisma/migrations/20261016180000_partner_clubs/migration.sql and to the
-- e2e database by e2e/run.ts after `prisma db push` (db push creates
-- columns, never CHECK constraints).

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_partnerAskWhen_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_partnerAskWhen_check"
  CHECK ("partnerAskWhen" IN ('off', 'on-request', 'auto'));

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_partnerAskCutoffHours_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_partnerAskCutoffHours_check"
  CHECK ("partnerAskCutoffHours" BETWEEN 1 AND 24);

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_partnerAskTime_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_partnerAskTime_check"
  CHECK ("partnerAskTime" IS NULL OR "partnerAskTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

ALTER TABLE "Membership" DROP CONSTRAINT IF EXISTS "Membership_guest_check";
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_guest_check"
  CHECK (("guestFromOrgId" IS NULL) = ("guestMatchId" IS NULL));

ALTER TABLE "ClubPartnership" DROP CONSTRAINT IF EXISTS "ClubPartnership_status_check";
ALTER TABLE "ClubPartnership" ADD CONSTRAINT "ClubPartnership_status_check"
  CHECK ("status" IN ('proposed', 'active', 'paused', 'ended'));

ALTER TABLE "ClubPartnership" DROP CONSTRAINT IF EXISTS "ClubPartnership_partnerApproval_check";
ALTER TABLE "ClubPartnership" ADD CONSTRAINT "ClubPartnership_partnerApproval_check"
  CHECK ("partnerApproval" IN ('each-ask', 'standing'));

ALTER TABLE "ClubPartnership" DROP CONSTRAINT IF EXISTS "ClubPartnership_two_clubs_check";
ALTER TABLE "ClubPartnership" ADD CONSTRAINT "ClubPartnership_two_clubs_check"
  CHECK ("askerOrgId" <> "partnerOrgId");

ALTER TABLE "PartnerAsk" DROP CONSTRAINT IF EXISTS "PartnerAsk_status_check";
ALTER TABLE "PartnerAsk" ADD CONSTRAINT "PartnerAsk_status_check"
  CHECK ("status" IN ('awaiting-approval', 'posted', 'filled', 'declined', 'expired', 'cancelled', 'refused'));

ALTER TABLE "PartnerAsk" DROP CONSTRAINT IF EXISTS "PartnerAsk_requestedVia_check";
ALTER TABLE "PartnerAsk" ADD CONSTRAINT "PartnerAsk_requestedVia_check"
  CHECK ("requestedVia" IN ('button', 'hq', 'dm', 'auto', 'link'));

ALTER TABLE "PartnerAsk" DROP CONSTRAINT IF EXISTS "PartnerAsk_places_check";
ALTER TABLE "PartnerAsk" ADD CONSTRAINT "PartnerAsk_places_check"
  CHECK ("places" >= 1);

ALTER TABLE "PartnerAsk" DROP CONSTRAINT IF EXISTS "PartnerAsk_two_clubs_check";
ALTER TABLE "PartnerAsk" ADD CONSTRAINT "PartnerAsk_two_clubs_check"
  CHECK ("askerOrgId" <> "partnerOrgId");

-- One OPEN ask per (match, partner club): a second button press, the
-- automatic timer and an organiser's words can never post twice.
DROP INDEX IF EXISTS "PartnerAsk_one_open_per_match_partner";
CREATE UNIQUE INDEX "PartnerAsk_one_open_per_match_partner"
  ON "PartnerAsk" ("matchId", "partnerOrgId")
  WHERE "status" IN ('awaiting-approval', 'posted');
