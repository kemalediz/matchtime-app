-- Self-join slice 5, the connect DM (2026-09-29).
-- Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 5.3 and 7 (cap 6).
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive, and safe to run twice (every statement is IF NOT EXISTS).
--   * One NULLABLE column on "ClubConnect", "siteCapAt": the organiser's
--     connect DM arrived while the site's daily cap on new groups was full.
--   * Two indexes on "ClubConnect": "dmLid" (slice 6 resolves a LID-only
--     group adder through it) and "dmAt" (cap 6 counts today's connect DMs).
--
-- It does NOT drop, rename or rewrite anything. "ClubConnect" is empty in
-- production while SELF_JOIN_ENABLED is off.
--
-- ORDER: apply this BEFORE the server that reads it goes live. The status
-- card selects "siteCapAt" for every draft club's admin page.
--
-- Verify after applying (expect the column listed):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'ClubConnect' AND column_name = 'siteCapAt';
--
-- Rolling back:
--   DROP INDEX IF EXISTS "ClubConnect_dmAt_idx";
--   DROP INDEX IF EXISTS "ClubConnect_dmLid_idx";
--   ALTER TABLE "ClubConnect" DROP COLUMN IF EXISTS "siteCapAt";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this file
-- is the canonical, reviewable DDL.

ALTER TABLE "ClubConnect" ADD COLUMN IF NOT EXISTS "siteCapAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "ClubConnect_dmLid_idx" ON "ClubConnect"("dmLid");
CREATE INDEX IF NOT EXISTS "ClubConnect_dmAt_idx" ON "ClubConnect"("dmAt");
