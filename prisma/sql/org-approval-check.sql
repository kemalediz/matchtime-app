-- The club-approval invariants on "Organisation" (2026-09-29).
--
-- 1. "Organisation_approvalStatus_check": the column holds one of the five
--    states and nothing else, so a typo can never be a sixth state that
--    some reader treats as approved and another as not.
-- 2. "Organisation_bot_requires_approval": the bot can be switched ON only
--    for an approved club. Every route that acts for a group (analyze,
--    due-posts, group-join, group-leave, sync-participants) already
--    requires "whatsappBotEnabled", so this one constraint keeps all of
--    them blind to a club that is waiting for approval, was rejected, or
--    was suspended. See src/lib/club-approval.ts.
--
-- IDEMPOTENT: safe to run repeatedly. Applied to production by
-- prisma/migrations/20260929180000_club_approval/migration.sql and to the
-- e2e database by e2e/run.ts after `prisma db push` (db push creates
-- tables and columns, never CHECK constraints).
--
-- Every existing row satisfies both: the "approvalStatus" column is added
-- with DEFAULT 'approved', so every pre-existing club reads 'approved'.

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_approvalStatus_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_approvalStatus_check"
  CHECK ("approvalStatus" IN ('draft', 'pending', 'approved', 'rejected', 'suspended'));

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_bot_requires_approval";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_bot_requires_approval"
  CHECK (NOT "whatsappBotEnabled" OR "approvalStatus" = 'approved');
