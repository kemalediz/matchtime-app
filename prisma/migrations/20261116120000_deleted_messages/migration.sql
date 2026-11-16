-- Messages deleted for everyone in WhatsApp (2026-11-15, PR #606: "a
-- deleted WhatsApp message leaves MatchTime's stored chat"). One row per
-- deleted message, the TOMBSTONE: the group it was in, its bare WhatsApp id,
-- and who sent the delete (a group admin, or the phones and JIDs of the
-- sender). Every writer of a member's words checks it after writing and
-- takes the words out again if it applies, and every edit checks it first,
-- so a delete wins in whatever order the message, the delete and an edit
-- arrive (src/lib/message-change.ts).
--
--   npx tsx scripts/apply-deleted-message-migration.ts            # DRY RUN
--   npx tsx scripts/apply-deleted-message-migration.ts --apply    # do it
-- or
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261116120000_deleted_messages/migration.sql
--
-- RETENTION: 14 DAYS from "deletedAt", pruned on every write
-- (DELETED_MESSAGE_RETENTION_DAYS in src/lib/message-change.ts). Ids and
-- phones only, never a word of the message.
--
-- ORDER: APPLY THIS BEFORE DEPLOYING THE SERVER. Deployed without it,
-- /api/whatsapp/message-change answers 500 (the Pi keeps the change in its
-- durable queue and retries with backoff, so no delete is lost), and the
-- writers' checks read "no tombstone" and change nothing.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One NEW table "DeletedMessage" (no foreign key), one
-- unique index and one index. No existing table, column or row changes.
--
-- IDEMPOTENT: IF NOT EXISTS everywhere. ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect "DeletedMessage"):
--   SELECT to_regclass('"DeletedMessage"');
--
-- Rolling back (the server then answers the Pi's deletes with 500 and the
-- Pi retries them until the table is back):
--   DROP TABLE IF EXISTS "DeletedMessage";

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "DeletedMessage" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "waMessageId" TEXT NOT NULL,
    "byAdmin" BOOLEAN NOT NULL DEFAULT false,
    "senderJids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "senderPhones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeletedMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DeletedMessage_chatId_waMessageId_key" ON "DeletedMessage"("chatId", "waMessageId");
CREATE INDEX IF NOT EXISTS "DeletedMessage_deletedAt_idx" ON "DeletedMessage"("deletedAt");

COMMIT;
