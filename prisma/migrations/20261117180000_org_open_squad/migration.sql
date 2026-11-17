-- Open squad (2026-11-17, the Vets: "the main squad will always expand or
-- shrink without any limits and a bench"). One club setting, default off,
-- so every existing club reads false and nothing changes for it.
-- Rules: src/lib/open-squad.ts.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261117180000_org_open_squad/migration.sql
--
-- RUN BEFORE THE DEPLOY: Prisma selects every column of "Organisation", so
-- code that knows the column must not reach a database without it.
-- Additive and idempotent.

ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "openSquad" BOOLEAN NOT NULL DEFAULT false;
