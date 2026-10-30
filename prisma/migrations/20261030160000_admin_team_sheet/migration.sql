-- Every team sheet MatchTime posts in a club's admin group, kept so an
-- organiser can bring an earlier one back (2026-10-30, FNF HQ: "These are
-- the final teams", replying to Tuesday's sheet two days later, when the
-- HQ log had long been pruned).
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261030160000_admin_team_sheet/migration.sql
--
-- Additive: one new, empty table and two indexes on it. Nothing else is
-- touched. Until it is applied, recording a sheet fails quietly (logged)
-- and "use these" says it cannot find those teams; nothing else changes.
CREATE TABLE IF NOT EXISTS "AdminTeamSheet" (
  "id"         TEXT NOT NULL,
  "orgId"      TEXT NOT NULL,
  "matchId"    TEXT NOT NULL,
  "slots"      JSONB NOT NULL,
  "text"       TEXT NOT NULL,
  "waStanzaId" TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminTeamSheet_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AdminTeamSheet_orgId_waStanzaId_idx" ON "AdminTeamSheet" ("orgId", "waStanzaId");
CREATE INDEX IF NOT EXISTS "AdminTeamSheet_matchId_createdAt_idx" ON "AdminTeamSheet" ("matchId", "createdAt");

-- Check:
--   SELECT count(*) FROM information_schema.tables WHERE table_name = 'AdminTeamSheet';
