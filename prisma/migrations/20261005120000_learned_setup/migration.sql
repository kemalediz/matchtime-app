-- F3, learned setup (2026-10-05). See src/lib/setup-learning/.
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive.
--   * "ClubConnect"."capturedHistory" JSONB NULL: the chat history WhatsApp
--     shared when MatchTime was added to a self-join club's group. NULL on
--     every existing row. Kept only until the learned setup has read it.
--   * "Organisation"."settingsSetByOrganiser" TEXT[] NOT NULL DEFAULT '{}':
--     the settings an organiser saved on /admin/settings. A constant default,
--     so no table rewrite on PG 11+; every existing club (Sutton FC
--     included) reads an empty list, and nothing reads it but the learned
--     setup, which only ever runs for a newly approved self-join club.
--   * One new table, "ClubSetupLearning", with a unique index on "orgId",
--     an index on "status" and a foreign key to "Organisation"
--     (ON DELETE CASCADE). Empty until the learned setup runs, which is
--     behind SETUP_LEARNING_ENABLED (off unless explicitly on).
--
-- It does NOT drop, rename or rewrite anything.
--
-- Verify after applying (expect 0, 0, 0):
--   SELECT count(*) FROM "ClubConnect" WHERE "capturedHistory" IS NOT NULL;
--   SELECT count(*) FROM "Organisation" WHERE cardinality("settingsSetByOrganiser") > 0;
--   SELECT count(*) FROM "ClubSetupLearning";
--
-- Rolling back:
--   DROP TABLE "ClubSetupLearning";
--   ALTER TABLE "Organisation" DROP COLUMN "settingsSetByOrganiser";
--   ALTER TABLE "ClubConnect" DROP COLUMN "capturedHistory";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. Apply THIS file (psql -f; it
-- carries its own BEGIN/COMMIT). lock_timeout makes a busy table fail the
-- migration fast instead of queueing every query behind the ALTER.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "ClubConnect" ADD COLUMN "capturedHistory" JSONB;

ALTER TABLE "Organisation"
  ADD COLUMN "settingsSetByOrganiser" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "ClubSetupLearning" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "authorCount" INTEGER NOT NULL DEFAULT 0,
    "detected" JSONB,
    "applied" JSONB,
    "suggestions" JSONB,
    "noted" JSONB,
    "kept" JSONB,
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "dmQueuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubSetupLearning_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClubSetupLearning_orgId_key" ON "ClubSetupLearning"("orgId");
CREATE INDEX "ClubSetupLearning_status_idx" ON "ClubSetupLearning"("status");

ALTER TABLE "ClubSetupLearning" ADD CONSTRAINT "ClubSetupLearning_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClubSetupLearning" ADD CONSTRAINT "ClubSetupLearning_status_check"
  CHECK ("status" IN ('running', 'deferred', 'applied', 'nothing', 'skipped', 'failed'));

COMMIT;
