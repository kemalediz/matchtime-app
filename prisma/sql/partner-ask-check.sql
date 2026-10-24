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
--
-- ONE TRANSACTION: a re-run swaps each CHECK whole or not at all.

BEGIN;

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_partnerAskWhen_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_partnerAskWhen_check"
  CHECK ("partnerAskWhen" IN ('off', 'on-request', 'auto'));

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_partnerAskCutoffHours_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_partnerAskCutoffHours_check"
  CHECK ("partnerAskCutoffHours" BETWEEN 1 AND 24);

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_partnerAskTime_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_partnerAskTime_check"
  CHECK ("partnerAskTime" IS NULL OR "partnerAskTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- A guest membership has both its marks or neither; since the local player
-- pool (2026-10-24, slice L1) "guestVia" says where he came from, and a POOL
-- guest has no home club: his match is set and his home club is not. Rows
-- written before the pool have "guestVia" NULL and keep the original rule.
-- The ONE definition of this CHECK (prisma/sql/pool-check.sql does not
-- repeat it); also applied by
-- prisma/migrations/20261024200000_local_player_pool/migration.sql.
ALTER TABLE "Membership" DROP CONSTRAINT IF EXISTS "Membership_guest_check";
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_guest_check"
  CHECK (("guestVia" IS NULL AND ("guestFromOrgId" IS NULL) = ("guestMatchId" IS NULL)) OR ("guestVia" IS NOT NULL AND "guestVia" = 'partner' AND "guestFromOrgId" IS NOT NULL AND "guestMatchId" IS NOT NULL) OR ("guestVia" IS NOT NULL AND "guestVia" = 'pool' AND "guestFromOrgId" IS NULL AND "guestMatchId" IS NOT NULL));

-- A guest is a PLAYER of the club he guests for (review of #400, M1): a
-- former OWNER or ADMIN who left and came back as a guest must not keep his
-- old role, or every organiser check passes for him. NOT VALID: it binds
-- every row written or updated from now on and checks no existing row, so
-- adding it never fails and never changes a live row; validate it after
-- confirming no live row breaks it (`ALTER TABLE "Membership" VALIDATE
-- CONSTRAINT "Membership_guest_player_check"`). Also applied by
-- prisma/migrations/20261025140000_pool_offer_review/migration.sql.
ALTER TABLE "Membership" DROP CONSTRAINT IF EXISTS "Membership_guest_player_check";
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_guest_player_check"
  CHECK ("guestMatchId" IS NULL OR "role" = 'PLAYER') NOT VALID;

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
  CHECK ("requestedVia" IN ('button', 'hq', 'dm', 'group', 'auto', 'link'));

ALTER TABLE "PartnerAsk" DROP CONSTRAINT IF EXISTS "PartnerAsk_places_check";
ALTER TABLE "PartnerAsk" ADD CONSTRAINT "PartnerAsk_places_check"
  CHECK ("places" >= 1);

ALTER TABLE "PartnerAsk" DROP CONSTRAINT IF EXISTS "PartnerAsk_two_clubs_check";
ALTER TABLE "PartnerAsk" ADD CONSTRAINT "PartnerAsk_two_clubs_check"
  CHECK ("askerOrgId" <> "partnerOrgId");

-- Partner discovery (slice P1, 2026-10-22). Plan:
-- MDs/partner-discovery-plan-2026-10-21.md, section 6. Applied to
-- production by prisma/migrations/20261022100000_partner_discovery.
-- Values: ClubPartnership "origin" and "endReason" are
-- PARTNERSHIP_ORIGINS and PARTNERSHIP_END_REASONS in
-- src/lib/club-partnership-rules.ts.
ALTER TABLE "ClubPartnership" DROP CONSTRAINT IF EXISTS "ClubPartnership_origin_check";
ALTER TABLE "ClubPartnership" ADD CONSTRAINT "ClubPartnership_origin_check"
  CHECK ("origin" IN ('owner', 'request'));

ALTER TABLE "ClubPartnership" DROP CONSTRAINT IF EXISTS "ClubPartnership_endReason_check";
ALTER TABLE "ClubPartnership" ADD CONSTRAINT "ClubPartnership_endReason_check"
  CHECK ("endReason" IS NULL OR "endReason" IN ('declined', 'withdrawn', 'ended', 'expired', 'blocked'));

ALTER TABLE "ClubBlock" DROP CONSTRAINT IF EXISTS "ClubBlock_two_clubs_check";
ALTER TABLE "ClubBlock" ADD CONSTRAINT "ClubBlock_two_clubs_check"
  CHECK ("blockerOrgId" <> "blockedOrgId");

-- One OPEN ask per (match, partner club): a second button press, the
-- automatic timer and an organiser's words can never post twice.
-- Created if missing and never dropped, so a re-run never leaves a window
-- without it (review of the stack, L5).
CREATE UNIQUE INDEX IF NOT EXISTS "PartnerAsk_one_open_per_match_partner"
  ON "PartnerAsk" ("matchId", "partnerOrgId")
  WHERE "status" IN ('awaiting-approval', 'posted');

COMMIT;
