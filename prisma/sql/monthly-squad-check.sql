-- Monthly squad (slice 2, 2026-10-05): the CHECK constraints.
-- Plan: MDs/monthly-squad-plan-2026-10-05.md, section 3.
--
-- Each setting is one of its choices and nothing else, so a typo can never
-- be a third value one reader treats as "monthly" and another as today's
-- weekly rule. A month always starts on the 1st, counts are never negative,
-- and the games played before a mid-month start never exceed the month's.
--
-- IDEMPOTENT: safe to run repeatedly. Applied to production by
-- prisma/migrations/20261005180000_monthly_squad/migration.sql and to the
-- e2e database by e2e/run.ts after `prisma db push` (db push creates
-- columns and tables, never CHECK constraints).

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_squadMode_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_squadMode_check"
  CHECK ("squadMode" IN ('weekly', 'monthly'));

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_monthCreditRule_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_monthCreditRule_check"
  CHECK ("monthCreditRule" IN ('any-miss', 'filled-only', 'none'));

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_paygPricePence_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_paygPricePence_check"
  CHECK ("paygPricePence" IS NULL OR ("paygPricePence" BETWEEN 1 AND 10000));

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_monthListOpensDaysBefore_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_monthListOpensDaysBefore_check"
  CHECK ("monthListOpensDaysBefore" BETWEEN 1 AND 28);

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_paymentInstructions_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_paymentInstructions_check"
  CHECK ("paymentInstructions" IS NULL OR char_length("paymentInstructions") BETWEEN 1 AND 500);

ALTER TABLE "SquadMonth" DROP CONSTRAINT IF EXISTS "SquadMonth_status_check";
ALTER TABLE "SquadMonth" ADD CONSTRAINT "SquadMonth_status_check"
  CHECK ("status" IN ('open', 'priced', 'running', 'closed'));

ALTER TABLE "SquadMonth" DROP CONSTRAINT IF EXISTS "SquadMonth_monthStart_check";
ALTER TABLE "SquadMonth" ADD CONSTRAINT "SquadMonth_monthStart_check"
  CHECK (EXTRACT(DAY FROM "monthStart") = 1);

ALTER TABLE "SquadMonth" DROP CONSTRAINT IF EXISTS "SquadMonth_games_check";
ALTER TABLE "SquadMonth" ADD CONSTRAINT "SquadMonth_games_check"
  CHECK ("gamesScheduled" >= 0 AND "gamesPlayedBeforeStart" BETWEEN 0 AND "gamesScheduled");

ALTER TABLE "SquadMonthMember" DROP CONSTRAINT IF EXISTS "SquadMonthMember_kind_check";
ALTER TABLE "SquadMonthMember" ADD CONSTRAINT "SquadMonthMember_kind_check"
  CHECK ("kind" IN ('regular', 'payg'));

ALTER TABLE "SquadMonthMember" DROP CONSTRAINT IF EXISTS "SquadMonthMember_tier_check";
ALTER TABLE "SquadMonthMember" ADD CONSTRAINT "SquadMonthMember_tier_check"
  CHECK ("tier" IN ('standard', 'concession'));

ALTER TABLE "SquadMonthMember" DROP CONSTRAINT IF EXISTS "SquadMonthMember_counts_check";
ALTER TABLE "SquadMonthMember" ADD CONSTRAINT "SquadMonthMember_counts_check"
  CHECK ("gamesCovered" >= 0 AND "creditsApplied" BETWEEN 0 AND "gamesCovered");

ALTER TABLE "SquadCredit" DROP CONSTRAINT IF EXISTS "SquadCredit_reason_check";
ALTER TABLE "SquadCredit" ADD CONSTRAINT "SquadCredit_reason_check"
  CHECK ("reason" IN ('missed', 'cancelled-week', 'left-mid-month', 'manual', 'carried-in'));

ALTER TABLE "SquadCredit" DROP CONSTRAINT IF EXISTS "SquadCredit_games_check";
ALTER TABLE "SquadCredit" ADD CONSTRAINT "SquadCredit_games_check"
  CHECK ("games" >= 1);

-- Slice 6 (2026-10-06): an organiser's words on a credit are short.
-- Applied to production by
-- prisma/migrations/20261006200000_squad_credit_notes/migration.sql.
ALTER TABLE "SquadCredit" DROP CONSTRAINT IF EXISTS "SquadCredit_note_check";
ALTER TABLE "SquadCredit" ADD CONSTRAINT "SquadCredit_note_check"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 200);

ALTER TABLE "SquadCredit" DROP CONSTRAINT IF EXISTS "SquadCredit_voidNote_check";
ALTER TABLE "SquadCredit" ADD CONSTRAINT "SquadCredit_voidNote_check"
  CHECK ("voidNote" IS NULL OR char_length("voidNote") BETWEEN 1 AND 200);

-- Slice 6, review round 1: at most ONE live credit per player per game,
-- whatever the reason. A partial index, which the Prisma schema cannot
-- express, so it lives here (db push may drop it; this file puts it back).
CREATE UNIQUE INDEX IF NOT EXISTS "SquadCredit_one_live_per_game"
  ON "SquadCredit" ("orgId", "userId", "earnedMatchId")
  WHERE "voidedAt" IS NULL AND "earnedMatchId" IS NOT NULL;
