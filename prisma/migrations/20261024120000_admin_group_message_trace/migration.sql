-- What MatchTime decided about each organisers' group (HQ) message
-- (2026-10-24, FNF HQ "Glazers OUT": the router's verdict and the
-- extractor's facts were stored nowhere, so a silent message could not be
-- explained from the database).
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand BEFORE
-- the code deploys (the code reads and writes the columns):
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261024120000_admin_group_message_trace/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Adds two NULLABLE columns with no default to "AdminGroupMessage":
-- "pipelineTrace" (JSONB, the shape of "AnalyzedMessage"."pipelineTrace")
-- and "hqOutcome" (TEXT). Metadata only (no table rewrite). Existing rows
-- read as NULL.
--
-- Verify after applying (expect 2):
--   SELECT count(*) FROM information_schema.columns
--   WHERE table_name = 'AdminGroupMessage' AND column_name IN ('pipelineTrace', 'hqOutcome');
--
-- Rolling back:
--   ALTER TABLE "AdminGroupMessage" DROP COLUMN "pipelineTrace", DROP COLUMN "hqOutcome";
--
-- IDEMPOTENT. One transaction; lock_timeout makes a busy table fail fast.

BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "AdminGroupMessage" ADD COLUMN IF NOT EXISTS "pipelineTrace" JSONB;
ALTER TABLE "AdminGroupMessage" ADD COLUMN IF NOT EXISTS "hqOutcome" TEXT;
COMMIT;
