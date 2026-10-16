-- Asking a partner club for a player (2026-10-16), slice S1.
-- Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, section 4.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- Organisation and Membership column on queries without a `select`, so
-- code that knows the new columns fails against a database without them.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261016180000_partner_clubs/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   * Three columns on "Organisation": "partnerAskWhen" TEXT NOT NULL
--     DEFAULT 'off', "partnerAskTime" TEXT NULL, "partnerAskCutoffHours"
--     INTEGER NOT NULL DEFAULT 4. Constant defaults: Postgres fills every
--     existing row as the column is added (no table rewrite on PG 11+), so
--     Sutton FC (cmnnwhdx30000zfr85q18lyy9) and every other club asks no
--     partner club: nothing changes for anyone.
--   * Two nullable columns on "Membership": "guestFromOrgId", "guestMatchId".
--     NULL on every existing row: nobody is a guest.
--   * Two new, empty tables: "ClubPartnership" and "PartnerAsk", with their
--     indexes and foreign keys (ON DELETE CASCADE from the clubs and the
--     match, like the rest of a club's data).
--   * The CHECK constraints and the one-open-ask partial unique index of
--     prisma/sql/partner-ask-check.sql, repeated below.
--
-- It drops, renames and rewrites nothing.
--
-- IDEMPOTENT: every column and table is IF NOT EXISTS and every constraint
-- is dropped if present before it is added, so it can be run again safely.
-- It is ONE transaction: it applies whole or not at all. lock_timeout
-- makes a busy table fail fast instead of queueing every query behind the
-- ALTER; if it fails on the lock, nothing was changed and it can simply be
-- run again. There is no session-level SET in this file.
--
-- Verify after applying (expect 3 rows, then 2 rows, then 2 rows, then 0, 0):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'Organisation' AND column_name LIKE 'partnerAsk%';
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'Membership' AND column_name LIKE 'guest%';
--   SELECT table_name FROM information_schema.tables
--    WHERE table_name IN ('ClubPartnership', 'PartnerAsk');
--   SELECT count(*) FROM "Organisation" WHERE "partnerAskWhen" <> 'off';
--   SELECT count(*) FROM "Membership" WHERE "guestFromOrgId" IS NOT NULL;
--
-- Rolling back (after the code that reads them is no longer deployed):
--   DROP TABLE IF EXISTS "PartnerAsk";
--   DROP TABLE IF EXISTS "ClubPartnership";
--   ALTER TABLE "Membership" DROP CONSTRAINT IF EXISTS "Membership_guest_check";
--   ALTER TABLE "Membership" DROP COLUMN IF EXISTS "guestFromOrgId", DROP COLUMN IF EXISTS "guestMatchId";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_partnerAskWhen_check",
--     DROP CONSTRAINT IF EXISTS "Organisation_partnerAskCutoffHours_check",
--     DROP CONSTRAINT IF EXISTS "Organisation_partnerAskTime_check";
--   ALTER TABLE "Organisation" DROP COLUMN IF EXISTS "partnerAskWhen",
--     DROP COLUMN IF EXISTS "partnerAskTime", DROP COLUMN IF EXISTS "partnerAskCutoffHours";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. `db push` would add the same
-- columns and tables but never the CHECK constraints or the partial
-- unique index: after any `db push`, run prisma/sql/partner-ask-check.sql.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "partnerAskWhen" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "partnerAskTime" TEXT;
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "partnerAskCutoffHours" INTEGER NOT NULL DEFAULT 4;

ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "guestFromOrgId" TEXT;
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "guestMatchId" TEXT;

CREATE TABLE IF NOT EXISTS "ClubPartnership" (
  "id" TEXT NOT NULL,
  "askerOrgId" TEXT NOT NULL,
  "partnerOrgId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "partnerApproval" TEXT NOT NULL DEFAULT 'each-ask',
  "askerAcceptedAt" TIMESTAMP(3),
  "askerAcceptedBy" TEXT,
  "partnerAcceptedAt" TIMESTAMP(3),
  "partnerAcceptedBy" TEXT,
  "pausedByOrgId" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClubPartnership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ClubPartnership_askerOrgId_partnerOrgId_key" ON "ClubPartnership"("askerOrgId", "partnerOrgId");
CREATE INDEX IF NOT EXISTS "ClubPartnership_partnerOrgId_idx" ON "ClubPartnership"("partnerOrgId");
ALTER TABLE "ClubPartnership" DROP CONSTRAINT IF EXISTS "ClubPartnership_askerOrgId_fkey";
ALTER TABLE "ClubPartnership" ADD CONSTRAINT "ClubPartnership_askerOrgId_fkey"
  FOREIGN KEY ("askerOrgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClubPartnership" DROP CONSTRAINT IF EXISTS "ClubPartnership_partnerOrgId_fkey";
ALTER TABLE "ClubPartnership" ADD CONSTRAINT "ClubPartnership_partnerOrgId_fkey"
  FOREIGN KEY ("partnerOrgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PartnerAsk" (
  "id" TEXT NOT NULL,
  "partnershipId" TEXT NOT NULL,
  "askerOrgId" TEXT NOT NULL,
  "partnerOrgId" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "places" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'awaiting-approval',
  "reason" TEXT,
  "requestedByUserId" TEXT,
  "requestedVia" TEXT NOT NULL,
  "approvedByUserId" TEXT,
  "approvedAt" TIMESTAMP(3),
  "postedAt" TIMESTAMP(3),
  "postJobId" TEXT,
  "postWaMessageId" TEXT,
  "postBy" TIMESTAMP(3) NOT NULL,
  "closesAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  "volunteerUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "pickedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PartnerAsk_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PartnerAsk_partnerOrgId_status_idx" ON "PartnerAsk"("partnerOrgId", "status");
CREATE INDEX IF NOT EXISTS "PartnerAsk_matchId_status_idx" ON "PartnerAsk"("matchId", "status");
CREATE INDEX IF NOT EXISTS "PartnerAsk_postWaMessageId_idx" ON "PartnerAsk"("postWaMessageId");
ALTER TABLE "PartnerAsk" DROP CONSTRAINT IF EXISTS "PartnerAsk_partnershipId_fkey";
ALTER TABLE "PartnerAsk" ADD CONSTRAINT "PartnerAsk_partnershipId_fkey"
  FOREIGN KEY ("partnershipId") REFERENCES "ClubPartnership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PartnerAsk" DROP CONSTRAINT IF EXISTS "PartnerAsk_matchId_fkey";
ALTER TABLE "PartnerAsk" ADD CONSTRAINT "PartnerAsk_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The CHECK constraints and partial unique index, as in
-- prisma/sql/partner-ask-check.sql.
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
-- Created if missing and never dropped, so a re-run never leaves a window
-- without it (review of the stack, L5).
CREATE UNIQUE INDEX IF NOT EXISTS "PartnerAsk_one_open_per_match_partner"
  ON "PartnerAsk" ("matchId", "partnerOrgId")
  WHERE "status" IN ('awaiting-approval', 'posted');

COMMIT;
