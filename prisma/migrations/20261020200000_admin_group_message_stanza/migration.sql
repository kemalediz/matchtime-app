-- Quoted-reply context, slice S4 review (2026-10-20). The WhatsApp stanza id
-- of MatchTime's own lines in a club's admin-group (HQ) log, so an HQ reply
-- ("YES" quoting the proposed teams) is decided by the quoted message's id,
-- not by matching its first words. Stamped by /api/whatsapp/ack when the Pi
-- acknowledges the send (src/lib/hq-log-stanza.ts).
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, BEFORE
-- the code is deployed (the HQ log reader selects the column):
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261020200000_admin_group_message_stanza/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Additive only: one nullable text column on "AdminGroupMessage" and one
-- index on ("orgId", "waStanzaId"). No default, so no table rewrite; no
-- backfill (the table keeps one day of rows; older questions keep the text
-- fallback). The table is tiny (rows older than a day are deleted on every
-- write), so a plain CREATE INDEX takes milliseconds inside the transaction.
--
-- IDEMPOTENT: IF NOT EXISTS on both. ONE transaction. lock_timeout makes a
-- busy table fail fast; if it fails nothing was changed and it can be run
-- again. No session-level SET in this file.
--
-- Verify after applying (expect one row, then one index):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'AdminGroupMessage' AND column_name = 'waStanzaId';
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'AdminGroupMessage' AND indexname = 'AdminGroupMessage_orgId_waStanzaId_idx';

BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "AdminGroupMessage" ADD COLUMN IF NOT EXISTS "waStanzaId" TEXT;
CREATE INDEX IF NOT EXISTS "AdminGroupMessage_orgId_waStanzaId_idx" ON "AdminGroupMessage" ("orgId", "waStanzaId");
COMMIT;
