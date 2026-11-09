-- The people a group message tagged (2026-11-09, Vets MNF: "@Match Time DM
-- these people"). MatchTime keeps, for each message it is shown in a
-- players' group or HQ that @-mentions anyone but MatchTime, WHO was tagged
-- (WhatsApp's own mention data, as the Pi forwards it), so a later "DM the
-- people above", or a reply quoting that message, finds them without
-- reading names out of the words. See src/lib/named-invite-rules.ts.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261109120000_message_mentions/migration.sql
--
-- ORDER DOES NOT MATTER. The code writes and reads this table best-effort
-- (src/lib/group-mentions.ts catches every failure): deployed before this
-- is applied, "DM these people" finds nobody tagged in an earlier message
-- and says so, and nothing else changes. Apply it before or right after
-- the deploy; only messages sent after it is applied can be found.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One NEW table "MessageMentions" (foreign key to
-- "Organisation", ON DELETE CASCADE), two indexes and one unique index. No
-- existing table, column or row changes.
--
-- IDEMPOTENT: IF NOT EXISTS everywhere, the constraint dropped and re-added.
-- ONE transaction; SET LOCAL only.
--
-- Verify after applying (expect "MessageMentions"):
--   SELECT to_regclass('"MessageMentions"');
--
-- Rolling back:
--   DROP TABLE IF EXISTS "MessageMentions";

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "MessageMentions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "waMessageId" TEXT NOT NULL,
    "waStanzaId" TEXT,
    "senderUserId" TEXT,
    "mentions" JSONB NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageMentions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MessageMentions_waMessageId_key" ON "MessageMentions"("waMessageId");
CREATE INDEX IF NOT EXISTS "MessageMentions_orgId_chatId_sentAt_idx" ON "MessageMentions"("orgId", "chatId", "sentAt");
CREATE INDEX IF NOT EXISTS "MessageMentions_orgId_waStanzaId_idx" ON "MessageMentions"("orgId", "waStanzaId");

ALTER TABLE "MessageMentions" DROP CONSTRAINT IF EXISTS "MessageMentions_orgId_fkey";
ALTER TABLE "MessageMentions" ADD CONSTRAINT "MessageMentions_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
