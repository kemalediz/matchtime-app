-- A pasted HQ squad list takes out exactly who its preview named
-- (2026-10-29, FNF HQ: a teams sheet pasted back dropped 9 players).
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261029230000_admin_squad_proposal_remove_ids/migration.sql
--
-- Additive. A list stored before this column has none, so its YES takes
-- nobody out (the safe direction).
ALTER TABLE "AdminSquadProposal" ADD COLUMN IF NOT EXISTS "removeUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
