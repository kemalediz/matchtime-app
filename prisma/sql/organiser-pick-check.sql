-- The organiser-pick settings on "Organisation" (slice 2b, 2026-10-01).
-- Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.6 and 2.14.
--
-- Each is one of its choices and nothing else, so a typo can never be a
-- third value one reader treats as "organiser" and another as today's rule.
--
-- IDEMPOTENT: safe to run repeatedly. Applied to production by
-- prisma/migrations/20261001120000_organiser_picks/migration.sql and to the
-- e2e database by e2e/run.ts after `prisma db push` (db push creates
-- columns, never CHECK constraints).

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_benchPickMode_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_benchPickMode_check"
  CHECK ("benchPickMode" IN ('first-come', 'organiser'));

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_benchPickFallback_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_benchPickFallback_check"
  CHECK ("benchPickFallback" IN ('bench-offer', 'leave-empty'));
