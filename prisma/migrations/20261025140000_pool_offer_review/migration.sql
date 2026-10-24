-- The local player pool, slice L5a: two CHECKs from the review of PR #400
-- (2026-10-24). Plan: MDs/local-player-pool-plan-2026-10-23.md; decisions
-- L5a.20 and L5a.21 in MDs/local-player-pool-decisions-log.md.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, AFTER
-- 20261025090000_pool_signup_confirm and BEFORE the code is deployed (the
-- offer page writes the new attempt kind):
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261025140000_pool_offer_review/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. No column, no row is written or changed.
--   * "PoolAttempt_result_check" is replaced by one that also allows the
--     offer page's wrong "last 4 digits" (kind 'offer-verify', result
--     'wrong'). Every existing row passes (it only allows more).
--   * New "Membership_guest_player_check": a guest membership (its match
--     set) is a PLAYER. Added NOT VALID: it binds every row written or
--     updated from now on and checks NO existing row, so adding it cannot
--     fail. To also check the existing rows, first run
--       SELECT id, role FROM "Membership" WHERE "guestMatchId" IS NOT NULL AND role <> 'PLAYER';
--     and, with none (or after fixing them), VALIDATE CONSTRAINT it.
-- The definitions live in prisma/sql/pool-check.sql and
-- prisma/sql/partner-ask-check.sql; this file repeats them.

BEGIN;

ALTER TABLE "PoolAttempt" DROP CONSTRAINT IF EXISTS "PoolAttempt_result_check";
ALTER TABLE "PoolAttempt" ADD CONSTRAINT "PoolAttempt_result_check"
  CHECK (("kind" = 'confirm' AND "result" IN ('wrong', 'expired', 'has-profile')) OR ("kind" = 'signup' AND "result" IN ('created', 'area-not-found', 'venues-unknown')) OR ("kind" = 'offer-verify' AND "result" IN ('wrong')));

ALTER TABLE "Membership" DROP CONSTRAINT IF EXISTS "Membership_guest_player_check";
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_guest_player_check"
  CHECK ("guestMatchId" IS NULL OR "role" = 'PLAYER') NOT VALID;

COMMIT;
