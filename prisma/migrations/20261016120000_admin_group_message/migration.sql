-- What was said in a club's linked admin group (HQ), kept for one day
-- (2026-10-16). Read by src/lib/admin-group-understand.ts for the safe-YES
-- rule and as the shared router's context. See the model's comment in
-- prisma/schema.prisma.
--
-- HOW TO APPLY (before the code that reads it is deployed):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261016120000_admin_group_message/migration.sql
--
-- IDEMPOTENT: every statement is IF NOT EXISTS. ONE transaction.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE: one new, empty table and two
-- indexes on it. No foreign keys, no change to any existing table. CREATE
-- TABLE and CREATE INDEX on a new, empty table lock only that table.
-- `lock_timeout` is 5 seconds for this transaction only (SET LOCAL).
--
-- Verify after applying (expect 1, then 0):
--   SELECT count(*) FROM information_schema.tables WHERE table_name = 'AdminGroupMessage';
--   SELECT count(*) FROM "AdminGroupMessage";
--
-- Rolling back (only once no deployed code reads the table):
--   DROP TABLE IF EXISTS "AdminGroupMessage";

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "AdminGroupMessage" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "waMessageId" TEXT NOT NULL,
  "fromMatchTime" BOOLEAN NOT NULL DEFAULT false,
  "senderUserId" TEXT,
  "text" TEXT NOT NULL,
  "askRef" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminGroupMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AdminGroupMessage_waMessageId_key" ON "AdminGroupMessage"("waMessageId");
CREATE INDEX IF NOT EXISTS "AdminGroupMessage_orgId_createdAt_idx" ON "AdminGroupMessage"("orgId", "createdAt");

COMMIT;
