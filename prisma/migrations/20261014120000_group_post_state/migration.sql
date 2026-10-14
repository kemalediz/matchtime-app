-- Can MatchTime post in a WhatsApp group (2026-10-14).
-- See src/lib/group-postability.ts and whatsapp-bot/src/group-postability.ts.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand:
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261014120000_group_post_state/migration.sql
--
-- ORDER DOES NOT MATTER. The code is safe to deploy BEFORE this is
-- applied: every read and write of the table is in a try/catch that reads
-- "no table" as "no reading" (src/lib/group-postability-store.ts), and no
-- reading means nothing is gated, nobody is told anything and admin
-- notices go where they go today. The Pi's reports simply fail (logged,
-- retried at its next refresh) until the table exists. No existing table
-- is touched, so no existing query changes.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS, so it can be run again
-- safely. It is ONE transaction: it applies whole or not at all.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive: ONE new, empty table and one index on it.
--   "GroupPostState"  one row per WhatsApp group MatchTime has read:
--                     whether only admins can send there, whether it is a
--                     community announcements group, whether MatchTime is
--                     an admin, and so whether it can post. Plus, for a
--                     club's group it cannot post in, when that began and
--                     when the organisers were told; and, for a connect
--                     request whose add is waiting for MatchTime to be made
--                     admin, that request's id and what the add brought
--                     (adder, members, how it matched).
--                     Group ids, booleans and times; the held add carries
--                     the same member list "ClubConnect"."participants"
--                     already stores for a linked request.
--
-- It adds NO column to any existing table and NO foreign key, so it takes
-- no lock on any existing table, rewrites nothing and updates no row.
--
-- There is no session-level SET anywhere in this file.
--
-- Verify after applying (expect 1, then 13):
--   SELECT count(*) FROM information_schema.tables WHERE table_name = 'GroupPostState';
--   SELECT count(*) FROM information_schema.columns WHERE table_name = 'GroupPostState';
--
-- Rolling back (nothing is gated any more, nothing else changes):
--   DROP TABLE IF EXISTS "GroupPostState";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL for production.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "GroupPostState" (
  "groupId"           TEXT         NOT NULL,
  "announce"          BOOLEAN      NOT NULL DEFAULT false,
  "communityAnnounce" BOOLEAN      NOT NULL DEFAULT false,
  "botIsAdmin"        BOOLEAN      NOT NULL DEFAULT false,
  "canPost"           BOOLEAN      NOT NULL DEFAULT true,
  "blockedSince"      TIMESTAMP(3),
  "noticeSentAt"      TIMESTAMP(3),
  "heldConnectId"     TEXT,
  "heldAdd"           JSONB,
  "heldAt"            TIMESTAMP(3),
  "observedAt"        TIMESTAMP(3) NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GroupPostState_pkey" PRIMARY KEY ("groupId")
);

CREATE INDEX IF NOT EXISTS "GroupPostState_heldConnectId_idx"
  ON "GroupPostState" ("heldConnectId");

COMMIT;
