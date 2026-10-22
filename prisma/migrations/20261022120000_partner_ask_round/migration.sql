-- Asking partner clubs for a chosen number of players (partner discovery
-- P4, 2026-10-22). Plan: MDs/partner-discovery-plan-2026-10-21.md,
-- sections 4 and 6. See src/lib/partner-ask.ts (`requestPartnerRound`).
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: the new code reads and writes
-- "PartnerAsk"."roundId", so without the column every ask, the sweep in
-- every due-posts poll and the match page's panel would fail.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261022120000_partner_ask_round/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Adds one NULLABLE column with no default (a catalogue change only: no
-- table rewrite, no row touched) and one index on it. "PartnerAsk" had 0
-- rows in production on 2026-10-21, so the index builds at once; a plain
-- CREATE INDEX (not CONCURRENTLY) keeps the whole file one transaction.
-- IDEMPOTENT: IF NOT EXISTS on both, safe to re-run. Existing rows keep
-- "roundId" NULL: each is a round of its own, exactly as it behaved before.
--
-- Touches ONLY "PartnerAsk". The partner discovery migration for
-- Organisation, ClubPartnership, ClubBlock and Venue is a separate file.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "PartnerAsk" ADD COLUMN IF NOT EXISTS "roundId" TEXT;
CREATE INDEX IF NOT EXISTS "PartnerAsk_roundId_idx" ON "PartnerAsk"("roundId");
COMMIT;
