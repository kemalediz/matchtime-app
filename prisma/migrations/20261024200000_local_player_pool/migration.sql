-- The local player pool, slice L1: the data model (2026-10-24).
-- Plan: MDs/local-player-pool-plan-2026-10-23.md section 7, extended by
-- MDs/local-player-pool-approved-spec-2026-10-24.md (which wins).
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- Organisation and Membership column on queries without a `select`, so code
-- that knows the new columns fails against a database without them.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261024200000_local_player_pool/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. Every pool switch is OFF (decision log #2), so no live
-- club behaves differently until a club and the global POOL_OFFERS_ENABLED
-- are both switched on.
--   * Four columns on "Organisation":
--       "featurePlayerPool" BOOLEAN NOT NULL DEFAULT false
--       "poolAutoAsk"       BOOLEAN NOT NULL DEFAULT false
--       "playStyle"         TEXT NULL ('casual' | 'competitive' | 'mixed')
--       "town"              TEXT NULL (a slug, decision D-6)
--     Constant defaults: Postgres fills existing rows as the column is
--     added (no table rewrite on PG 11+). Every existing club reads OFF.
--   * One column on "Membership": "guestVia" TEXT NULL ('partner' | 'pool').
--     Every existing row reads NULL.
--   * The guest CHECK "Membership_guest_check" is replaced by the pool-aware
--     one (NULL "guestVia" keeps the original "both marks or neither" rule,
--     so every existing row still passes; validated as it is added). Its one
--     definition is prisma/sql/partner-ask-check.sql: from now on that file
--     needs this migration applied first (it names "guestVia").
--   * Nine new, EMPTY tables: "PoolProfile", "PoolSport", "PoolAvailability",
--     "PoolAsk", "PoolOffer", "PoolBlock", "PoolCampaign", "GuestPlace",
--     "ClubInvitation", with their indexes and foreign keys (ON DELETE
--     CASCADE from "User", "Organisation", "Match" or the parent row).
--   * The CHECK constraints and two partial unique indexes of
--     prisma/sql/pool-check.sql, verbatim.
--
-- It drops, renames and rewrites nothing. No row changes.
--
-- IDEMPOTENT: every column, table and index is IF NOT EXISTS and every
-- constraint is dropped if present before it is added. ONE transaction: it
-- applies whole or not at all. lock_timeout makes a busy table fail fast
-- instead of queueing every query behind the ALTER; if it fails on the lock,
-- nothing was changed and it can simply be run again. There is no
-- session-level SET in this file.
--
-- Verify after applying (expect 4 rows, 1 row, 9 rows, then 0 and 0):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'Organisation' AND column_name IN ('featurePlayerPool', 'poolAutoAsk', 'playStyle', 'town');
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'Membership' AND column_name = 'guestVia';
--   SELECT table_name FROM information_schema.tables WHERE table_name IN ('PoolProfile', 'PoolSport',
--     'PoolAvailability', 'PoolAsk', 'PoolOffer', 'PoolBlock', 'PoolCampaign', 'GuestPlace', 'ClubInvitation');
--   SELECT count(*) FROM "Organisation" WHERE "featurePlayerPool" OR "poolAutoAsk";
--   SELECT count(*) FROM "Membership" WHERE "guestVia" IS NOT NULL;
--
-- Rolling back (after the code that reads them is no longer deployed):
--   DROP TABLE IF EXISTS "PoolSport", "PoolAvailability", "PoolOffer", "PoolAsk", "PoolBlock",
--     "PoolCampaign", "GuestPlace", "ClubInvitation", "PoolProfile";  -- CHECKs and indexes go with them
--   ALTER TABLE "Membership" DROP CONSTRAINT IF EXISTS "Membership_guest_check";
--   ALTER TABLE "Membership" ADD CONSTRAINT "Membership_guest_check"
--     CHECK (("guestFromOrgId" IS NULL) = ("guestMatchId" IS NULL));
--   ALTER TABLE "Membership" DROP COLUMN IF EXISTS "guestVia";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_playStyle_check",
--     DROP CONSTRAINT IF EXISTS "Organisation_town_check";
--   ALTER TABLE "Organisation" DROP COLUMN IF EXISTS "featurePlayerPool", DROP COLUMN IF EXISTS "poolAutoAsk",
--     DROP COLUMN IF EXISTS "playStyle", DROP COLUMN IF EXISTS "town";
--   (and restore prisma/sql/partner-ask-check.sql's old guest CHECK in git)
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. `db push` adds the same columns,
-- tables and indexes but never the CHECK constraints or partial indexes:
-- after any `db push`, run prisma/sql/partner-ask-check.sql and then
-- prisma/sql/pool-check.sql.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Organisation and Membership: new columns
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "featurePlayerPool" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "poolAutoAsk" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "playStyle" TEXT;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "town" TEXT;
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "guestVia" TEXT;

CREATE TABLE IF NOT EXISTS "PoolProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending-verify',
    "pausedReason" TEXT,
    "pausedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "confirmCode" TEXT,
    "confirmCodeExpiresAt" TIMESTAMP(3),
    "consentAt" TIMESTAMP(3),
    "consentVersion" INTEGER,
    "consentChannel" TEXT,
    "consentEvidence" TEXT,
    "adultConfirmedAt" TIMESTAMP(3),
    "language" TEXT NOT NULL DEFAULT 'en',
    "displayName" TEXT NOT NULL,
    "town" TEXT,
    "areaDistrict" TEXT,
    "areaLat" DOUBLE PRECISION,
    "areaLng" DOUBLE PRECISION,
    "venueIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxMiles" INTEGER NOT NULL DEFAULT 3,
    "source" TEXT,
    "sourceCode" TEXT,
    "referrerUserId" TEXT,
    "referralCountedAt" TIMESTAMP(3),
    "shareCode" TEXT,
    "showRecognition" BOOLEAN NOT NULL DEFAULT true,
    "earlyList" BOOLEAN NOT NULL DEFAULT false,
    "lastActiveAt" TIMESTAMP(3),
    "reconfirmSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PoolProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PoolSport" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "otherName" TEXT NOT NULL DEFAULT '',
    "level" TEXT,
    "levelText" TEXT,
    "formats" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "PoolSport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PoolAvailability" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "fromMin" INTEGER NOT NULL,
    "toMin" INTEGER NOT NULL,

    CONSTRAINT "PoolAvailability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PoolAsk" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "roundId" TEXT,
    "places" INTEGER NOT NULL,
    "via" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "closeReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PoolAsk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PoolOffer" (
    "id" TEXT NOT NULL,
    "poolAskId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "distanceMiles" DOUBLE PRECISION NOT NULL,
    "wave" INTEGER NOT NULL DEFAULT 1,
    "platformJobId" TEXT,
    "sentAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "outcome" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "repliedVia" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoolOffer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PoolBlock" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "byUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoolBlock_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PoolCampaign" (
    "code" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "orgId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoolCampaign_pkey" PRIMARY KEY ("code")
);

CREATE TABLE IF NOT EXISTS "GuestPlace" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "fromOrgId" TEXT,
    "partnerAskId" TEXT,
    "poolOfferId" TEXT,
    "result" TEXT NOT NULL DEFAULT 'booked',
    "resultAt" TIMESTAMP(3),
    "resultById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestPlace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ClubInvitation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "matchId" TEXT,
    "origin" TEXT NOT NULL,
    "invitedByUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "clubYesAt" TIMESTAMP(3),
    "clubYesById" TEXT,
    "playerYesAt" TIMESTAMP(3),
    "declinedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "linkSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PoolProfile_userId_key" ON "PoolProfile"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "PoolProfile_confirmCode_key" ON "PoolProfile"("confirmCode");
CREATE UNIQUE INDEX IF NOT EXISTS "PoolProfile_shareCode_key" ON "PoolProfile"("shareCode");
CREATE INDEX IF NOT EXISTS "PoolProfile_status_idx" ON "PoolProfile"("status");
CREATE INDEX IF NOT EXISTS "PoolProfile_areaLat_areaLng_idx" ON "PoolProfile"("areaLat", "areaLng");
CREATE INDEX IF NOT EXISTS "PoolProfile_town_status_idx" ON "PoolProfile"("town", "status");
CREATE INDEX IF NOT EXISTS "PoolProfile_referrerUserId_idx" ON "PoolProfile"("referrerUserId");
CREATE INDEX IF NOT EXISTS "PoolSport_sport_idx" ON "PoolSport"("sport");
CREATE UNIQUE INDEX IF NOT EXISTS "PoolSport_profileId_sport_otherName_key" ON "PoolSport"("profileId", "sport", "otherName");
CREATE INDEX IF NOT EXISTS "PoolAvailability_day_idx" ON "PoolAvailability"("day");
CREATE UNIQUE INDEX IF NOT EXISTS "PoolAvailability_profileId_day_fromMin_key" ON "PoolAvailability"("profileId", "day", "fromMin");
CREATE INDEX IF NOT EXISTS "PoolAsk_roundId_idx" ON "PoolAsk"("roundId");
CREATE INDEX IF NOT EXISTS "PoolAsk_orgId_createdAt_idx" ON "PoolAsk"("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "PoolAsk_matchId_status_idx" ON "PoolAsk"("matchId", "status");
CREATE INDEX IF NOT EXISTS "PoolOffer_poolAskId_idx" ON "PoolOffer"("poolAskId");
CREATE INDEX IF NOT EXISTS "PoolOffer_userId_sentAt_idx" ON "PoolOffer"("userId", "sentAt");
CREATE INDEX IF NOT EXISTS "PoolOffer_orgId_userId_sentAt_idx" ON "PoolOffer"("orgId", "userId", "sentAt");
CREATE UNIQUE INDEX IF NOT EXISTS "PoolOffer_matchId_userId_key" ON "PoolOffer"("matchId", "userId");
CREATE INDEX IF NOT EXISTS "PoolBlock_userId_idx" ON "PoolBlock"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "PoolBlock_orgId_userId_by_key" ON "PoolBlock"("orgId", "userId", "by");
CREATE UNIQUE INDEX IF NOT EXISTS "GuestPlace_poolOfferId_key" ON "GuestPlace"("poolOfferId");
CREATE INDEX IF NOT EXISTS "GuestPlace_orgId_createdAt_idx" ON "GuestPlace"("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "GuestPlace_userId_idx" ON "GuestPlace"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "GuestPlace_matchId_userId_key" ON "GuestPlace"("matchId", "userId");
CREATE INDEX IF NOT EXISTS "ClubInvitation_userId_status_idx" ON "ClubInvitation"("userId", "status");
CREATE INDEX IF NOT EXISTS "ClubInvitation_orgId_status_idx" ON "ClubInvitation"("orgId", "status");

ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_userId_fkey";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PoolSport" DROP CONSTRAINT IF EXISTS "PoolSport_profileId_fkey";
ALTER TABLE "PoolSport" ADD CONSTRAINT "PoolSport_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "PoolProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PoolAvailability" DROP CONSTRAINT IF EXISTS "PoolAvailability_profileId_fkey";
ALTER TABLE "PoolAvailability" ADD CONSTRAINT "PoolAvailability_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "PoolProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PoolAsk" DROP CONSTRAINT IF EXISTS "PoolAsk_matchId_fkey";
ALTER TABLE "PoolAsk" ADD CONSTRAINT "PoolAsk_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PoolAsk" DROP CONSTRAINT IF EXISTS "PoolAsk_orgId_fkey";
ALTER TABLE "PoolAsk" ADD CONSTRAINT "PoolAsk_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PoolOffer" DROP CONSTRAINT IF EXISTS "PoolOffer_poolAskId_fkey";
ALTER TABLE "PoolOffer" ADD CONSTRAINT "PoolOffer_poolAskId_fkey"
  FOREIGN KEY ("poolAskId") REFERENCES "PoolAsk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PoolBlock" DROP CONSTRAINT IF EXISTS "PoolBlock_orgId_fkey";
ALTER TABLE "PoolBlock" ADD CONSTRAINT "PoolBlock_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GuestPlace" DROP CONSTRAINT IF EXISTS "GuestPlace_orgId_fkey";
ALTER TABLE "GuestPlace" ADD CONSTRAINT "GuestPlace_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GuestPlace" DROP CONSTRAINT IF EXISTS "GuestPlace_matchId_fkey";
ALTER TABLE "GuestPlace" ADD CONSTRAINT "GuestPlace_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GuestPlace" DROP CONSTRAINT IF EXISTS "GuestPlace_userId_fkey";
ALTER TABLE "GuestPlace" ADD CONSTRAINT "GuestPlace_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClubInvitation" DROP CONSTRAINT IF EXISTS "ClubInvitation_orgId_fkey";
ALTER TABLE "ClubInvitation" ADD CONSTRAINT "ClubInvitation_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClubInvitation" DROP CONSTRAINT IF EXISTS "ClubInvitation_userId_fkey";
ALTER TABLE "ClubInvitation" ADD CONSTRAINT "ClubInvitation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The guest membership CHECK, pool-aware (its one definition is
-- prisma/sql/partner-ask-check.sql; the same text).
ALTER TABLE "Membership" DROP CONSTRAINT IF EXISTS "Membership_guest_check";
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_guest_check"
  CHECK (("guestVia" IS NULL AND ("guestFromOrgId" IS NULL) = ("guestMatchId" IS NULL)) OR ("guestVia" IS NOT NULL AND "guestVia" = 'partner' AND "guestFromOrgId" IS NOT NULL AND "guestMatchId" IS NOT NULL) OR ("guestVia" IS NOT NULL AND "guestVia" = 'pool' AND "guestFromOrgId" IS NULL AND "guestMatchId" IS NOT NULL));

-- The CHECKs and partial unique indexes of prisma/sql/pool-check.sql, verbatim.
-- Organisation
ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_playStyle_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_playStyle_check"
  CHECK ("playStyle" IS NULL OR "playStyle" IN ('casual', 'competitive', 'mixed'));
ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_town_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_town_check"
  CHECK ("town" IS NULL OR "town" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- PoolProfile
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_status_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_status_check"
  CHECK ("status" IN ('pending-verify', 'active', 'paused', 'stopped'));
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_pausedReason_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_pausedReason_check"
  CHECK ("pausedReason" IS NULL OR "pausedReason" IN ('self', 'ignored', 'no-shows', 'reports', 'admin'));
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_paused_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_paused_check"
  CHECK (("status" = 'paused') = ("pausedReason" IS NOT NULL AND "pausedAt" IS NOT NULL));
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
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_confirmCode_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_confirmCode_check"
  CHECK ("confirmCode" IS NULL OR ("status" = 'pending-verify' AND "confirmCode" ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$'));
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
  CHECK ("areaLat" IS NOT NULL OR coalesce(cardinality("venueIds"), 0) > 0);
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_displayName_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_displayName_check"
  CHECK (length(btrim("displayName")) BETWEEN 1 AND 60);
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_town_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_town_check"
  CHECK ("town" IS NULL OR "town" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "PoolProfile" DROP CONSTRAINT IF EXISTS "PoolProfile_shareCode_check";
ALTER TABLE "PoolProfile" ADD CONSTRAINT "PoolProfile_shareCode_check"
  CHECK ("shareCode" IS NULL OR "shareCode" ~ '^[A-Za-z0-9]{4,12}$');

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
