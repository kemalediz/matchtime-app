-- The "approved but setting up" invariants on "Organisation" (2026-10-12,
-- go-live plan slice S1). The same pattern as org-approval-check.sql.
--
-- 1. "Organisation_setupStage_check": the column holds one of the two
--    stages and nothing else, so a typo can never be a third stage that
--    one reader treats as live and another as held.
-- 2. "Organisation_bot_off_while_setting_up": the bot can never be ON for
--    a club that is still setting up. Every route that acts for a group
--    (analyze, due-posts, group-join, group-leave, sync-participants, the
--    scheduler) already requires "whatsappBotEnabled", so this one
--    constraint keeps all of them blind to a club whose organiser has not
--    said GO yet. See src/lib/club-setup.ts.
--
-- IDEMPOTENT: safe to run repeatedly. Applied to production by
-- prisma/migrations/20261012120000_setup_hold/migration.sql (which also
-- adds the columns) and to the e2e database by e2e/run.ts after
-- `prisma db push` (db push creates tables and columns, never CHECK
-- constraints).
--
-- Every existing row satisfies both: the "setupStage" column is added with
-- DEFAULT 'live', so every pre-existing club reads 'live'.

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_setupStage_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_setupStage_check"
  CHECK ("setupStage" IN ('live', 'setting-up'));

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_bot_off_while_setting_up";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_bot_off_while_setting_up"
  CHECK (NOT ("setupStage" = 'setting-up' AND "whatsappBotEnabled"));
