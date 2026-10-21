-- Partner asks from the players' group (cross-club ask, slice S6,
-- 2026-10-21). See src/lib/partner-ask-words.ts.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: an organiser's tagged ask in the
-- players' group writes a "PartnerAsk" row with "requestedVia" = 'group',
-- which the old CHECK refuses (the ask would fail and the organiser would
-- hear "I can't ask ... right now").
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261021160000_partner_ask_via_group/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Widens one CHECK constraint by one value. No row changes, no table
-- rewrite (a CHECK that only widens is validated against the existing
-- rows, all of which already pass). IDEMPOTENT: DROP IF EXISTS then ADD,
-- in ONE transaction, so there is no moment without the constraint.
-- prisma/sql/partner-ask-check.sql carries the same constraint.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "PartnerAsk" DROP CONSTRAINT IF EXISTS "PartnerAsk_requestedVia_check";
ALTER TABLE "PartnerAsk" ADD CONSTRAINT "PartnerAsk_requestedVia_check"
  CHECK ("requestedVia" IN ('button', 'hq', 'dm', 'group', 'auto', 'link'));
COMMIT;
