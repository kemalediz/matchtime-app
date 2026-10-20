-- Quoted-reply context, slice S0 (2026-10-20). Which MatchTime message a
-- player's WhatsApp swipe-reply quotes. See src/lib/reply-context.ts.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the Prisma client selects every
-- SentNotification column on queries without a `select`, and the
-- dispatch claim (/api/whatsapp/due-posts) now writes "text", so code that
-- knows the columns fails against a database that does not have them yet.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261020120000_sent_notification_reply_context/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Additive, plus a one-off fill of the new id column.
--   1. Two nullable columns on "SentNotification": "waStanzaId" (the bare
--      stanza id inside "waMessageId", the form a reply quotes) and "text"
--      (the words handed to the Pi at claim time). No default, so no
--      table rewrite.
--   2. An index on "waStanzaId" (Prisma's name for @@index([waStanzaId])).
--   3. Backfill: "waStanzaId" for every row that already has a
--      "waMessageId", using the same rule as `bareWhatsAppId`
--      (src/lib/quoted-message.ts): the stanza id of a serialised key
--      "true_<chat>_<stanza>[_<participant>]", else the id itself, trimmed.
--      Prod on 2026-10-20 (read-only count): 2,845 rows, 1,431 with a
--      "waMessageId", all 1,431 serialised; table 1.4 MB. "text" is NOT
--      backfilled: the words of past scheduler DMs were never stored, and
--      the resolver falls back to the Pi's quoted text for those rows.
--
-- It drops, renames and rewrites nothing else, and touches no other table.
--
-- IDEMPOTENT: ADD COLUMN / CREATE INDEX IF NOT EXISTS are no-ops on a
-- second run, and the backfill only fills rows whose "waStanzaId" is still
-- NULL. ONE transaction: it applies whole or not at all. lock_timeout makes
-- a busy table fail fast instead of queueing every query behind the ALTER;
-- if it fails on the lock nothing was changed and it can simply be run
-- again. There is no session-level SET in this file.
--
-- Verify after applying (expect two rows; then 0; then 0):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'SentNotification' AND column_name IN ('waStanzaId', 'text');
--   SELECT count(*) FROM "SentNotification" WHERE "waMessageId" IS NOT NULL AND "waStanzaId" IS NULL;
--   SELECT count(*) FROM "SentNotification"
--    WHERE "waMessageId" ~ '^(true|false)_[^_]+_[^_]+(_.+)?$' AND "waMessageId" NOT LIKE '%\_' || "waStanzaId" || '%';
--
-- Rolling back (after the code that writes them is no longer deployed):
--   DROP INDEX IF EXISTS "SentNotification_waStanzaId_idx";
--   ALTER TABLE "SentNotification" DROP COLUMN IF EXISTS "text";
--   ALTER TABLE "SentNotification" DROP COLUMN IF EXISTS "waStanzaId";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. `db push` would add the same
-- columns and index but never the backfill.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "SentNotification" ADD COLUMN IF NOT EXISTS "waStanzaId" TEXT;
ALTER TABLE "SentNotification" ADD COLUMN IF NOT EXISTS "text" TEXT;

CREATE INDEX IF NOT EXISTS "SentNotification_waStanzaId_idx" ON "SentNotification" ("waStanzaId");

-- BACKFILL:BEGIN (e2e/helpers/reply-context-lib-tests.ts runs this statement
-- against the test database and checks it agrees with `bareWhatsAppId`)
UPDATE "SentNotification"
   SET "waStanzaId" = CASE
         WHEN btrim("waMessageId") ~ '^(true|false)_[^_]+_[^_]+(_.+)?$'
           THEN substring(btrim("waMessageId") from '^(?:true|false)_[^_]+_([^_]+)')
         ELSE btrim("waMessageId")
       END
 WHERE "waStanzaId" IS NULL
   AND "waMessageId" IS NOT NULL
   AND btrim("waMessageId") <> '';
-- BACKFILL:END

COMMIT;
