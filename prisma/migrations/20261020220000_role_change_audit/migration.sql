-- Role change audit (2026-10-20, FNF). See src/lib/role-change.ts and
-- src/lib/role-change-rules.ts.
--
-- NOT APPLIED BY THE PULL REQUEST THAT ADDED IT. Apply it by hand, and
-- APPLY IT BEFORE THE CODE IS DEPLOYED: every role-changing path now
-- writes a "RoleChange" row in the same transaction as the change, so code
-- that knows the table fails against a database without it.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261020220000_role_change_audit/migration.sql
--
-- WHAT APPLYING THIS DOES TO A LIVE DATABASE
-- ------------------------------------------
-- Strictly additive. One new, empty table "RoleChange" with one plain
-- index. It uses the existing "MemberRole" enum and touches no existing
-- table or row. No foreign keys, like "UserMerge": the record outlives a
-- merged-away user.
--
-- IDEMPOTENT: CREATE TABLE and CREATE INDEX are IF NOT EXISTS, a no-op on
-- a second run. ONE transaction. lock_timeout makes it fail fast; if it
-- fails nothing was changed and it can simply be run again. There is no
-- session-level SET in this file.
--
-- Verify after applying (expect 8 rows, then 0):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'RoleChange';
--   SELECT count(*) FROM "RoleChange";
--
-- Rolling back (after the code that writes it is no longer deployed):
--   DROP TABLE IF EXISTS "RoleChange";
--
-- NOTE ON APPLYING: this repo manages schema with `prisma db push`; this
-- file is the canonical, reviewable DDL. Apply this file on production.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "RoleChange" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "fromRole" "MemberRole" NOT NULL,
  "toRole" "MemberRole" NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoleChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RoleChange_orgId_userId_idx" ON "RoleChange"("orgId", "userId");

COMMIT;
