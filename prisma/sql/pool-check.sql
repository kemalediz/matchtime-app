-- The local player pool's CHECK constraints and partial unique indexes
-- (slice L1, 2026-10-24). Plan: MDs/local-player-pool-plan-2026-10-23.md
-- section 7, extended by MDs/local-player-pool-approved-spec-2026-10-24.md.
--
-- Each enum-in-a-string column is one of its values and nothing else (the
-- values are src/lib/pool/vocab.ts, the sports and formats
-- src/lib/pool/sports.ts, pinned here by src/lib/pool/__tests__/
-- schema-sql.test.ts), and each record's fields agree with its state:
-- a confirmed profile carries its consent, a paused one says why, a
-- closed ask or invitation says when, a partner guest names his club.
--
-- NOT HERE: the guest membership CHECK ("Membership_guest_check"). It has
-- ONE definition, in prisma/sql/partner-ask-check.sql, so the two files
-- can never undo each other on a re-run.
--
-- IDEMPOTENT: safe to run repeatedly. Applied to production by
-- prisma/migrations/20261024200000_local_player_pool/migration.sql and to
-- the e2e database by e2e/run.ts after `prisma db push` (db push creates
-- columns and plain indexes, never CHECK constraints or partial indexes).
--
-- ONE TRANSACTION: a re-run swaps each CHECK whole or not at all. The
-- partial unique indexes are created if missing and never dropped, so a
-- re-run never opens a window without them.

BEGIN;

-- Organisation
ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_playStyle_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_playStyle_check"
  CHECK ("playStyle" IS NULL OR "playStyle" IN ('casual', 'competitive', 'mixed'));
ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_town_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_town_check"
  CHECK ("town" IS NULL OR "town" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
-- The pasted group invite link (pool L8): canonical, chat.whatsapp.com only.
ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_groupInviteLink_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_groupInviteLink_check"
  CHECK ("groupInviteLink" IS NULL OR "groupInviteLink" ~ '^https://chat\.whatsapp\.com/[A-Za-z0-9]{10,40}$');

-- PoolProfile
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_status_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_status_check"
  CHECK ("status" IN ('pending-verify', 'active', 'paused', 'stopped'));
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_pausedReason_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_pausedReason_check"
  CHECK ("pausedReason" IS NULL OR "pausedReason" IN ('self', 'ignored', 'no-shows', 'reports', 'admin'));
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_paused_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_paused_check"
  CHECK ((("pausedReason" IS NULL) = ("pausedAt" IS NULL)) AND ("status" <> 'paused' OR "pausedReason" IS NOT NULL)
    AND ("pausedReason" IS NULL OR "status" = 'paused' OR ("status" = 'stopped' AND "pausedReason" IN ('no-shows', 'reports', 'admin'))));
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_stopped_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_stopped_check"
  CHECK (("status" = 'stopped') = ("stoppedAt" IS NOT NULL));
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_user_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_user_check"
  CHECK ("status" = 'pending-verify' OR "userId" IS NOT NULL);
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_consentChannel_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_consentChannel_check"
  CHECK ("consentChannel" IS NULL OR "consentChannel" IN ('whatsapp', 'web'));
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_consent_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_consent_check"
  CHECK ("status" = 'pending-verify' OR ("consentAt" IS NOT NULL AND "consentVersion" IS NOT NULL
    AND "consentChannel" IS NOT NULL AND "consentEvidence" IS NOT NULL AND "adultConfirmedAt" IS NOT NULL));
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_source_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_source_check"
  CHECK ("source" IS NULL OR "source" IN ('web', 'profile', 'referral', 'campaign'));
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_maxMiles_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_maxMiles_check"
  CHECK ("maxMiles" IN (1, 3, 5, 10));
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_areaDistrict_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_areaDistrict_check"
  CHECK ("areaDistrict" IS NULL OR "areaDistrict" ~ '^[A-Z]{1,2}[0-9][A-Z0-9]?$');
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_areaPoint_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_areaPoint_check"
  CHECK (("areaLat" IS NULL) = ("areaLng" IS NULL)
    AND ("areaLat" IS NULL OR ("areaLat" BETWEEN -90 AND 90 AND "areaLng" BETWEEN -180 AND 180)));
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_area_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_area_check"
  CHECK ("areaDistrict" IS NOT NULL AND "areaLat" IS NOT NULL);
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_displayName_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_displayName_check"
  CHECK (length(btrim("displayName")) BETWEEN 1 AND 60);
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_town_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_town_check"
  CHECK ("town" IS NULL OR "town" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_shareCode_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_shareCode_check"
  CHECK ("shareCode" IS NULL OR "shareCode" ~ '^[A-Za-z0-9]{4,12}$');

ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_signupIp_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_signupIp_check"
  CHECK ("signupIp" IS NULL OR "status" = 'pending-verify');

-- Slice L2 (prisma/migrations/20261025090000_pool_signup_confirm carries
-- the same CHECKs): the pool code is five characters; the rate-limit
-- records; the append-only consent record.
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_claim_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_claim_check"
  CHECK (("claimPhone" IS NULL) = ("claimMessageId" IS NULL) AND ("claimPhone" IS NULL) = ("claimAt" IS NULL)
    AND ("claimPhone" IS NULL OR ("status" = 'pending-verify' AND "userId" IS NOT NULL AND "claimPhone" ~ '^[0-9]{7,15}$')));
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_confirmCode_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_confirmCode_check"
  CHECK ("confirmCode" IS NULL OR ("status" = 'pending-verify' AND "confirmCode" ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$'));
ALTER TABLE "PoolAttempt" DROP CONSTRAINT IF EXISTS "PoolAttempt_result_check";
ALTER TABLE "PoolAttempt" ADD CONSTRAINT "PoolAttempt_result_check"
  CHECK (("kind" = 'confirm' AND "result" IN ('wrong', 'expired', 'has-profile')) OR ("kind" = 'signup' AND "result" IN ('created', 'area-not-found', 'venues-unknown')) OR ("kind" = 'offer-verify' AND "result" IN ('wrong')));
ALTER TABLE "PoolConsentRecord" DROP CONSTRAINT IF EXISTS "PoolConsentRecord_action_check";
ALTER TABLE "PoolConsentRecord" ADD CONSTRAINT "PoolConsentRecord_action_check"
  CHECK ("action" IN ('consent', 'withdraw'));
ALTER TABLE "PoolConsentRecord" DROP CONSTRAINT IF EXISTS "PoolConsentRecord_channel_check";
ALTER TABLE "PoolConsentRecord" ADD CONSTRAINT "PoolConsentRecord_channel_check"
  CHECK ("channel" IN ('whatsapp', 'web'));
ALTER TABLE "PoolConsentRecord" DROP CONSTRAINT IF EXISTS "PoolConsentRecord_version_check";
ALTER TABLE "PoolConsentRecord" ADD CONSTRAINT "PoolConsentRecord_version_check"
  CHECK ("action" <> 'consent' OR "version" IS NOT NULL);

-- Slice L7 (prisma/migrations/20261026090000_pool_no_shows carries the
-- same CHECKs): a review asked for a pause MatchTime decided; reports.
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_reviewRequested_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_reviewRequested_check"
  CHECK ("reviewRequestedAt" IS NULL OR "pausedReason" IN ('no-shows', 'reports', 'admin'));
ALTER TABLE "PoolReport" DROP CONSTRAINT IF EXISTS "PoolReport_by_check";
ALTER TABLE "PoolReport" ADD CONSTRAINT "PoolReport_by_check"
  CHECK ("by" IN ('club', 'player'));
ALTER TABLE "PoolReport" DROP CONSTRAINT IF EXISTS "PoolReport_text_check";
ALTER TABLE "PoolReport" ADD CONSTRAINT "PoolReport_text_check"
  CHECK (length("text") BETWEEN 3 AND 1000);
ALTER TABLE "PoolReport" DROP CONSTRAINT IF EXISTS "PoolReport_reviewed_check";
ALTER TABLE "PoolReport" ADD CONSTRAINT "PoolReport_reviewed_check"
  CHECK (("reviewedAt" IS NULL) = ("reviewedBy" IS NULL));

-- PoolSport
ALTER TABLE "PoolSport" DROP CONSTRAINT IF EXISTS "PoolSport_sport_check";
ALTER TABLE "PoolSport" ADD CONSTRAINT "PoolSport_sport_check"
  CHECK ("sport" IN ('football', 'basketball', 'tennis', 'badminton', 'squash', 'padel', 'table-tennis', 'billiards', 'snooker', 'pool', 'other'));
ALTER TABLE "PoolSport" DROP CONSTRAINT IF EXISTS "PoolSport_otherName_check";
ALTER TABLE "PoolSport" ADD CONSTRAINT "PoolSport_otherName_check"
  CHECK ((("sport" = 'other') = ("otherName" <> '')) AND length("otherName") <= 40);
ALTER TABLE "PoolSport" DROP CONSTRAINT IF EXISTS "PoolSport_level_check";
ALTER TABLE "PoolSport" ADD CONSTRAINT "PoolSport_level_check"
  CHECK ("level" IS NULL OR "level" IN ('novice', 'intermediate', 'advanced', 'pro'));
ALTER TABLE "PoolSport" DROP CONSTRAINT IF EXISTS "PoolSport_one_level_check";
ALTER TABLE "PoolSport" ADD CONSTRAINT "PoolSport_one_level_check"
  CHECK ("level" IS NULL OR "levelText" IS NULL);
ALTER TABLE "PoolSport" DROP CONSTRAINT IF EXISTS "PoolSport_formats_check";
ALTER TABLE "PoolSport" ADD CONSTRAINT "PoolSport_formats_check"
  CHECK (("sport" = 'football' AND "formats" <@ ARRAY[5, 7, 8, 9, 11]::INTEGER[]) OR ("sport" = 'basketball' AND "formats" <@ ARRAY[3, 5]::INTEGER[]) OR ("sport" NOT IN ('football', 'basketball') AND cardinality("formats") = 0));

-- PoolAvailability
ALTER TABLE "PoolAvailability" DROP CONSTRAINT IF EXISTS "PoolAvailability_range_check";
ALTER TABLE "PoolAvailability" ADD CONSTRAINT "PoolAvailability_range_check"
  CHECK ("day" BETWEEN 0 AND 6 AND "fromMin" >= 0 AND "fromMin" < "toMin" AND "toMin" <= 1440);

-- PoolAsk
ALTER TABLE "PoolAsk" DROP CONSTRAINT IF EXISTS "PoolAsk_status_check";
ALTER TABLE "PoolAsk" ADD CONSTRAINT "PoolAsk_status_check"
  CHECK ("status" IN ('open', 'filled', 'closed', 'cancelled'));
ALTER TABLE "PoolAsk" DROP CONSTRAINT IF EXISTS "PoolAsk_via_check";
ALTER TABLE "PoolAsk" ADD CONSTRAINT "PoolAsk_via_check"
  CHECK ("via" IN ('page', 'notice', 'auto', 'words'));
ALTER TABLE "PoolAsk" DROP CONSTRAINT IF EXISTS "PoolAsk_places_check";
ALTER TABLE "PoolAsk" ADD CONSTRAINT "PoolAsk_places_check"
  CHECK ("places" >= 1);
ALTER TABLE "PoolAsk" DROP CONSTRAINT IF EXISTS "PoolAsk_closed_check";
ALTER TABLE "PoolAsk" ADD CONSTRAINT "PoolAsk_closed_check"
  CHECK (("status" = 'open') = ("closedAt" IS NULL));
-- One OPEN ask per (match, club): a second tap, the automatic ask and an
-- organiser's words can never open two.
CREATE UNIQUE INDEX IF NOT EXISTS "PoolAsk_one_open_per_match_club"
  ON "PoolAsk" ("matchId", "orgId")
  WHERE "status" = 'open';

-- PoolOffer
ALTER TABLE "PoolOffer" DROP CONSTRAINT IF EXISTS "PoolOffer_outcome_check";
ALTER TABLE "PoolOffer" ADD CONSTRAINT "PoolOffer_outcome_check"
  CHECK ("outcome" IS NULL OR "outcome" IN ('accepted', 'declined', 'ignored', 'expired', 'filled', 'stopped', 'cancelled'));
ALTER TABLE "PoolOffer" DROP CONSTRAINT IF EXISTS "PoolOffer_resolved_check";
ALTER TABLE "PoolOffer" ADD CONSTRAINT "PoolOffer_resolved_check"
  CHECK (("outcome" IS NULL) = ("resolvedAt" IS NULL));
ALTER TABLE "PoolOffer" DROP CONSTRAINT IF EXISTS "PoolOffer_repliedVia_check";
ALTER TABLE "PoolOffer" ADD CONSTRAINT "PoolOffer_repliedVia_check"
  CHECK ("repliedVia" IS NULL OR "repliedVia" IN ('link', 'words'));
ALTER TABLE "PoolOffer" DROP CONSTRAINT IF EXISTS "PoolOffer_wave_check";
ALTER TABLE "PoolOffer" ADD CONSTRAINT "PoolOffer_wave_check"
  CHECK ("wave" IN (1, 2));
ALTER TABLE "PoolOffer" DROP CONSTRAINT IF EXISTS "PoolOffer_distance_check";
ALTER TABLE "PoolOffer" ADD CONSTRAINT "PoolOffer_distance_check"
  CHECK ("distanceMiles" >= 0);

-- PoolBlock
ALTER TABLE "PoolBlock" DROP CONSTRAINT IF EXISTS "PoolBlock_by_check";
ALTER TABLE "PoolBlock" ADD CONSTRAINT "PoolBlock_by_check"
  CHECK ("by" IN ('club', 'player'));

-- PoolCampaign
ALTER TABLE "PoolCampaign" DROP CONSTRAINT IF EXISTS "PoolCampaign_source_check";
ALTER TABLE "PoolCampaign" ADD CONSTRAINT "PoolCampaign_source_check"
  CHECK ("source" IN ('linkedin', 'leaflet', 'club', 'other'));
ALTER TABLE "PoolCampaign" DROP CONSTRAINT IF EXISTS "PoolCampaign_code_check";
ALTER TABLE "PoolCampaign" ADD CONSTRAINT "PoolCampaign_code_check"
  CHECK ("code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("code") <= 32);

-- GuestPlace
ALTER TABLE "GuestPlace" DROP CONSTRAINT IF EXISTS "GuestPlace_source_check";
ALTER TABLE "GuestPlace" ADD CONSTRAINT "GuestPlace_source_check"
  CHECK ("source" IN ('pool', 'partner'));
ALTER TABLE "GuestPlace" DROP CONSTRAINT IF EXISTS "GuestPlace_result_check";
ALTER TABLE "GuestPlace" ADD CONSTRAINT "GuestPlace_result_check"
  CHECK ("result" IN ('booked', 'played', 'no-show', 'late-cancel', 'withdrawn'));
ALTER TABLE "GuestPlace" DROP CONSTRAINT IF EXISTS "GuestPlace_from_check";
ALTER TABLE "GuestPlace" ADD CONSTRAINT "GuestPlace_from_check"
  CHECK (("source" = 'partner') = ("fromOrgId" IS NOT NULL));
ALTER TABLE "GuestPlace" DROP CONSTRAINT IF EXISTS "GuestPlace_refs_check";
ALTER TABLE "GuestPlace" ADD CONSTRAINT "GuestPlace_refs_check"
  CHECK (("source" = 'pool' OR "poolOfferId" IS NULL) AND ("source" = 'partner' OR "partnerAskId" IS NULL));
ALTER TABLE "GuestPlace" DROP CONSTRAINT IF EXISTS "GuestPlace_resultAt_check";
ALTER TABLE "GuestPlace" ADD CONSTRAINT "GuestPlace_resultAt_check"
  CHECK (("result" = 'booked') = ("resultAt" IS NULL));

-- ClubInvitation
ALTER TABLE "ClubInvitation" DROP CONSTRAINT IF EXISTS "ClubInvitation_status_check";
ALTER TABLE "ClubInvitation" ADD CONSTRAINT "ClubInvitation_status_check"
  CHECK ("status" IN ('open', 'accepted', 'declined', 'withdrawn'));
ALTER TABLE "ClubInvitation" DROP CONSTRAINT IF EXISTS "ClubInvitation_origin_check";
ALTER TABLE "ClubInvitation" ADD CONSTRAINT "ClubInvitation_origin_check"
  CHECK ("origin" IN ('after-game', 'organiser'));
ALTER TABLE "ClubInvitation" DROP CONSTRAINT IF EXISTS "ClubInvitation_declinedBy_check";
ALTER TABLE "ClubInvitation" ADD CONSTRAINT "ClubInvitation_declinedBy_check"
  CHECK ("declinedBy" IS NULL OR "declinedBy" IN ('club', 'player'));
ALTER TABLE "ClubInvitation" DROP CONSTRAINT IF EXISTS "ClubInvitation_state_check";
ALTER TABLE "ClubInvitation" ADD CONSTRAINT "ClubInvitation_state_check"
  CHECK ((("status" = 'open') = ("closedAt" IS NULL))
    AND (("status" = 'declined') = ("declinedBy" IS NOT NULL))
    AND ("status" <> 'accepted' OR ("clubYesAt" IS NOT NULL AND "playerYesAt" IS NOT NULL))
    AND ("origin" <> 'organiser' OR "clubYesAt" IS NOT NULL));
-- One OPEN invitation per (club, person).
CREATE UNIQUE INDEX IF NOT EXISTS "ClubInvitation_one_open_per_club_user"
  ON "ClubInvitation" ("orgId", "userId")
  WHERE "status" = 'open';

COMMIT;
