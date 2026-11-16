-- WhatsApp messages deleted for everyone, or edited by their author
-- (2026-11-15, PR #606: "edit or delete a message, and MatchTime forgets the
-- original words"). One row per message, the TOMBSTONE: the group it was
-- in, its bare WhatsApp id, why ("deleted" or "edited") and who sent it (a
-- group admin, or the sender's phones and JIDs). Every writer of a member's
-- words clears again after writing, and the hourly /api/cron/bot-health
-- sweep enforces every recent row, so it wins in whatever order the
-- message, its delete and its edits arrive (src/lib/message-change.ts).
--
-- Also one index on "GroupMessage" ("waChatId", "createdAt"): the purge and
-- the sweep find a message's archived copy by its group, not by a scan.
--
--   npx tsx scripts/apply-deleted-message-migration.ts            # DRY RUN
--   npx tsx scripts/apply-deleted-message-migration.ts --apply    # do it
-- or
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261116120000_deleted_messages/migration.sql
--
-- "changes" holds EACH change on its own ({reason, byAdmin, senderJids,
-- senderPhones, at}), appended atomically (the same change once, at most
-- 20): who may do what is judged per change, so a forged delete never
-- borrows the author's real edit. "deletedAt" is the first change,
-- "lastChangeAt" the latest.
--
-- RETENTION: 14 DAYS from "lastChangeAt", pruned by the sweep
-- (DELETED_MESSAGE_RETENTION_DAYS in src/lib/message-change.ts). Ids and
-- phones only, never a word of the message. "enforcedAt" is when every copy
-- was last cleared; the sweep takes the rows never cleared yet, plus a short
-- re-check window (six hours after each row's latest change) for late
-- writers. Recorded only for a group linked to a club.
--
-- ORDER: APPLY THIS BEFORE DEPLOYING THE SERVER. Deployed without it,
-- /api/whatsapp/message-change answers 500 (the Pi keeps the change in its
-- durable outbox and retries with backoff, so nothing is lost), the doors
-- read "no tombstone" and change nothing, and the sweep logs and does
-- nothing.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Additive. One NEW table "DeletedMessage" (no foreign key), its unique
-- index and two indexes; one NEW index on the existing "GroupMessage" (a
-- plain CREATE INDEX: it holds a write lock on "GroupMessage" while it
-- builds, which on the archive's size is well under a second). No column
-- or row changes.
--
-- IDEMPOTENT: IF NOT EXISTS everywhere. ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect both names):
--   SELECT to_regclass('"DeletedMessage"'), to_regclass('"GroupMessage_waChatId_createdAt_idx"');
--
-- Rolling back (the server then answers the Pi's changes with 500 and the
-- Pi retries them until the table is back):
--   DROP TABLE IF EXISTS "DeletedMessage";
--   DROP INDEX IF EXISTS "GroupMessage_waChatId_createdAt_idx";

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "DeletedMessage" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "waMessageId" TEXT NOT NULL,
    "byAdmin" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL DEFAULT 'deleted',
    "senderJids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "senderPhones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "changes" JSONB NOT NULL DEFAULT '[]',
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastChangeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enforcedAt" TIMESTAMP(3),

    CONSTRAINT "DeletedMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DeletedMessage_chatId_waMessageId_key" ON "DeletedMessage"("chatId", "waMessageId");
CREATE INDEX IF NOT EXISTS "DeletedMessage_lastChangeAt_idx" ON "DeletedMessage"("lastChangeAt");
CREATE INDEX IF NOT EXISTS "DeletedMessage_enforcedAt_lastChangeAt_idx" ON "DeletedMessage"("enforcedAt", "lastChangeAt");
CREATE INDEX IF NOT EXISTS "GroupMessage_waChatId_createdAt_idx" ON "GroupMessage"("waChatId", "createdAt");

COMMIT;
