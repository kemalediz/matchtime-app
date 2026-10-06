-- Monthly squad, slice 6 (2026-10-06): the words an organiser gives when
-- adding or removing a credit by hand.
-- Plan: MDs/monthly-squad-plan-2026-10-05.md, section 9.2 ("Credits tab").
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   * "SquadCredit"."note"     TEXT NULL: the reason an organiser typed
--     when adding a credit by hand.
--   * "SquadCredit"."voidNote" TEXT NULL: the reason an organiser typed
--     when removing one, or "refunded" when the collector recorded a refund.
--   * Two CHECK constraints: each is NULL or 1 to 200 characters (the same
--     DDL as prisma/sql/monthly-squad-check.sql).
-- Both are NULL on every existing row, so the constraints cannot fail.
-- Nothing reads either column unless the club is on "monthly", and only an
-- OWNER or ADMIN (or the money collector, for a refund) writes them.
--
-- It does NOT drop, rename or rewrite anything, and posts nothing.
--
-- Verify after applying (expect 0):
--   SELECT count(*) FROM "SquadCredit" WHERE "note" IS NOT NULL OR "voidNote" IS NOT NULL;
--
-- Rolling back:
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   ALTER TABLE "SquadCredit" DROP CONSTRAINT IF EXISTS "SquadCredit_note_check";
--   ALTER TABLE "SquadCredit" DROP CONSTRAINT IF EXISTS "SquadCredit_voidNote_check";
--   ALTER TABLE "SquadCredit" DROP COLUMN IF EXISTS "note";
--   ALTER TABLE "SquadCredit" DROP COLUMN IF EXISTS "voidNote";
--   COMMIT;
--
-- NOT APPLIED BY THIS PR. This repo syncs schema with `prisma db push`, but
-- production gets THIS file (psql -f; it carries its own BEGIN/COMMIT).
-- lock_timeout makes a busy table fail the migration instead of queueing
-- behind it and blocking the bot's writes.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "SquadCredit" ADD COLUMN IF NOT EXISTS "note" TEXT;
ALTER TABLE "SquadCredit" ADD COLUMN IF NOT EXISTS "voidNote" TEXT;

ALTER TABLE "SquadCredit" DROP CONSTRAINT IF EXISTS "SquadCredit_note_check";
ALTER TABLE "SquadCredit" ADD CONSTRAINT "SquadCredit_note_check"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 200);

ALTER TABLE "SquadCredit" DROP CONSTRAINT IF EXISTS "SquadCredit_voidNote_check";
ALTER TABLE "SquadCredit" ADD CONSTRAINT "SquadCredit_voidNote_check"
  CHECK ("voidNote" IS NULL OR char_length("voidNote") BETWEEN 1 AND 200);

COMMIT;
