-- "OpsAlert": routine ops alerts, recorded for the owner's /admin/health
-- page instead of being sent (2026-09-28).
--
-- The owner asked for the daily bot-health DMs and emails, and the
-- "routed to an action but nothing handled it" DMs, to stop and to live
-- on a dashboard instead. See src/lib/ops-alerts.ts.
--
-- ADDITIVE ONLY: one new table and two indexes. Nothing existing is
-- altered, rewritten, dropped or backfilled. No foreign key on "orgId"
-- on purpose, so monitoring rows can never block deleting a club.
--
-- Rollback: DROP TABLE IF EXISTS "OpsAlert";

CREATE TABLE IF NOT EXISTS "OpsAlert" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OpsAlert_orgId_kind_resolvedAt_idx" ON "OpsAlert"("orgId", "kind", "resolvedAt");

CREATE INDEX IF NOT EXISTS "OpsAlert_createdAt_idx" ON "OpsAlert"("createdAt");
