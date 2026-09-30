-- Admin channel, slice 2a (2026-09-30).
-- Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.2 to 2.5 and 2.14.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   * Eight columns on "Organisation".
--     "adminChannelMode" is NOT NULL and is added with DEFAULT 'each-admin':
--     that default IS the backfill. Postgres fills every existing row with
--     'each-admin' as the column is added (a constant default, no table
--     rewrite on PG 11+), which keeps Sutton FC (cmnnwhdx30000zfr85q18lyy9)
--     and every other existing club on today's behaviour: every owner and
--     admin with a phone gets their own DM, with today's texts and keys.
--     The default is then changed to 'one-person' in the same transaction,
--     so only clubs created AFTER this migration start on "the owner by DM".
--     The other seven columns are NULLABLE and stay NULL for every club.
--   * One column on "UnsolicitedGroup": "awaitingAdminLink" BOOLEAN NOT NULL
--     DEFAULT false. Every existing row reads false.
--   * Two UNIQUE indexes (one admin group per club and one club per group;
--     link codes unique across clubs). Both columns are NULL everywhere, and
--     Postgres allows many NULLs in a unique index.
--   * Two CHECK constraints (the same DDL as prisma/sql/admin-channel-check.sql).
--     Every existing row satisfies both once the default has filled.
--
-- It does NOT drop, rename or rewrite anything, and changes no query that
-- does not name the new columns.
--
-- Verify after applying (expect every existing club 'each-admin', and the
-- second query to return 0):
--   SELECT id, name, "adminChannelMode" FROM "Organisation" ORDER BY "createdAt";
--   SELECT count(*) FROM "Organisation" WHERE "adminChannelMode" <> 'each-admin';
--   SELECT column_default FROM information_schema.columns
--    WHERE table_name = 'Organisation' AND column_name = 'adminChannelMode';   -- 'one-person'::text
--
-- Rolling back:
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_adminGroup_not_community";
--   ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_adminChannelMode_check";
--   DROP INDEX IF EXISTS "Organisation_adminGroupLinkCode_key";
--   DROP INDEX IF EXISTS "Organisation_adminGroupId_key";
--   ALTER TABLE "UnsolicitedGroup" DROP COLUMN "awaitingAdminLink";
--   ALTER TABLE "Organisation" DROP COLUMN "adminChannelMode", DROP COLUMN "adminChannelUserId",
--     DROP COLUMN "adminGroupId", DROP COLUMN "adminGroupSubject", DROP COLUMN "adminGroupLinkedAt",
--     DROP COLUMN "adminGroupLinkedByUserId", DROP COLUMN "adminGroupLinkCode",
--     DROP COLUMN "adminGroupLinkCodeExpiresAt";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. Apply THIS file (psql -f; it carries its own BEGIN/COMMIT), not
-- `db push`: db push would add "adminChannelMode" with the schema's default
-- 'one-person' and move every existing club, Sutton FC included, off
-- today's behaviour. It also never creates the CHECK constraints.

BEGIN;

ALTER TABLE "Organisation"
  ADD COLUMN "adminChannelMode" TEXT NOT NULL DEFAULT 'each-admin',
  ADD COLUMN "adminChannelUserId" TEXT,
  ADD COLUMN "adminGroupId" TEXT,
  ADD COLUMN "adminGroupSubject" TEXT,
  ADD COLUMN "adminGroupLinkedAt" TIMESTAMP(3),
  ADD COLUMN "adminGroupLinkedByUserId" TEXT,
  ADD COLUMN "adminGroupLinkCode" TEXT,
  ADD COLUMN "adminGroupLinkCodeExpiresAt" TIMESTAMP(3);

-- Every row that existed a moment ago now reads 'each-admin'. From here on
-- a new club starts on the owner.
ALTER TABLE "Organisation" ALTER COLUMN "adminChannelMode" SET DEFAULT 'one-person';

CREATE UNIQUE INDEX "Organisation_adminGroupId_key" ON "Organisation"("adminGroupId");
CREATE UNIQUE INDEX "Organisation_adminGroupLinkCode_key" ON "Organisation"("adminGroupLinkCode");

ALTER TABLE "UnsolicitedGroup" ADD COLUMN "awaitingAdminLink" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_adminChannelMode_check"
  CHECK ("adminChannelMode" IN ('one-person', 'admin-group', 'each-admin'));
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_adminGroup_not_community"
  CHECK ("adminGroupId" IS NULL OR "whatsappGroupId" IS NULL OR "adminGroupId" <> "whatsappGroupId");

COMMIT;
