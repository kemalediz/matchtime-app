-- The admin-channel invariants on "Organisation" (slice 2a, 2026-09-30).
-- Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.2 and 2.14.
--
-- 1. "Organisation_adminChannelMode_check": the mode is one of the three
--    choices and nothing else, so a typo can never be a fourth mode that one
--    reader treats as "each admin" and another as "the owner".
-- 2. "Organisation_adminGroup_not_community": a club's admin group is never
--    its own community group. Across clubs the link transaction enforces the
--    same rule (src/lib/admin-group-link.ts), and "adminGroupId" is UNIQUE,
--    so one group can never be two clubs' admin group either.
--
-- IDEMPOTENT: safe to run repeatedly. Applied to production by
-- prisma/migrations/20260930200000_admin_channel/migration.sql and to the
-- e2e database by e2e/run.ts after `prisma db push` (db push creates
-- columns, never CHECK constraints).

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_adminChannelMode_check";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_adminChannelMode_check"
  CHECK ("adminChannelMode" IN ('one-person', 'admin-group', 'each-admin'));

ALTER TABLE "Organisation" DROP CONSTRAINT IF EXISTS "Organisation_adminGroup_not_community";
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_adminGroup_not_community"
  CHECK ("adminGroupId" IS NULL OR "whatsappGroupId" IS NULL OR "adminGroupId" <> "whatsappGroupId");
